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
 */
export const buildRenderArgs = ({ compositionId, outputPath, propsJobFile, concurrency, enableMultiprocessOnLinux, browserExecutable, binariesDirectory }) => {
  const args = ["remotion", "render", compositionId, outputPath, `--props=${JSON.stringify({ jobFile: propsJobFile })}`, `--concurrency=${concurrency}`];
  if (enableMultiprocessOnLinux) args.push("--enable-multiprocess-on-linux");
  if (browserExecutable) args.push(`--browser-executable=${browserExecutable}`);
  if (binariesDirectory) args.push(`--binaries-directory=${binariesDirectory}`);
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
    const child = spawn(npxCommand, args, { cwd, env });
    registerChild(child);

    let stderrTail = "";
    let stdoutLineBuffer = "";
    let timedOut = false;
    let stuck = false;
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
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4000);
    });

    child.stdout.on("data", (chunk) => {
      stdoutLineBuffer += chunk.toString("utf8");
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
        onLog(`superó ${Math.round(timeoutMs / 60000)} min, terminando el proceso.`);
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 10_000);
      }, timeoutMs);
    }

    let stuckTimer = null;
    if (stuckAfterMs > 0) {
      stuckTimer = setInterval(() => {
        const msSinceLastProgress = Date.now() - lastProgressAt;
        if (msSinceLastProgress >= stuckAfterMs) {
          stuck = true;
          clearInterval(stuckTimer);
          onStuck({ lastProgressEvent, msSinceLastProgress });
          onLog(
            `SIN NINGÚN cuadro nuevo en ${Math.round(msSinceLastProgress / 60000)} min (umbral: ${Math.round(stuckAfterMs / 60000)} min) -- ` +
              `último evento: ${lastProgressEvent ? JSON.stringify(lastProgressEvent) : "ninguno (nunca empezó a reportar progreso)"}. Terminando el proceso.`,
          );
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 10_000);
        }
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
    child.on("close", (code, signal) => {
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
      if (isCancelled()) {
        reject(makeCancelledError());
      } else if (stuck) {
        reject(
          new RenderStuckError(
            `El render se quedó sin reportar ningún cuadro nuevo durante ${Math.round(stuckAfterMs / 60000)} min -- se terminó el proceso. ` +
              `Último evento visto: ${lastProgressEvent ? JSON.stringify(lastProgressEvent) : "ninguno"}.`,
          ),
        );
      } else if (timedOut) {
        reject(new RenderTimeoutError(`El render superó el límite de ${Math.round(timeoutMs / 60000)} minutos.`));
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(`remotion render exited with code=${code} signal=${signal}: ${stderrTail}`));
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
