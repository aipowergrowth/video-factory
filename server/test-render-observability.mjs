// PRUEBA DE REGRESIÓN CON REMOTION REAL -- Fase 0 "render de videos
// largos" (08-nov-2026, autorizado por Alex), criterio 1: confirma con
// un render de verdad (mismo FFmpeg/Chrome que producción) que
// `runRemotionRender` (server/render-worker.mjs) reporta progreso
// estructurado real -- no solo que el parseo de texto simulado
// funciona (eso ya lo prueba test-render-worker.mjs), sino que el
// binario real de verdad imprime lo que se espera y que el mecanismo
// de timeout/cancelación sigue funcionando igual que antes de esta
// extracción.
//
// Corre en GitHub Actions (.github/workflows/captions-destination-test.yml)
// -- esta máquina de desarrollo (macOS 12) no puede ejecutar Remotion
// (ver README.md). Usa un video base SINTÉTICO (fondo negro) generado
// con el mismo FFmpeg real de producción -- nada de contenido real, ni
// llamadas de IA, ni costo.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCompositorFfmpeg, resolveCompositorFfprobe, binaryEnv } from "./compositor.mjs";
import { runRemotionRender, RenderTimeoutError, RenderStuckError } from "./render-worker.mjs";
import { probeSourceVideoDiagnostics, formatSourceVideoDiagnosticsLine } from "./source-video-diagnostics.mjs";
import { runDiagnosticRender, buildDiagnosticFrameRanges } from "./render-diagnose.mjs";
import { killProcessGroup, countAliveProcessesInGroup, sumGroupCpuTicks } from "./process-tree.mjs";

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let failures = 0;
const check = (label, cond, detail = "") => {
  if (!cond) {
    failures++;
    console.log(`FAIL: ${label}${detail ? ` -- ${detail}` : ""}`);
  } else {
    console.log(`ok: ${label}`);
  }
};

const ffmpegPath = resolveCompositorFfmpeg();
const ffmpegEnv = binaryEnv(ffmpegPath);
const ffprobePath = resolveCompositorFfprobe();
const ffprobeEnv = binaryEnv(ffprobePath);

const FIXTURES_REL_DIR = "jobs/test-fixtures-render-observability";
const FIXTURES_DIR = path.join(PROJECT_ROOT, "public", FIXTURES_REL_DIR);
await fs.mkdir(FIXTURES_DIR, { recursive: true });

const BASE_VIDEO_REL = `${FIXTURES_REL_DIR}/base.mp4`;
const baseVideoPath = path.join(PROJECT_ROOT, "public", BASE_VIDEO_REL);
// 6s a 30fps = 180 cuadros -- bastante para ver progreso real de verdad
// (no solo 0/1), pero corto para no gastar minutos de CI de más.
await execFileAsync(
  ffmpegPath,
  ["-y", "-f", "lavfi", "-i", "nullsrc=size=640x360:rate=30", "-t", "6", "-pix_fmt", "yuv420p", "-c:v", "libx264", baseVideoPath],
  { env: ffmpegEnv },
);

const makeJobFile = async (name, durationInSeconds) => {
  const relPath = `${FIXTURES_REL_DIR}/${name}.json`;
  await fs.writeFile(
    path.join(PROJECT_ROOT, "public", relPath),
    JSON.stringify({
      channel: "a-mi-no-me-cuadra",
      destination: "youtube-16-9",
      input: { type: "recorded-video", baseVideo: BASE_VIDEO_REL, durationInSeconds },
      overlays: [],
      captions: [],
      cuts: [],
      zooms: [],
      resources: [],
    }),
  );
  return relPath;
};

