// Observabilidad del render (Fase 0 "render de videos largos",
// 08-nov-2026, autorizado por Alex, criterio 1). Antes de este cambio,
// `runRender()` en server/index.mjs no leía NADA de stdout del proceso
// `remotion render` -- solo guardaba las últimas 4000 chars de stderr
// para el mensaje de error final. El job real que motivó esta tarea
// (1fd239de-..., falló por timeout de 180 min) no dejó NINGUNA línea
// de progreso en el log.
//
// Causa raíz verificada, no asumida: la documentación oficial de
// `remotion render` NO garantiza el formato de su salida en pantalla
// (confirmado 08-nov-2026 contra la documentación vigente). Antes de
// parsear nada, se corrió un diagnóstico REAL en GitHub Actions (mismo
// Chrome/FFmpeg que producción, @remotion/cli 4.0.538) comparando el
// nivel de log por defecto contra `--log=verbose`: las líneas
// "Rendered N/TOTAL, time remaining: Xs", "Encoded N/TOTAL" y
// "Bundling N%" aparecen EXACTAMENTE IGUAL en ambos niveles -- pero
// verbose generó 28x más bytes de salida (237KB vs 8KB para un render
// de 6s) sin ninguna línea adicional útil. Por eso no se agrega
// `--log=verbose`: el nivel por defecto ya tiene todo lo necesario, con
// mucho menos ruido en un render de 60 minutos real.
import { spawn } from "node:child_process";
import { killProcessGroup, countAliveProcessesInGroup, sumGroupCpuTicks } from "./process-tree.mjs";

// Duplicados a propósito de src/types.ts (mismo patrón que
// isRenderableByEngine/shouldBurnCaptions en cta-guarantee.mjs: el
// servidor corre con `node` plano y no puede importar ese `.ts`). Si
// uno cambia, el otro debe cambiar igual.
export const ENGINE_FPS = 30;
export const DESTINATION_DIMENSIONS = {
  "youtube-16-9": { width: 1920, height: 1080 },
  "vertical-9-16": { width: 1080, height: 1920 },
};

// --------------------------------------------------------------------
// Parsing puro -- sin tocar disco ni ejecutar nada, probado con líneas
// de texto simuladas (nivel 2 de honestidad de evidencia). La
// confirmación de que esto es lo que el binario real imprime de
// verdad vive en test-render-observability.mjs (CI, FFmpeg/Chrome
// reales).
// --------------------------------------------------------------------

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

/**
 * Interpreta UNA línea de stdout de `remotion render` como un evento
 * de progreso estructurado, o `null` si la línea no es una de las
 * reconocidas (hay muchas otras líneas informativas que se ignoran a
 * propósito, para no inundar el log -- ver `runRemotionRender`).
 */
export const parseRenderProgressLine = (rawLine) => {
  const line = rawLine.replace(ANSI_PATTERN, "").trim();
  if (!line) return null;

  let m = /^Bundling (\d+)%$/.exec(line);
  if (m) {
    return { stage: "bundling", percent: Number(m[1]) };
  }

  m = /^Rendered (\d+)\/(\d+)(?:, time remaining: (\d+)s)?$/.exec(line);
  if (m) {
    const renderedFrames = Number(m[1]);
    const totalFrames = Number(m[2]);
    return {
      stage: "rendering",
      renderedFrames,
      totalFrames,
      percent: totalFrames > 0 ? Math.round((renderedFrames / totalFrames) * 1000) / 10 : 0,
      etaSeconds: m[3] !== undefined ? Number(m[3]) : null,
    };
  }

  m = /^Encoded (\d+)\/(\d+)$/.exec(line);
  if (m) {
    const encodedFrames = Number(m[1]);
    const totalFrames = Number(m[2]);
    return {
      stage: "encoding",
      encodedFrames,
      totalFrames,
      percent: totalFrames > 0 ? Math.round((encodedFrames / totalFrames) * 1000) / 10 : 0,
    };
  }

  m = /^Stitching done in (\d+)ms$/.exec(line);
  if (m) {
    return { stage: "stitched", durationMs: Number(m[1]) };
  }

  return null;
};