// --- Caso 1: render normal -- progreso real reportado, archivo final válido ---
try {
  const jobRelPath = await makeJobFile("caso1", 6);
  const outputPath = path.join(FIXTURES_DIR, "caso1-out.mp4");
  const progressEvents = [];
  const logs = [];
  let registeredChild = null;

  await runRemotionRender({
    cwd: PROJECT_ROOT,
    env: process.env,
    outputPath,
    propsJobFile: jobRelPath,
    concurrency: "1",
    timeoutMs: 120_000,
    onProgress: (event) => progressEvents.push(event),
    onLog: (msg) => logs.push(msg),
    registerChild: (child) => {
      registeredChild = child;
    },
  });

  check("caso 1: el render terminó sin lanzar", true);
  check("caso 1: se registró el proceso hijo real", registeredChild !== null && typeof registeredChild.pid === "number");
  check("caso 1: el archivo de salida existe y no está vacío", (await fs.stat(outputPath)).size > 0);

  const renderingEvents = progressEvents.filter((e) => e.stage === "rendering");
  const encodingEvents = progressEvents.filter((e) => e.stage === "encoding");
  console.log(`[caso 1] eventos de progreso reales: rendering=${renderingEvents.length}, encoding=${encodingEvents.length}, total=${progressEvents.length}`);
  check("caso 1: hubo al menos un evento real de 'rendering'", renderingEvents.length > 0);
  check("caso 1: hubo al menos un evento real de 'encoding'", encodingEvents.length > 0);
  // Defecto real descubierto en esta misma prueba (08-nov-2026, dos
  // corridas de CI distintas, 90 y 180 cuadros): "Rendered N/TOTAL" es
  // 0-indexado y en la práctica NUNCA imprime el tick exacto N=TOTAL
  // -- se queda en "TOTAL-1/TOTAL" (el índice del último cuadro) y pasa
  // directo a "Encoded" sin un último "Rendered" literal al 100%. Eso
  // SÍ confirmado real, no se asume: ver el informe de esta fase. Por
  // eso la tolerancia de 1 cuadro -- exigir el 100% exacto sería una
  // aserción falsa contra el binario real, no un defecto del parser.
  const lastRendering = renderingEvents[renderingEvents.length - 1];
  check(
    "caso 1: el último evento de rendering llega como mínimo a TOTAL-1 (el índice del último cuadro -- Remotion nunca imprime el tick exacto N=TOTAL, confirmado real)",
    lastRendering && lastRendering.renderedFrames >= lastRendering.totalFrames - 1,
    `renderedFrames=${lastRendering?.renderedFrames} totalFrames=${lastRendering?.totalFrames}`,
  );
  const lastEncoding = encodingEvents[encodingEvents.length - 1];
  check(
    "caso 1: el último evento de encoding SÍ llega exacto al 100% (a diferencia de 'rendering', confirmado real)",
    lastEncoding && lastEncoding.encodedFrames === lastEncoding.totalFrames,
    `encodedFrames=${lastEncoding?.encodedFrames} totalFrames=${lastEncoding?.totalFrames}`,
  );
  check(
    "caso 1: el total de cuadros es el esperado para 6s a 30fps (180)",
    renderingEvents.length > 0 && renderingEvents[0].totalFrames === 180,
  );
  check("caso 1: el log recibió la línea real de salida del proceso hijo", logs.some((l) => l.includes("proceso hijo salió")));
} catch (err) {
  check("caso 1 (render normal): no debería fallar", false, String(err.message ?? err));
}

// Confirma, para un `child` ya cerrado, que no quedó NINGÚN
// descendiente vivo en su grupo de procesos (criterio 2+4 de la
// corrección 08-nov-2026) -- reutilizado por los casos 2, 3 y 6, que
// cortan un render real por los tres motivos posibles (timeout,
// cancelación, atasco).
const checkNoOrphans = async (label, pid) => {
  if (typeof pid !== "number") {
    check(`${label}: no se pudo verificar huérfanos (no se registró el pid real)`, false);
    return;
  }
  await new Promise((r) => setTimeout(r, 1500)); // margen para que el SIGKILL de respaldo termine de propagarse
  const aliveCount = await countAliveProcessesInGroup(pid);
  check(
    `${label}: 0 procesos descendientes vivos en el grupo tras el corte (grupo completo terminado, no solo npx)`,
    aliveCount === null || aliveCount === 0,
    `aliveCount=${aliveCount}`,
  );
};

// --- Caso 2: timeout -- el mismo mecanismo de antes, ahora corta el grupo completo (criterio 2) ---
try {
  const jobRelPath = await makeJobFile("caso2", 6);
  const outputPath = path.join(FIXTURES_DIR, "caso2-out.mp4");
  let threw = null;
  let childRef = null;
  try {
    await runRemotionRender({
      cwd: PROJECT_ROOT,
      env: process.env,
      outputPath,
      propsJobFile: jobRelPath,
      concurrency: "1",
      timeoutMs: 1, // garantiza el timeout de forma determinística
      onLog: () => {},
      registerChild: (child) => {
        childRef = child;
      },
    });
  } catch (err) {
    threw = err;
  }
  check("caso 2: un timeout muy corto rechaza con RenderTimeoutError", threw instanceof RenderTimeoutError);
  check("caso 2: el mensaje menciona el límite de tiempo", /superó el límite/.test(threw?.message ?? ""));
  await checkNoOrphans("caso 2 (timeout)", childRef?.pid);
} catch (err) {
  check("caso 2 (timeout): fallo inesperado en la prueba misma", false, String(err.message ?? err));
}

// --- Caso 3: cancelación -- isCancelled/makeCancelledError se respetan igual que antes, y corta el grupo completo (criterio 2) ---
try {
  const jobRelPath = await makeJobFile("caso3", 6);
  const outputPath = path.join(FIXTURES_DIR, "caso3-out.mp4");
  class FakeCancelledError extends Error {}
  let cancelledFlag = false;
  let childRef = null;
  let sawRealProgress = false;
  const renderPromise = runRemotionRender({
    cwd: PROJECT_ROOT,
    env: process.env,
    outputPath,
    propsJobFile: jobRelPath,
    concurrency: "1",
    timeoutMs: 60_000,
    onProgress: () => {
      sawRealProgress = true;
    },
    onLog: () => {},
    registerChild: (child) => {
      childRef = child;
    },
    isCancelled: () => cancelledFlag,
    makeCancelledError: () => new FakeCancelledError("cancelado para la prueba"),
  });
  // Espera a ver progreso REAL (bundling/rendering) antes de cancelar
  // -- no un sleep fijo adivinado -- para asegurar que Chrome ya está
  // lanzado como subproceso cuando se corta: así el chequeo de
  // huérfanos de abajo prueba algo real, no un árbol vacío que nunca
  // llegó a tener a Chrome. Tope de 20s por si algo sale mal.
  const waitStartedAt = Date.now();
  while (!sawRealProgress && Date.now() - waitStartedAt < 20_000) {
    await new Promise((r) => setTimeout(r, 100));
  }
  check("caso 3: se vio progreso real (Chrome ya lanzado) antes de cancelar", sawRealProgress);
  cancelledFlag = true;
  // Mismo mecanismo que ahora usa el endpoint de cancelar en
  // index.mjs -- termina el grupo completo, no solo el proceso npx.
  killProcessGroup(childRef, "SIGTERM");

  let threw = null;
  try {
    await renderPromise;
  } catch (err) {
    threw = err;
  }
  check("caso 3: cancelar mientras corre rechaza con el error que da makeCancelledError (no un error genérico)", threw instanceof FakeCancelledError);
  await checkNoOrphans("caso 3 (cancelación, con Chrome real ya lanzado)", childRef?.pid);
} catch (err) {
  check("caso 3 (cancelación): fallo inesperado en la prueba misma", false, String(err.message ?? err));
}