/**
 * Criterio REDISEÑADO del vigilante (Fase 0, causa raíz con evidencia,
 * 09-nov-2026, autorizado por Alex, criterio 6 -- corrección del
 * auditor sobre f157a65/dca1c65): antes, "sin cuadros nuevos en
 * `stuckAfterMs`" bastaba por sí solo para cortar -- no distinguía un
 * render genuinamente colgado (coincide con el issue público de
 * Remotion #11864, "every process at 0% CPU") de uno que arrancó
 * lento pero SIGUE TRABAJANDO (bundling largo, navegador lanzando,
 * decodificación de keyframes dispersos) sin haber completado todavía
 * un cuadro.
 *
 * Pura -- recibe los números ya medidos, nunca toca el proceso ni el
 * reloj; así se prueba exhaustivamente con datos simulados (nivel 2)
 * sin necesitar un proceso real para cada combinación.
 *
 * `cpuTicksDelta`: ticks de CPU nuevos del grupo completo desde la
 * revisión anterior (ver `sumGroupCpuTicks`), o `null` si no se pudo
 * medir (sin /proc, o aún no hay una segunda lectura con la que
 * comparar). Decisión de diseño explícita: cuando no se puede medir,
 * se mantiene el comportamiento ANTERIOR (cortar) -- "mantén la
 * capacidad de cortar un cuelgue real" es un requisito duro; nunca se
 * deja correr indefinidamente solo porque la nueva señal no esté
 * disponible.
 */
export const shouldConsiderStuck = ({ msSinceLastProgress, stuckAfterMs, cpuTicksDelta }) => {
  if (msSinceLastProgress < stuckAfterMs) return false;
  if (cpuTicksDelta === null) return true; // no se puede distinguir -- se prioriza la capacidad de cortar
  return cpuTicksDelta <= 0; // sin NINGÚN tick de CPU nuevo = inactividad real, no solo "lento"
};

export class RenderTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "RenderTimeoutError";
  }
}

/**
 * Render trabado (Fase 0, render trabado, 08-nov-2026): el proceso
 * sigue vivo pero ningún cuadro nuevo se completa -- distinto de
 * `RenderTimeoutError` (que corta un render que SÍ avanza, solo que
 * tarda demasiado en total). Confirmado como un modo de falla real y
 * conocido de Remotion (no una hipótesis): un issue del propio
 * repositorio de Remotion describe exactamente esto -- "every process
 * at 0% CPU and never reaches its own delayRender timeout... sat for
 * 70 minutes until we killed it" -- y confirma que Remotion NO tiene
 * ninguna recuperación propia para un cuelgue así. Ver el informe de
 * esta tarea para la cita completa y el enlace.
 */
export class RenderStuckError extends Error {
  constructor(message) {
    super(message);
    this.name = "RenderStuckError";
  }
}

/**
 * Arma los argumentos de `npx remotion render` -- pura, sin ejecutar
 * nada (separada de `runRemotionRender` para poder probarla sola).
 *
 * `frames` y `logLevel` son SOLO para el render de diagnóstico
 * (criterio 3, 09-nov-2026) -- nunca se pasan en un render real de
 * producción (quedan `undefined`, que no agrega ninguna bandera, el
 * comportamiento exacto de antes). `--frames` (confirmado contra la
 * documentación oficial vigente de `npx remotion render`, no asumido:
 * acepta rangos como "0-29,20650-20679" para concatenar solo esos
 * tramos) permite mirar el arranque Y una ventana intermedia del video
 * SIN tocar la duración real de la composición ni renderizar el job
 * completo.
 */