// --- Caso 4: probeSourceVideoDiagnostics contra ffprobe real, con
// verdad conocida (criterio 2) -- dos videos sintéticos del MISMO
// contenido y duración (15s/450 cuadros @30fps), que solo difieren en
// el intervalo de keyframes (-g): uno "denso" (keyframe cada 1s, como
// la mayoría de video editado) y otro "escaso" (UN solo keyframe para
// todo el clip, como algunas grabaciones de pantalla/cámara sin
// recodificar) -- el mismo tipo de diferencia que la discusión pública
// de Remotion (#3070) señala como causa de lentitud severa en
// OffthreadVideo.
try {
  const denseVideoPath = path.join(FIXTURES_DIR, "keyframes-denso.mp4");
  await execFileAsync(
    ffmpegPath,
    [
      "-y", "-f", "lavfi", "-i", "nullsrc=size=640x360:rate=30", "-t", "15",
      "-pix_fmt", "yuv420p", "-c:v", "libx264", "-g", "30", "-keyint_min", "30", "-sc_threshold", "0",
      denseVideoPath,
    ],
    { env: ffmpegEnv },
  );
  const denseDiag = await probeSourceVideoDiagnostics(denseVideoPath, { ffprobePath, env: ffprobeEnv });
  console.log(`[caso 4] denso -- ${formatSourceVideoDiagnosticsLine(denseDiag)}`);
  check("caso 4 (denso): códec detectado real = h264", denseDiag.codec === "h264", `codec=${denseDiag.codec}`);
  check("caso 4 (denso): resolución real = 640x360", denseDiag.width === 640 && denseDiag.height === 360);
  check("caso 4 (denso): fps constante (declarado y promedio coinciden)", denseDiag.likelyVfr === false);
  check(
    "caso 4 (denso): ~15 keyframes para 15s con -g 30 (uno por segundo)",
    denseDiag.keyframeCount >= 13 && denseDiag.keyframeCount <= 16,
    `keyframeCount=${denseDiag.keyframeCount}`,
  );
  check("caso 4 (denso): riesgo clasificado como bajo", denseDiag.keyframeIntervalRisk === "bajo", `risk=${denseDiag.keyframeIntervalRisk}`);

  const sparseVideoPath = path.join(FIXTURES_DIR, "keyframes-escaso.mp4");
  await execFileAsync(
    ffmpegPath,
    [
      "-y", "-f", "lavfi", "-i", "nullsrc=size=640x360:rate=30", "-t", "15",
      "-pix_fmt", "yuv420p", "-c:v", "libx264", "-g", "450", "-keyint_min", "450", "-sc_threshold", "0",
      sparseVideoPath,
    ],
    { env: ffmpegEnv },
  );
  const sparseDiag = await probeSourceVideoDiagnostics(sparseVideoPath, { ffprobePath, env: ffprobeEnv });
  console.log(`[caso 4] escaso -- ${formatSourceVideoDiagnosticsLine(sparseDiag)}`);
  check(
    "caso 4 (escaso): 1 solo keyframe para los 15s completos (-g 450 = GOP = duración total)",
    sparseDiag.keyframeCount === 1,
    `keyframeCount=${sparseDiag.keyframeCount}`,
  );
  check("caso 4 (escaso): riesgo clasificado como alto", sparseDiag.keyframeIntervalRisk === "alto", `risk=${sparseDiag.keyframeIntervalRisk}`);
} catch (err) {
  check("caso 4 (diagnóstico de video fuente): no debería fallar", false, String(err.message ?? err));
}

// --- Caso 5: intento de reproducción del atasco (criterio 4) --
// renderiza el MISMO job (OffthreadVideo, la ruta real de producción
// para "recorded-video") con el video denso y con el escaso del caso
// 4, y compara el tiempo total. Si el escaso tarda muchísimo más o se
// queda sin progreso (RenderStuckError), es evidencia real de la
// hipótesis (b); si tarda igual, es evidencia de que, AL MENOS en un
// clip sintético corto de color plano, la escasez de keyframes sola no
// alcanza para reproducir el atasco -- y entonces la causa del job real
// (23 min, contenido real, no sintético) queda sin confirmar sin
// acceso al VPS. Cualquiera de los dos resultados se reporta tal cual,
// no se fuerza una conclusión.
let caso5Resultado = "no determinado (la prueba falló antes de completarse)";
try {
  const renderOnce = async (label, baseVideoRel) => {
    const jobRelPath = await makeJobFile(`caso5-${label}`, 15);
    // Sobrescribe el job para usar el video de este caso en vez del de
    // fondo negro genérico de los casos 1-3 -- mismo resto de campos.
    await fs.writeFile(
      path.join(PROJECT_ROOT, "public", jobRelPath),
      JSON.stringify({
        channel: "a-mi-no-me-cuadra",
        destination: "youtube-16-9",
        input: { type: "recorded-video", baseVideo: baseVideoRel, durationInSeconds: 15 },
        overlays: [],
        captions: [],
        cuts: [],
        zooms: [],
        resources: [],
      }),
    );
    const outputPath = path.join(FIXTURES_DIR, `caso5-${label}-out.mp4`);
    const startedAt = Date.now();
    let stuckInfo = null;
    try {
      await runRemotionRender({
        cwd: PROJECT_ROOT,
        env: process.env,
        outputPath,
        propsJobFile: jobRelPath,
        concurrency: "1",
        timeoutMs: 300_000, // red de seguridad para no colgar el job de CI si algo va mal de verdad
        stuckAfterMs: 120_000, // umbral generoso -- un clip de 15s no debería tardar 2 min sin AVANZAR NI UN cuadro si no está realmente trabado
        onStuck: (info) => {
          stuckInfo = info;
        },
        onLog: () => {},
      });
      return { elapsedMs: Date.now() - startedAt, stuck: false, stuckInfo };
    } catch (err) {
      if (err instanceof RenderStuckError) {
        return { elapsedMs: Date.now() - startedAt, stuck: true, stuckInfo, error: err };
      }
      throw err;
    }
  };

  const denseResult = await renderOnce("denso", `${FIXTURES_REL_DIR}/keyframes-denso.mp4`);
  console.log(`[caso 5] render con keyframes DENSOS: ${denseResult.elapsedMs}ms, trabado=${denseResult.stuck}`);
  const sparseResult = await renderOnce("escaso", `${FIXTURES_REL_DIR}/keyframes-escaso.mp4`);
  console.log(`[caso 5] render con keyframes ESCASOS: ${sparseResult.elapsedMs}ms, trabado=${sparseResult.stuck}`);

  if (sparseResult.stuck) {
    caso5Resultado =
      `REPRODUCIDO: el render con keyframes escasos se quedó sin avanzar y el vigilante lo cortó ` +
      `(RenderStuckError) -- evidencia real a favor de la hipótesis (b).`;
    check("caso 5: si el render escaso se traba, lanza RenderStuckError (no un error genérico)", sparseResult.error instanceof RenderStuckError);
  } else {
    const ratio = sparseResult.elapsedMs / Math.max(denseResult.elapsedMs, 1);
    console.log(`[caso 5] razón de tiempo escaso/denso = ${ratio.toFixed(2)}x`);
    if (ratio >= 3) {
      caso5Resultado = `REPRODUCIDO PARCIALMENTE: el render escaso tardó ${ratio.toFixed(2)}x más que el denso (sin llegar a trabarse) -- evidencia real de lentitud por keyframes escasos, consistente con la hipótesis (b), aunque no reproduce el atasco TOTAL (0 cuadros) del job real.`;
    } else {
      caso5Resultado =
        `NO REPRODUCIDO en este tamaño sintético: ambos renders completaron en tiempo similar (razón ${ratio.toFixed(2)}x). ` +
        `Un clip de 15s de color plano sin movimiento puede no generar la misma carga de decodificación que 23 min de contenido real ` +
        `-- la causa raíz del job real sigue sin confirmarse sin evidencia del VPS (ver criterio 5 del informe).`;
    }
  }
  console.log(`[caso 5] CONCLUSIÓN DEL INTENTO DE REPRODUCCIÓN: ${caso5Resultado}`);
} catch (err) {
  caso5Resultado = `la prueba de reproducción falló por un error inesperado, no por el fenómeno en sí: ${String(err.message ?? err)}`;
  check("caso 5 (intento de reproducción): no debería fallar por un error de la prueba misma", false, caso5Resultado);
}