export const buildRenderArgs = ({ compositionId, outputPath, propsJobFile, concurrency, enableMultiprocessOnLinux, browserExecutable, binariesDirectory, frames, logLevel }) => {
  const args = ["remotion", "render", compositionId, outputPath, `--props=${JSON.stringify({ jobFile: propsJobFile })}`, `--concurrency=${concurrency}`];
  if (enableMultiprocessOnLinux) args.push("--enable-multiprocess-on-linux");
  if (browserExecutable) args.push(`--browser-executable=${browserExecutable}`);
  if (binariesDirectory) args.push(`--binaries-directory=${binariesDirectory}`);
  if (frames) args.push(`--frames=${frames}`);
  if (logLevel) args.push(`--log=${logLevel}`);
  return args;
};

// --------------------------------------------------------------------
// Ejecución real -- mismo comportamiento de timeout/cancelación/código
// de salida que la versión anterior de `runRender()` en index.mjs (ver
// commit que la reemplaza), ahora extraída para poder probarla con
// Remotion/FFmpeg reales en CI sin levantar el servidor completo, y
// con lectura real de stdout agregada.
// --------------------------------------------------------------------

/**
 * Corre `npx remotion render` y reporta progreso estructurado vía
 * `onProgress` (ver `parseRenderProgressLine`). Nunca cambia el
 * comportamiento de timeout/cancelación/salida respecto a la versión
 * anterior -- solo agrega lectura de stdout, que antes se ignoraba
 * por completo.
 */