// --- Caso 6: vigilante de render trabado -- disparo determinístico
// (criterio 3), AHORA además confirma la corrección 08-nov-2026 contra
// la revisión del operador: (a) el diagnóstico se espera de verdad
// ANTES de la señal -- se prueba con un onStuck real que tarda un
// tiempo medible, y se confirma que el log de "terminando el proceso"
// sale DESPUÉS de que ese tiempo pasó, no en paralelo; (b) no queda
// ningún descendiente vivo tras el corte.
try {
  const jobRelPath = await makeJobFile("caso6", 15);
  const outputPath = path.join(FIXTURES_DIR, "caso6-out.mp4");
  let threw = null;
  let stuckCallbackInfo = null;
  let childRef = null;
  const logEvents = []; // { msg, at }
  const DIAGNOSIS_DELAY_MS = 500; // simula un diagnóstico real que SÍ tarda -- si no se espera de verdad, el log de "terminando" saldría casi de inmediato, antes de este tiempo.
  let onStuckResolvedAt = null;
  try {
    await runRemotionRender({
      cwd: PROJECT_ROOT,
      env: process.env,
      outputPath,
      propsJobFile: jobRelPath,
      concurrency: "1",
      timeoutMs: 60_000,
      stuckAfterMs: 1, // dispara en la primera revisión, de forma determinística
      stuckCheckIntervalMs: 50,
      stuckDiagnosisTimeoutMs: 20_000, // muy por encima de DIAGNOSIS_DELAY_MS -- no debe cortar el diagnóstico de esta prueba
      onStuck: async (info) => {
        stuckCallbackInfo = info;
        await new Promise((r) => setTimeout(r, DIAGNOSIS_DELAY_MS));
        onStuckResolvedAt = Date.now();
      },
      onLog: (msg) => logEvents.push({ msg, at: Date.now() }),
      registerChild: (child) => {
        childRef = child;
      },
    });
  } catch (err) {
    threw = err;
  }
  check("caso 6: un umbral de atasco muy corto rechaza con RenderStuckError", threw instanceof RenderStuckError);
  check("caso 6: el mensaje menciona que no se reportó ningún cuadro nuevo", /sin reportar ningún cuadro nuevo/.test(threw?.message ?? ""));
  check("caso 6: el callback onStuck se llamó con los datos esperados", stuckCallbackInfo !== null && typeof stuckCallbackInfo.msSinceLastProgress === "number");
  check("caso 6: se registró el proceso hijo real antes de cortarlo", childRef !== null && typeof childRef.pid === "number");

  const diagnosingLog = logEvents.find((e) => e.msg.includes("Diagnosticando el proceso ANTES de tocarlo"));
  const terminandoLog = logEvents.find((e) => e.msg.includes("MEDIDO ANTES DE CUALQUIER SEÑAL"));
  check("caso 6: se registró el log de 'diagnosticando antes' Y el de 'terminando' (ambos, no solo uno)", Boolean(diagnosingLog) && Boolean(terminandoLog));
  check(
    "caso 6: el log de 'diagnosticando' sale ANTES que el de 'terminando' (orden real de los mensajes)",
    Boolean(diagnosingLog) && Boolean(terminandoLog) && diagnosingLog.at <= terminandoLog.at,
  );
  check(
    `caso 6: el log de 'terminando el proceso' sale DESPUÉS de que onStuck tardó ${DIAGNOSIS_DELAY_MS}ms de verdad -- la medición se ESPERÓ, no se disparó en paralelo con la señal`,
    onStuckResolvedAt !== null && Boolean(terminandoLog) && terminandoLog.at >= onStuckResolvedAt,
    `onStuckResolvedAt=${onStuckResolvedAt} terminandoLog.at=${terminandoLog?.at}`,
  );
  await checkNoOrphans("caso 6 (vigilante de atasco)", childRef?.pid);
} catch (err) {
  check("caso 6 (vigilante de atasco): fallo inesperado en la prueba misma", false, String(err.message ?? err));
}

// --- Caso 7: criterio REDISEÑADO del vigilante (criterio 6) -- un
// render real con un umbral de atasco agresivo (500ms) no se corta
// mientras está bundling de verdad, aunque todavía no haya reportado
// ningún cuadro. Valores elegidos con datos reales, no adivinados: una
// medición previa en este mismo CI (09-nov-2026) mostró el primer
// evento de progreso real (bundling) a los 1112ms del spawn -- 500ms
// queda cómodamente por debajo de eso, y 100ms de intervalo de
// revisión queda cómodamente por encima de la resolución real de los
// ticks de CPU en Linux (CLK_TCK=100 = 10ms; confirmado real en CI que
// valores de intervalo por debajo de eso producen falsos "sin
// actividad" por cuantización, no por inactividad real). La aserción
// dura es que NO se corta (eso es lo que pide el criterio 6); el log
// "lento, no trabado" se registra como evidencia adicional pero no
// hace fallar la prueba por sí solo -- el instante exacto en que la
// revisión cae depende del scheduler del runner de CI, no solo del
// umbral, así que exigir esa línea específica sería frágil sin
// aportar una garantía real adicional sobre la que ya da "no se cortó".
try {
  const jobRelPath = await makeJobFile("caso7", 6);
  const outputPath = path.join(FIXTURES_DIR, "caso7-out.mp4");
  const logs = [];
  let threw = null;
  try {
    await runRemotionRender({
      cwd: PROJECT_ROOT,
      env: process.env,
      outputPath,
      propsJobFile: jobRelPath,
      concurrency: "1",
      timeoutMs: 60_000,
      stuckAfterMs: 500,
      stuckCheckIntervalMs: 100,
      onLog: (msg) => logs.push(msg),
    });
  } catch (err) {
    threw = err;
  }
  check("caso 7: el render NO se cortó por atasco pese al umbral agresivo (había actividad de CPU real durante el bundling)", threw === null, String(threw?.message ?? ""));
  const sawActiveLog = logs.some((l) => l.includes('se considera "lento, no trabado"'));
  console.log(`[caso 7] log de actividad detectada durante el bundling (evidencia adicional, no determina el resultado de la prueba): ${sawActiveLog ? "SÍ se vio" : "no se vio en esta corrida (posible, por el scheduler del runner de CI)"}`);
} catch (err) {
  check("caso 7 (vigilante rediseñado, activo no se corta): fallo inesperado en la prueba misma", false, String(err.message ?? err));
}

// --- Caso 8: medición de actividad de CPU contra procesos reales,
// SIN Remotion -- confirma el primitivo `sumGroupCpuTicks` de forma
// aislada y determinística: un proceso real que quema CPU en un
// bucle muestra ticks subiendo; uno real que solo duerme muestra
// ticks sin cambiar. Esto es lo que distingue "colgado" de "activo"
// en el vigilante -- probarlo aislado de Remotion da evidencia más
// rápida y 100% determinística de que el primitivo en sí funciona
// contra procesos reales de Linux.
try {
  const busyChild = spawn("sh", ["-c", "i=0; while true; do i=$((i+1)); done"], { detached: true });
  const idleChild = spawn("sh", ["-c", "sleep 5"], { detached: true });
  try {
    const busyBefore = await sumGroupCpuTicks(busyChild.pid);
    const idleBefore = await sumGroupCpuTicks(idleChild.pid);
    await new Promise((r) => setTimeout(r, 1000));
    const busyAfter = await sumGroupCpuTicks(busyChild.pid);
    const idleAfter = await sumGroupCpuTicks(idleChild.pid);
    check(
      "caso 8: proceso real ocupado (bucle) -- los ticks de CPU del grupo SUBEN en 1s",
      busyBefore !== null && busyAfter !== null && busyAfter > busyBefore,
      `busyBefore=${busyBefore} busyAfter=${busyAfter}`,
    );
    check(
      "caso 8: proceso real inactivo (sleep) -- los ticks de CPU del grupo NO suben en 1s",
      idleBefore !== null && idleAfter !== null && idleAfter === idleBefore,
      `idleBefore=${idleBefore} idleAfter=${idleAfter}`,
    );
  } finally {
    killProcessGroup(busyChild, "SIGKILL");
    killProcessGroup(idleChild, "SIGKILL");
  }
} catch (err) {
  check("caso 8 (medición de actividad de CPU, procesos reales): fallo inesperado en la prueba misma", false, String(err.message ?? err));
}