export const runRemotionRender = ({
  npxCommand = "npx",
  cwd,
  env,
  compositionId = "VideoEngine",
  outputPath,
  propsJobFile,
  concurrency,
  enableMultiprocessOnLinux = false,
  browserExecutable,
  binariesDirectory,
  timeoutMs = 0,
  // Vigilante de render trabado (criterio 3): si pasan
  // `stuckAfterMs` sin NINGÚN evento de progreso nuevo (ni rendering
  // ni encoding -- cualquiera cuenta como "avanzó"), se corta el
  // proceso con RenderStuckError. 0 = desactivado. Se revisa cada
  // `stuckCheckIntervalMs` -- no hace falta más fino que eso para
  // detectar algo del orden de minutos.
  stuckAfterMs = 0,
  stuckCheckIntervalMs = 30_000,
  // Corrección del vigilante (08-nov-2026, revisión del operador
  // contra f157a65): el diagnóstico de atasco (CPU/memoria) tiene que
  // MEDIRSE antes de mandar cualquier señal al proceso -- medido
  // después, tiende a marcar CPU cerca de 0 aunque el proceso
  // estuviera ocupado, porque ya está muriendo. `stuckDiagnosisTimeoutMs`
  // es el tope de espera para ese diagnóstico (no para el render
  // entero) -- si `onStuck` tarda más que esto o falla, se corta el
  // proceso igual, para que un diagnóstico roto nunca impida liberar
  // el servidor.
  stuckDiagnosisTimeoutMs = 20_000,
  // Cuánto esperar después de que el proceso cierra antes de contar
  // descendientes vivos (criterio 3) -- un instante para que SIGKILL
  // termine de propagarse, no para "darle tiempo de más" al render.
  processTreeCheckDelayMs = 1000,
  onStuck = () => {},
  onProgress = () => {},
  onLog = () => {},
  registerChild = () => {},
  unregisterChild = () => {},
  isCancelled = () => false,
  makeCancelledError = () => new Error("Render cancelado."),
}) =>
  new Promise((resolve, reject) => {
    const args = buildRenderArgs({ compositionId, outputPath, propsJobFile, concurrency, enableMultiprocessOnLinux, browserExecutable, binariesDirectory });
    // `detached: true` (y no más que eso -- no `setsid`/nueva sesión,
    // solo nuevo GRUPO de procesos): hace que `child.pid` sea el
    // LÍDER de un grupo de procesos propio, distinto del grupo del
    // servidor. Sin esto, matar "todo el grupo" habría arriesgado
    // señalar al servidor mismo (heredaría el mismo grupo). Los
    // descendientes de `child` (el compositor de Remotion, Chrome, los
    // subprocesos de Chrome) heredan este mismo grupo salvo que alguno
    // llame a `setpgid` por su cuenta -- confirmado real en Linux, no
    // asumido (ver test-render-observability.mjs).
    const child = spawn(npxCommand, args, { cwd, env, detached: true });
    registerChild(child);

    let stderrTail = "";
    // Diagnóstico accesible por la API (Fase 0, causa raíz con
    // evidencia, 09-nov-2026, criterio 1): antes de este cambio, solo
    // se interpretaban las líneas de progreso reconocidas (Bundling/
    // Rendered/Encoded/Stitching) -- cualquier otra línea de stdout
    // (lo que Remotion o Chrome digan durante un atasco) se
    // descartaba en silencio. `stdoutTail` guarda TODO lo que llega,
    // acotado igual que `stderrTail` -- es la evidencia que antes solo
    // existía en el log de Portainer (que Alex no puede leer de forma
    // fiable) y ahora viaja en el error final hacia `GET /jobs/:id`.
    const EVIDENCE_TAIL_MAX_CHARS = 4000;
    let stdoutTail = "";
    let stdoutLineBuffer = "";
    let timedOut = false;
    let stuck = false;
    let stuckDiagnosis = null;
    let lastGroupCpuTicks = null;
    // Arranca en el momento del spawn, no recién en el primer evento
    // -- si el proceso nunca llega a emitir NINGUNA línea de progreso
    // (atascado en el bundling o en abrir el navegador), el vigilante
    // tiene que poder detectar eso también, no solo un cuelgue A MITAD
    // del render.
    let lastProgressAt = Date.now();
    let lastProgressEvent = null;

    const recordProgress = (event) => {
      lastProgressAt = Date.now();
      lastProgressEvent = event;
      onProgress(event);
    };

    child.stderr.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-EVIDENCE_TAIL_MAX_CHARS);
    });

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdoutTail = (stdoutTail + text).slice(-EVIDENCE_TAIL_MAX_CHARS);
      stdoutLineBuffer += text;
      const lines = stdoutLineBuffer.split("\n");
      // La última entrada puede ser una línea incompleta (el chunk no
      // vino alineado con un \n) -- se deja en el buffer para la
      // próxima tanda, nunca se la trata como línea terminada.
      stdoutLineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const event = parseRenderProgressLine(line);
        if (event) recordProgress(event);
      }
    });

    let timeoutTimer = null;
    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        onLog(`superó ${Math.round(timeoutMs / 60000)} min, terminando el proceso (grupo completo).`);
        killProcessGroup(child, "SIGTERM");
        setTimeout(() => killProcessGroup(child, "SIGKILL"), 10_000);
      }, timeoutMs);
    }

    // Corrección 08-nov-2026: el diagnóstico (onStuck) se ESPERA acá,
    // con un tope propio (`stuckDiagnosisTimeoutMs`), ANTES de mandar
    // cualquier señal al proceso -- antes se llamaba a onStuck() sin
    // esperarlo y la señal salía en la línea siguiente, así que la
    // medición de CPU (una ventana de varios segundos) ocurría EN
    // PARALELO con el proceso ya muriendo, no antes. El log deja
    // constancia explícita de que la medición fue previa al corte.
    const handleStuckDetected = async ({ lastProgressEvent, msSinceLastProgress }) => {
      onLog(
        `SIN NINGÚN cuadro nuevo en ${Math.round(msSinceLastProgress / 60000)} min (umbral: ${Math.round(stuckAfterMs / 60000)} min) Y SIN actividad de CPU del grupo -- ` +
          `último evento: ${lastProgressEvent ? JSON.stringify(lastProgressEvent) : "ninguno (nunca empezó a reportar progreso)"}. ` +
          `Diagnosticando el proceso ANTES de tocarlo (tope: ${Math.round(stuckDiagnosisTimeoutMs / 1000)}s)...`,
      );
      const diagnosisStartedAt = Date.now();
      await Promise.race([
        Promise.resolve()
          .then(() => onStuck({ lastProgressEvent, msSinceLastProgress }))
          .then((diagnosis) => {
            stuckDiagnosis = diagnosis ?? null;
          })
          .catch((err) => onLog(`el diagnóstico de atasco falló (no bloquea el corte): ${err?.message ?? err}`)),
        new Promise((resolve) => setTimeout(resolve, stuckDiagnosisTimeoutMs)),
      ]);
      onLog(
        `diagnóstico completado en ${Date.now() - diagnosisStartedAt}ms, MEDIDO ANTES DE CUALQUIER SEÑAL -- terminando el proceso (grupo completo) ahora.`,
      );
      killProcessGroup(child, "SIGTERM");
      setTimeout(() => killProcessGroup(child, "SIGKILL"), 10_000);
    };

    let stuckTimer = null;
    if (stuckAfterMs > 0) {
      stuckTimer = setInterval(() => {
        void (async () => {
          // La muestra de CPU se toma SIEMPRE, en CADA revisión, nunca
          // solo cuando ya está añejo -- defecto real encontrado
          // probando esto contra un render real (09-nov-2026, no en
          // teoría): si la medición empezaba recién al llegar a
          // `stuckAfterMs`, esa PRIMERA medición nunca tenía una
          // lectura anterior con la que comparar -- `cpuTicksDelta`
          // salía `null` SIEMPRE en la primera revisión posible,
          // sin importar cuánto durara `stuckAfterMs`, y el
          // fail-safe de `shouldConsiderStuck` (null -> cortar)
          // terminaba el proceso de inmediato en TODOS los casos,
          // incluso uno genuinamente activo. Midiendo desde la
          // primera revisión (aunque todavía no esté añejo) ya hay
          // una lectura anterior real con la que comparar para
          // cuando SÍ se vuelve añejo.
          const currentTicks = typeof child.pid === "number" ? await sumGroupCpuTicks(child.pid) : null;
          const cpuTicksDelta = lastGroupCpuTicks !== null && currentTicks !== null ? currentTicks - lastGroupCpuTicks : null;
          if (currentTicks !== null) lastGroupCpuTicks = currentTicks;

          const msSinceLastProgress = Date.now() - lastProgressAt;
          if (msSinceLastProgress < stuckAfterMs) return;

          // Criterio 6: antes de decidir que está "trabado", se usa
          // la muestra de arriba para ver si el grupo de procesos usó
          // algo de CPU desde la revisión anterior -- si sí, está
          // ocupado (bundling, navegador arrancando, decodificando
          // algo lento), no colgado; se sigue esperando sin cortar (el
          // timeout total de render, sin cambios, sigue siendo el
          // límite final absoluto).
          if (!shouldConsiderStuck({ msSinceLastProgress, stuckAfterMs, cpuTicksDelta })) {
            onLog(
              `sin cuadros nuevos en ${Math.round(msSinceLastProgress / 60000)} min, pero el grupo de procesos SÍ usó CPU en los últimos ${Math.round(stuckCheckIntervalMs / 1000)}s ` +
                `(+${cpuTicksDelta} ticks) -- se considera "lento, no trabado": no se corta por este mecanismo todavía.`,
            );
            return;
          }

          stuck = true;
          clearInterval(stuckTimer);
          void handleStuckDetected({ lastProgressEvent, msSinceLastProgress });
        })();
      }, stuckCheckIntervalMs);
    }

    // "close" (no "exit"): Node garantiza que para entonces los stdio
    // del hijo ya terminaron de emitir todos sus "data" -- con "exit"
    // la ÚLTIMA línea de stdout (p.ej. "Rendered 180/180", justo antes
    // de que el proceso termine) podía llegar DESPUÉS del callback,
    // perdiéndose el evento de progreso final. Confirmado con un
    // render real en CI (08-nov-2026): con "exit" fallaba
    // intermitentemente la aserción de "el último evento llega al
    // 100%"; con "close" + el flush de abajo, no.
    child.on("close", async (code, signal) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (stuckTimer) clearInterval(stuckTimer);
      unregisterChild();
      // La última línea puede no haber tenido un "\n" final antes de
      // que el proceso cerrara su stdout -- se parsea igual en vez de
      // descartarla en silencio.
      if (stdoutLineBuffer) {
        const event = parseRenderProgressLine(stdoutLineBuffer);
        if (event) recordProgress(event);
        stdoutLineBuffer = "";
      }
      onLog(`proceso hijo salió: code=${code} signal=${signal}`);

      // Criterio 3 (corrección 08-nov-2026): solo tras un corte
      // ANORMAL (atasco/timeout/cancelación -- nunca en un render que
      // terminó bien solo) se confirma cuántos procesos del grupo
      // siguen vivos. Un instante de margen para que el SIGKILL de
      // arriba termine de propagarse antes de contar.
      let descendantProcessesAliveAfterCut = null;
      if (isCancelled() || stuck || timedOut) {
        await new Promise((r) => setTimeout(r, processTreeCheckDelayMs));
        descendantProcessesAliveAfterCut = typeof child.pid === "number" ? await countAliveProcessesInGroup(child.pid) : null;
        onLog(
          descendantProcessesAliveAfterCut === null
            ? `no se pudo comprobar procesos descendientes vivos (sin /proc disponible -- esperado en macOS de desarrollo, no en el contenedor de producción).`
            : `procesos descendientes del render vivos tras el corte: ${descendantProcessesAliveAfterCut}${descendantProcessesAliveAfterCut === 0 ? " (ninguno)" : " -- REVISAR, se esperaba 0"}.`,
        );
      }

      // Evidencia accesible por la API (criterio 1) -- antes, todo
      // esto (línea del video fuente -- agregada por quien llama en
      // index.mjs --, stdout/stderr completos, diagnóstico de atasco,
      // conteo de huérfanos) solo existía en el log de Portainer, que
      // Alex no puede leer de forma fiable. Se adjunta al error mismo
      // para que index.mjs lo guarde en el estado del job sin tener
      // que rehacer ninguna de estas mediciones.
      const buildEvidence = (endedReason) => ({
        endedReason,
        stdoutTail,
        stderrTail,
        lastProgressEvent,
        descendantProcessesAliveAfterCut,
        stuckDiagnosis,
      });

      if (isCancelled()) {
        reject(makeCancelledError());
      } else if (stuck) {
        const err = new RenderStuckError(
          `El render se quedó sin reportar ningún cuadro nuevo Y sin actividad de CPU durante ${Math.round(stuckAfterMs / 60000)} min -- se terminó el proceso. ` +
            `Último evento visto: ${lastProgressEvent ? JSON.stringify(lastProgressEvent) : "ninguno"}.`,
        );
        err.evidence = buildEvidence("stuck");
        reject(err);
      } else if (timedOut) {
        const err = new RenderTimeoutError(`El render superó el límite de ${Math.round(timeoutMs / 60000)} minutos.`);
        err.evidence = buildEvidence("timeout");
        reject(err);
      } else if (code === 0) {
        resolve();
      } else {
        const err = new Error(`remotion render exited with code=${code} signal=${signal}: ${stderrTail}`);
        err.evidence = buildEvidence("exit-error");
        reject(err);
      }
    });
    child.on("error", (err) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (stuckTimer) clearInterval(stuckTimer);
      unregisterChild();
      onLog(`error al lanzar el proceso: ${err.message}`);
      reject(err);
    });
  });