// --- Caso 9: render de diagnóstico (criterio 3) contra un video real
// -- confirma, con Remotion/Chrome reales, que se detectan los hitos
// esperados (navegador, bundling, composición, video fuente abierto Y
// primer cuadro extraído), que NO escribe nada persistente (se borra
// el archivo de salida), y que no queda ningún proceso huérfano tras
// el corte -- igual que el render real, pero mucho más rápido.
try {
  const jobRelPath = await makeJobFile("caso9", 20);
  const outputPath = path.join(FIXTURES_DIR, "caso9-out.mp4");
  const frames = buildDiagnosticFrameRanges(600, { initialFrameCount: 10, middleWindowFrameCount: 10 }); // 20s @30fps = 600 cuadros
  const result = await runDiagnosticRender({
    cwd: PROJECT_ROOT,
    env: process.env,
    outputPath,
    propsJobFile: jobRelPath,
    concurrency: "1",
    frames,
    timeoutMs: 60_000,
  });
  check("caso 9: no hubo error de lanzamiento de la herramienta misma", !result.launchError && !result.spawnError, JSON.stringify(result.launchError ?? result.spawnError));
  check("caso 9: el render de diagnóstico completó (código 0) dentro del timeout corto", result.completed === true && result.timedOut === false);
  check("caso 9: hito 'browser-launch-requested' detectado", result.milestones["browser-launch-requested"] !== null);
  check("caso 9: hito 'bundling-done' detectado", result.milestones["bundling-done"] !== null);
  check("caso 9: hito 'composition-metadata-loaded' detectado", result.milestones["composition-metadata-loaded"] !== null);
  check("caso 9: hito 'render-started' detectado", result.milestones["render-started"] !== null);
  check("caso 9: hito 'source-video-opened' detectado (se solicitó el video base)", result.milestones["source-video-opened"] !== null);
  check("caso 9: hito 'source-video-first-frame' detectado (se extrajo el primer cuadro del video base)", result.milestones["source-video-first-frame"] !== null);
  check("caso 9: no quedó ningún proceso descendiente vivo tras el corte", result.descendantProcessesAliveAfterCut === null || result.descendantProcessesAliveAfterCut === 0, `aliveCount=${result.descendantProcessesAliveAfterCut}`);
  const outputStillExists = await fs
    .access(outputPath)
    .then(() => true)
    .catch(() => false);
  check("caso 9: el archivo de salida del diagnóstico se borró (nunca queda nada persistente)", outputStillExists === false);
} catch (err) {
  check("caso 9 (render de diagnóstico): fallo inesperado en la prueba misma", false, String(err.message ?? err));
}

// --- Caso 10: render de diagnóstico con un timeout DELIBERADAMENTE
// corto (1ms) contra un video real -- confirma que "se detiene" se
// reporta como evidencia (timedOut=true), no como un error de la
// herramienta, y que tampoco deja huérfanos.
try {
  const jobRelPath = await makeJobFile("caso10", 20);
  const outputPath = path.join(FIXTURES_DIR, "caso10-out.mp4");
  const result = await runDiagnosticRender({
    cwd: PROJECT_ROOT,
    env: process.env,
    outputPath,
    propsJobFile: jobRelPath,
    concurrency: "1",
    frames: "0-9",
    timeoutMs: 1,
  });
  check("caso 10: con timeout de 1ms, se reporta timedOut=true (evidencia, no una excepción)", result.timedOut === true && result.completed === false);
  check("caso 10: no quedó ningún proceso descendiente vivo tras el corte por timeout", result.descendantProcessesAliveAfterCut === null || result.descendantProcessesAliveAfterCut === 0, `aliveCount=${result.descendantProcessesAliveAfterCut}`);
} catch (err) {
  check("caso 10 (render de diagnóstico, timeout corto): fallo inesperado en la prueba misma", false, String(err.message ?? err));
}

await fs.rm(FIXTURES_DIR, { recursive: true, force: true });

console.log(`\n[conclusión criterio 4 -- intento de reproducción] ${caso5Resultado}`);
console.log(failures === 0 ? "\nTODOS LOS TESTS DE OBSERVABILIDAD DE RENDER (REMOTION REAL) PASARON" : `\n${failures} TEST(S) FALLARON`);
process.exit(failures === 0 ? 0 : 1);
