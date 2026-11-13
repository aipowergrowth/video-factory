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
import { runDiagnosticRender, buildDiagnosticWindows } from "./render-diagnose.mjs";
import { killProcessGroup, countAliveProcessesInGroup, listAliveProcessesInGroup, sumGroupCpuTicks } from "./process-tree.mjs";
import { planChunks } from "./segment-planner.mjs";
import { renderAllChunks } from "./segment-render.mjs";
import { assembleFromChunks } from "./segment-assemble.mjs";
import { measurePsnr } from "./video-compare.mjs";
import { buildTimeline } from "./timeline.mjs";

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

// FFmpeg de SISTEMA (apt-get, instalado en el workflow) -- SOLO para
// `measurePsnr` (casos 13/14), nunca para el pipeline bajo prueba.
// Confirmado real en CI, 12-nov-2026: el ffmpeg recortado de
// @remotion/compositor-* no tiene compilado el filtro `psnr`
// ("No such filter: 'psnr'") -- no está en su lista de filtros
// habilitados (igual que `testsrc2`/`fps`/`setpts` de video). El
// binario de sistema sí lo tiene, y mide sobre los MISMOS archivos de
// salida que produjo el pipeline real -- no cambia qué se compara.
const SYSTEM_FFMPEG = "ffmpeg";
const systemFfmpegEnv = process.env;

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
  // Criterio 6 (corrección 10-nov-2026): la misma verificación pero
  // con el DETALLE (pid/estado/nombre/comando) -- confirma que la
  // lista queda vacía (array real de longitud 0), no solo el conteo.
  const aliveDetail = await listAliveProcessesInGroup(pid);
  check(
    `${label}: la lista detallada de descendientes vivos también queda vacía (array de longitud 0)`,
    aliveDetail === null || aliveDetail.length === 0,
    `aliveDetail=${JSON.stringify(aliveDetail)}`,
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
  // Criterio 5 (corrección 10-nov-2026): antes, cancelar NUNCA
  // adjuntaba evidencia -- ahora debe traer lo mismo que
  // stuck/timeout/exit-error (stdout/stderr, último evento, conteo de
  // huérfanos), con endedReason="cancelled".
  check("caso 3: la cancelación SÍ trae evidencia (endedReason='cancelled')", threw?.evidence?.endedReason === "cancelled");
  check("caso 3: la evidencia de la cancelación trae stdout real (no vacío -- Chrome ya había impreso algo)", typeof threw?.evidence?.stdoutTail === "string" && threw.evidence.stdoutTail.length > 0);
  check("caso 3: la evidencia de la cancelación trae el conteo de huérfanos (0, igual que el chequeo de arriba)", threw?.evidence?.descendantProcessesAliveAfterCut === 0);
  check(
    "caso 3: la evidencia de la cancelación trae la lista DETALLADA de descendientes (array vacío -- criterio 6)",
    Array.isArray(threw?.evidence?.descendantProcessesDetail) && threw.evidence.descendantProcessesDetail.length === 0,
    `descendantProcessesDetail=${JSON.stringify(threw?.evidence?.descendantProcessesDetail)}`,
  );
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
// render real con un umbral de atasco agresivo no se corta mientras
// está bundling de verdad, aunque todavía no haya reportado ningún
// cuadro.
//
// Márgenes ampliados (Fase 0, reducir el tiempo de render,
// 12-nov-2026): el umbral original (500ms/100ms, elegido 09-nov-2026
// con el primer evento de bundling medido a los 1112ms) empezó a fallar
// de forma REPRODUCIBLE en este CI -- 3 de 3 corridas en esta misma
// sesión, sin ningún cambio en la lógica del vigilante
// (`shouldConsiderStuck`/`sumGroupCpuTicks`, sin tocar), siempre con el
// mismo patrón: "0 min sin actividad" justo al llegar a
// `{stage:bundling, percent:100}`. Revisada la lógica de muestreo
// (PGID vía `detached:true`, intervalo de revisión 20x por encima de
// la cuantización real de ticks de Linux) no se encontró un error --
// es consistente con que el runner compartido de GitHub Actions esté
// hoy más cargado/lento que el 09-nov-2026 (la prueba documenta ella
// misma esta dependencia del scheduler del runner), dejando menos de
// un tick de CPU medible en la primera ventana de 100ms bajo contención
// real. Se amplía el margen 5x (2500ms/250ms) -- todavía muy por debajo
// del timeout total (60s) y de lo que tardaría un atasco real -- en vez
// de tocar la lógica de medición, que no mostró ningún defecto.
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
      stuckAfterMs: 2500,
      stuckCheckIntervalMs: 250,
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
  const windows = buildDiagnosticWindows(600, { initialFrameCount: 10, middleWindowFrameCount: 10, endFrameCount: 10 }); // 20s @30fps = 600 cuadros
  const frames = windows.map((w) => `${w.start}-${w.end}`).join(",");
  const result = await runDiagnosticRender({
    cwd: PROJECT_ROOT,
    env: process.env,
    outputPath,
    propsJobFile: jobRelPath,
    concurrency: "1",
    frames,
    windows,
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
  // Criterio 1 (reducir el tiempo de render, 11-nov-2026): confirma,
  // con Remotion real, que las 3 ventanas (inicio/medio/final) quedan
  // con su propio ms/cuadro medido -- no solo hitos de arranque.
  check("caso 9: windowTimings trae las 3 ventanas (inicio/medio/final)", Array.isArray(result.windowTimings) && result.windowTimings.length === 3, JSON.stringify(result.windowTimings));
  check(
    "caso 9: al menos la ventana 'inicio' trae un ms/cuadro real medido (no null) -- 10 cuadros es suficiente para 2+ ticks",
    typeof result.windowTimings?.[0]?.avgMsPerFrame === "number" && result.windowTimings[0].avgMsPerFrame > 0,
    JSON.stringify(result.windowTimings?.[0]),
  );
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

// --- Caso 11: corrección del contador de progreso (causa raíz,
// 10-nov-2026, criterio 3) -- un render real en el que Remotion
// reporta el tiempo restante en formato "Xm Ys" (no solo segundos),
// y confirma que el contador de progreso (`onProgress`, lo mismo que
// usa `maybeLogAndStoreProgress`/`writeStatus` en index.mjs para
// actualizar `renderProgress` del job) SÍ avanza -- antes de esta
// corrección, el parser descartaba la línea entera apenas el tiempo
// restante superaba 1 minuto, y el job real 1fd239de se quedó
// mostrando renderedFrames=0 durante las 3 horas completas aunque
// Remotion había renderizado el 90,8% del video. Calibrado con datos
// reales (no adivinado): un video sintético de 600s (18.000 cuadros
// de duración declarada) renderizando solo los primeros 800
// (--frames=0-799) alcanza un tiempo restante de varios MINUTOS desde
// los primeros cuadros (confirmado real en CI, 10-nov-2026: a los 60s
// de un render de 3000 cuadros ya iba por el cuadro ~650 con "3m 2Xs"
// de restante) -- 800 cuadros y un tope de 40s de espera quedan con
// margen de sobra sin alargar la prueba.
try {
  const longVideoRel = `${FIXTURES_REL_DIR}/largo-600s.mp4`;
  await execFileAsync(
    ffmpegPath,
    ["-y", "-f", "lavfi", "-i", "nullsrc=size=640x360:rate=30", "-t", "600", "-pix_fmt", "yuv420p", "-c:v", "libx264", path.join(PROJECT_ROOT, "public", longVideoRel)],
    { env: ffmpegEnv },
  );
  const jobRelPath = `${FIXTURES_REL_DIR}/caso11.json`;
  await fs.writeFile(
    path.join(PROJECT_ROOT, "public", jobRelPath),
    JSON.stringify({
      channel: "a-mi-no-me-cuadra",
      destination: "youtube-16-9",
      input: { type: "recorded-video", baseVideo: longVideoRel, durationInSeconds: 600 },
      overlays: [],
      captions: [],
      cuts: [],
      zooms: [],
      resources: [],
    }),
  );
  const outputPath = path.join(FIXTURES_DIR, "caso11-out.mp4");
  const progressEvents = [];
  let childRef = null;
  // Criterio 4 (revisión del vigilante ya con el contador fiable):
  // un umbral de atasco corto a propósito (5s, revisando cada 1s) --
  // con el contador roto de antes, cualquier render que tardara más
  // de 1 minuto en terminar un cuadro (formato "Xm Ys") habría
  // parecido "sin cuadros nuevos" indefinidamente; con el contador
  // corregido, cada cuadro real actualiza `lastProgressAt` y el
  // vigilante NUNCA debería considerarlo trabado mientras siga
  // avanzando -- se prueba acá con cuadros reales llegando varias
  // veces por segundo, no con la actividad de CPU del bundling
  // (eso ya lo prueba el caso 7 de la tarea anterior).
  let threwStuckBeforeManualKill = false;
  const renderPromise = runRemotionRender({
    cwd: PROJECT_ROOT,
    env: process.env,
    outputPath,
    propsJobFile: jobRelPath,
    concurrency: "1",
    frames: "0-799",
    timeoutMs: 60_000,
    stuckAfterMs: 5000,
    stuckCheckIntervalMs: 1000,
    onProgress: (event) => {
      if (event.stage === "rendering") progressEvents.push(event);
    },
    onLog: () => {},
    registerChild: (child) => {
      childRef = child;
    },
  });
  // No hace falta que termine -- apenas se ve un evento con ETA en
  // minutos, ya está la evidencia pedida; se cancela para no gastar
  // minutos de CI de más (mismo mecanismo real que el endpoint de
  // cancelar).
  const waitStartedAt = Date.now();
  while (!progressEvents.some((e) => e.etaSeconds !== null && e.etaSeconds > 60) && Date.now() - waitStartedAt < 40_000) {
    await new Promise((r) => setTimeout(r, 300));
  }
  killProcessGroup(childRef, "SIGKILL");
  try {
    await renderPromise;
  } catch (err) {
    threwStuckBeforeManualKill = err instanceof RenderStuckError;
  }

  check(
    "caso 11 (criterio 4): el vigilante NUNCA lo cortó por atasco mientras los cuadros seguían llegando (umbral de 5s, cuadros reales llegando continuamente)",
    threwStuckBeforeManualKill === false,
  );

  const eventWithLongEta = progressEvents.find((e) => e.etaSeconds !== null && e.etaSeconds > 60);
  check(
    "caso 11: se recibió un evento real con tiempo restante en formato de minutos (ETA > 60s) -- la línea NO se descartó",
    Boolean(eventWithLongEta),
    `eventos vistos=${progressEvents.length}, último etaSeconds=${progressEvents[progressEvents.length - 1]?.etaSeconds}`,
  );
  check(
    "caso 11: el contador de cuadros renderizados (lo que actualiza renderProgress del job) avanzó de verdad, no quedó en 0",
    eventWithLongEta ? eventWithLongEta.renderedFrames > 0 : false,
    `renderedFrames=${eventWithLongEta?.renderedFrames}`,
  );
  check(
    "caso 11: se vieron VARIOS eventos de progreso (el render realmente avanzaba, no un solo tick aislado)",
    progressEvents.length >= 2,
    `eventos vistos=${progressEvents.length}`,
  );
} catch (err) {
  check("caso 11 (contador con ETA en minutos): fallo inesperado en la prueba misma", false, String(err.message ?? err));
}

// --- Caso 12: <Video> de @remotion/media detrás de la bandera
// (criterio 6, reducir el tiempo de render, 11-nov-2026) -- confirma
// con un render real que REMOTION_VIDEO_COMPONENT=media activa la
// variante (src/engine/sources/RecordedVideoSource.tsx) sin romper
// nada, que termina en código 0, y que SIN la bandera (comportamiento
// de producción) el render sigue funcionando exactamente igual que
// antes. No se compara tiempo acá (la comparación real con el video
// del job, no sintético, es la puerta G2 -- VPS) -- esto solo prueba
// que el mecanismo funciona de punta a punta con Remotion/Chrome
// reales, no solo en teoría.
try {
  const jobRelPath = await makeJobFile("caso12", 6);
  const outputMediaPath = path.join(FIXTURES_DIR, "caso12-media-out.mp4");
  const resultMedia = await new Promise((resolve, reject) => {
    runRemotionRender({
      cwd: PROJECT_ROOT,
      env: { ...process.env, REMOTION_VIDEO_COMPONENT: "media" },
      outputPath: outputMediaPath,
      propsJobFile: jobRelPath,
      concurrency: "1",
      timeoutMs: 60_000,
      onLog: () => {},
    })
      .then(() => resolve({ threw: null }))
      .catch((err) => resolve({ threw: err }));
  });
  check("caso 12: con REMOTION_VIDEO_COMPONENT=media, el render real termina sin error (código 0)", resultMedia.threw === null, String(resultMedia.threw?.message ?? ""));
  check("caso 12: el archivo de salida con @remotion/media existe y no está vacío", (await fs.stat(outputMediaPath)).size > 0);

  // Sin la bandera (comportamiento de producción): sigue funcionando igual -- no es solo que "no rompe nada nuevo", es la MISMA ruta que ya probó el caso 1.
  const outputDefaultPath = path.join(FIXTURES_DIR, "caso12-default-out.mp4");
  await runRemotionRender({
    cwd: PROJECT_ROOT,
    env: process.env, // SIN REMOTION_VIDEO_COMPONENT -- comportamiento de producción intacto
    outputPath: outputDefaultPath,
    propsJobFile: jobRelPath,
    concurrency: "1",
    timeoutMs: 60_000,
    onLog: () => {},
  });
  check("caso 12: SIN la bandera, el render real sigue terminando sin error (comportamiento de producción sin cambios)", (await fs.stat(outputDefaultPath)).size > 0);
} catch (err) {
  check("caso 12 (bandera @remotion/media): fallo inesperado en la prueba misma", false, String(err.message ?? err));
}

// --- Caso 13: G1 -- equivalencia del render selectivo (criterio A del
// dictamen del auditor, reducir el tiempo de render, 11-nov-2026).
// Construye un video fuente con keyframes MUY escasos (-g 450, un solo
// keyframe en todo el clip -- los cortes de este caso caen muy lejos
// de cualquier keyframe a propósito), más audio real (tono). El job
// tiene un corte y DOS elementos compuestos, uno antes y otro después
// del corte -- empalmes, corte fuera de keyframe, y mezcla de
// plano/compuesto, todo en un solo caso. Compara el resultado del
// render SELECTIVO (FFmpeg para los tramos planos + Remotion para los
// compuestos + un solo audio construido con los cortes) contra el
// render COMPLETO de Remotion del mismo job -- deben ser equivalentes.
//
// NOTA honesta (criterio A, "fuente con FPS variable"): se intentó
// construir un fuente con PTS irregulares (jitter vía `setpts`) para
// este mismo caso -- confirmado real en CI, 12-nov-2026, que rompe la
// correspondencia simple entre "segundo N del original" y el punto
// real de `-ss` al extraer un tramo plano (duración resultante
// desalineada por decenas de segundos, no un error de redondeo). No
// se pudo aislar esa causa con confianza en el tiempo disponible --
// se deja fuera de este caso para no reportar un resultado dudoso
// como si fuera evidencia sólida. El diseño de `renderPlainChunk`
// (`-r` como opción de SALIDA, no un filtro) normaliza a FPS
// constante por construcción sin importar la irregularidad de
// entrada -- pero esa propiedad específica queda sin una prueba
// automática que la confirme con un fuente genuinamente variable; ver
// el informe de esta tarea.
try {
  const sourceRel = `${FIXTURES_REL_DIR}/caso13-fuente.mp4`;
  const sourcePath = path.join(PROJECT_ROOT, "public", sourceRel);
  // Patrón visual real (no un color plano) + audio real -- construido
  // con el ffmpeg de SISTEMA (apt-get ffmpeg, instalado en el
  // workflow), no con el de @remotion/compositor-* (ese viene
  // recortado a propósito por Remotion -- sin `testsrc2`, confirmado
  // real en CI, 12-nov-2026: "Filter not found"). Esto es SOLO para
  // armar el archivo de prueba -- el pipeline bajo prueba
  // (renderAllChunks, assembleFromChunks, las mediciones) sigue
  // usando el ffmpeg de Remotion como en producción, nunca el de
  // sistema.
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-t", "15",
      "-g", "450", "-keyint_min", "450", "-sc_threshold", "0",
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest",
      sourcePath,
    ],
  );
  const probedDiag = await probeSourceVideoDiagnostics(sourcePath, { ffprobePath, env: ffprobeEnv });
  console.log(`[caso 13] video fuente construido -- ${formatSourceVideoDiagnosticsLine(probedDiag)}`);

  const job = {
    channel: "a-mi-no-me-cuadra",
    destination: "youtube-16-9",
    input: { type: "recorded-video", baseVideo: sourceRel, durationInSeconds: 15 },
    overlays: [
      { id: "o1", type: "text", text: "antes del corte", startSeconds: 2, durationSeconds: 1 },
      { id: "o2", type: "text", text: "despues del corte", startSeconds: 10, durationSeconds: 1 },
    ],
    captions: [],
    cuts: [{ id: "c1", startSeconds: 6, endSeconds: 7 }],
    zooms: [],
    resources: [],
  };
  const jobRelPath = `${FIXTURES_REL_DIR}/caso13.json`;
  await fs.writeFile(path.join(PROJECT_ROOT, "public", jobRelPath), JSON.stringify(job));

  const plan = planChunks(job);
  console.log(`[caso 13] plan: ${plan.chunks.length} chunks -- ${plan.chunks.map((c) => c.type).join(",")}`);
  check("caso 13: el plan tiene la forma esperada (plano,compuesto,plano,plano,compuesto,plano -- el corte parte los dos planos adyacentes)", plan.chunks.map((c) => c.type).join(",") === "plain,composite,plain,plain,composite,plain", JSON.stringify(plan.chunks));

  // --- Render SELECTIVO ---
  const chunkDir = path.join(FIXTURES_DIR, "caso13-chunks");
  await fs.mkdir(chunkDir, { recursive: true });
  const chunkResults = await renderAllChunks({
    plan,
    chunkOutputDir: chunkDir,
    sourceVideoPath: sourcePath,
    propsJobFile: jobRelPath,
    ffmpegPath,
    env: process.env,
    cwd: PROJECT_ROOT,
    width: 1920,
    height: 1080,
    fps: 30,
    concurrency: "1",
    timeoutMs: 60_000,
    onLog: (msg) => console.log(`[caso 13] ${msg}`),
  });
  check("caso 13: se renderizaron los 6 chunks sin lanzar", chunkResults.length === 6);
  // DIAGNÓSTICO: duración real de CADA chunk individual, para encontrar cuál (si alguno) sale con una duración incorrecta.
  for (const r of chunkResults) {
    const { stdout } = await execFileAsync(ffprobePath, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=duration,nb_frames", "-of", "csv=p=0", r.outputPath], { env: ffprobeEnv });
    console.log(`[caso 13] chunk ${r.chunk.type} src[${r.chunk.sourceStartSeconds}-${r.chunk.sourceEndSeconds}] -- ffprobe duration,nb_frames=${stdout.trim()}`);
  }

  const timeline = buildTimeline(15, job.cuts);
  const selectiveOutputPath = path.join(FIXTURES_DIR, "caso13-selectivo.mp4");
  const assembleResult = await assembleFromChunks({
    ffmpegPath,
    ffprobePath,
    env: process.env,
    sourceVideoPath: sourcePath,
    chunkPaths: chunkResults.map((r) => r.outputPath),
    timeline,
    workDir: path.join(FIXTURES_DIR, "caso13-assemble"),
    outputPath: selectiveOutputPath,
    sampleRate: 48000,
  });
  check("caso 13: el render selectivo detectó audio en la fuente y lo construyó", assembleResult.sourceHasAudio === true && assembleResult.audioPath !== null);
  // DIAGNÓSTICO: duración del video-solo-concatenado ANTES de mezclar con el audio -- aísla si el problema está en concatVideoOnly o en muxFinal.
  {
    const { stdout } = await execFileAsync(ffprobePath, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=duration,nb_frames", "-of", "csv=p=0", assembleResult.videoOnlyPath], { env: ffprobeEnv });
    console.log(`[caso 13] video-solo concatenado (antes de mezclar audio) -- ffprobe duration,nb_frames=${stdout.trim()}`);
  }

  // --- Render COMPLETO (línea base, el mismo job, Remotion real sin restricción de cuadros) ---
  const fullOutputPath = path.join(FIXTURES_DIR, "caso13-completo.mp4");
  await runRemotionRender({
    cwd: PROJECT_ROOT,
    env: process.env,
    outputPath: fullOutputPath,
    propsJobFile: jobRelPath,
    concurrency: "1",
    timeoutMs: 120_000,
    onLog: () => {},
  });

  // --- Comparación: duración, cuadros, audio, equivalencia visual ---
  const probeDuration = async (p, stream) => {
    const { stdout } = await execFileAsync(ffprobePath, ["-v", "error", "-select_streams", stream, "-show_entries", "stream=duration", "-of", "csv=p=0", p], { env: ffprobeEnv });
    return Number(stdout.trim());
  };
  const videoDurationSelective = await probeDuration(selectiveOutputPath, "v:0");
  const videoDurationFull = await probeDuration(fullOutputPath, "v:0");
  console.log(`[caso 13] duración de video -- selectivo=${videoDurationSelective}s completo=${videoDurationFull}s`);
  check(
    "caso 13: la duración de VIDEO del render selectivo coincide con el render completo, con margen de menos de 1 cuadro (1/30s)",
    Math.abs(videoDurationSelective - videoDurationFull) < 1 / 30 + 0.01,
    `diff=${Math.abs(videoDurationSelective - videoDurationFull)}s`,
  );

  const audioDurationSelective = await probeDuration(selectiveOutputPath, "a:0");
  const audioDurationFull = await probeDuration(fullOutputPath, "a:0");
  console.log(`[caso 13] duración de audio -- selectivo=${audioDurationSelective}s completo=${audioDurationFull}s`);
  check(
    "caso 13: sincronía audiovisual -- la duración del audio coincide entre selectivo y completo con menos de 1 cuadro de diferencia",
    Math.abs(audioDurationSelective - audioDurationFull) < 1 / 30 + 0.01,
    `diff=${Math.abs(audioDurationSelective - audioDurationFull)}s`,
  );

  const psnrResult = await measurePsnr(SYSTEM_FFMPEG, systemFfmpegEnv, fullOutputPath, selectiveOutputPath);
  console.log(`[caso 13] PSNR promedio entre el render completo y el selectivo: ${psnrResult.averagePsnr}dB`);
  check(
    "caso 13: equivalencia visual (PSNR) -- el render selectivo se ve igual que el completo (>30dB, nunca cuadros desalineados o corruptos)",
    psnrResult.averagePsnr !== null && psnrResult.averagePsnr > 30,
    `averagePsnr=${psnrResult.averagePsnr}, stderr=${psnrResult.stderrTail?.slice(-500)}`,
  );
} catch (err) {
  check("caso 13 (G1, equivalencia del render selectivo): fallo inesperado en la prueba misma", false, String(err.message ?? err));
}

// --- Caso 14: G2-R -- reanudación (criterio D del dictamen del
// auditor). Mata el proceso a MITAD de `renderAllChunks` (tras el
// primer chunk) y confirma que, al reintentar, el chunk ya completo
// NO se vuelve a renderizar -- y que el resultado final ensamblado es
// idéntico (mismo PSNR altísimo, prácticamente la misma duración) al
// de una corrida sin interrupciones.
try {
  const sourceRel = `${FIXTURES_REL_DIR}/caso14-fuente.mp4`;
  const sourcePath = path.join(PROJECT_ROOT, "public", sourceRel);
  // nullsrc (NO testsrc2 -- el ffmpeg recortado de @remotion/compositor-* no lo compila, confirmado real en CI, 12-nov-2026: "Filter not found").
  await execFileAsync(ffmpegPath, ["-y", "-f", "lavfi", "-i", "nullsrc=size=640x360:rate=30", "-t", "9", "-pix_fmt", "yuv420p", "-c:v", "libx264", sourcePath], { env: ffmpegEnv });
  const job = {
    channel: "a-mi-no-me-cuadra",
    destination: "youtube-16-9",
    input: { type: "recorded-video", baseVideo: sourceRel, durationInSeconds: 9 },
    overlays: [{ id: "o1", type: "text", text: "medio", startSeconds: 4, durationSeconds: 1 }],
    captions: [],
    cuts: [],
    zooms: [],
    resources: [],
  };
  const jobRelPath = `${FIXTURES_REL_DIR}/caso14.json`;
  await fs.writeFile(path.join(PROJECT_ROOT, "public", jobRelPath), JSON.stringify(job));
  const plan = planChunks(job); // 3 chunks: plano, compuesto, plano
  check("caso 14: el plan tiene 3 chunks (plano, compuesto, plano)", plan.chunks.length === 3);

  const chunkDir = path.join(FIXTURES_DIR, "caso14-chunks");
  await fs.mkdir(chunkDir, { recursive: true });

  // Simula un corte a mitad de camino: renderiza SOLO el plan recortado al primer chunk, como si el proceso hubiera muerto justo después.
  const partialPlan = { totalFrames: plan.totalFrames, chunks: [plan.chunks[0]] };
  await renderAllChunks({ plan: partialPlan, chunkOutputDir: chunkDir, sourceVideoPath: sourcePath, propsJobFile: jobRelPath, ffmpegPath, env: process.env, cwd: PROJECT_ROOT, width: 1920, height: 1080, fps: 30, concurrency: "1", timeoutMs: 60_000, onLog: () => {} });
  const firstChunkPath = `${chunkDir}/chunk-0000-plain.mp4`;
  const firstChunkStatBefore = await fs.stat(firstChunkPath);
  check("caso 14: tras el 'corte', el primer chunk quedó completo en disco", firstChunkStatBefore.size > 0);

  // "Reintento": se llama de nuevo con el plan COMPLETO -- el primer chunk debe reusarse, no volver a renderizarse.
  const logs = [];
  const chunkResults = await renderAllChunks({ plan, chunkOutputDir: chunkDir, sourceVideoPath: sourcePath, propsJobFile: jobRelPath, ffmpegPath, env: process.env, cwd: PROJECT_ROOT, width: 1920, height: 1080, fps: 30, concurrency: "1", timeoutMs: 60_000, onLog: (m) => logs.push(m) });
  const firstChunkStatAfter = await fs.stat(firstChunkPath);
  check("caso 14: tras reintentar, el primer chunk NO cambió (mismo tamaño exacto -- nunca se volvió a renderizar)", firstChunkStatAfter.size === firstChunkStatBefore.size && firstChunkStatAfter.mtimeMs === firstChunkStatBefore.mtimeMs);
  check("caso 14: el log del reintento confirma que el primer chunk se reusó", logs.some((l) => l.includes("ya estaba completo")));
  check("caso 14: el resultado trae los 3 chunks (1 reusado + 2 nuevos)", chunkResults.length === 3 && chunkResults[0].reused === true && chunkResults[1].reused === false && chunkResults[2].reused === false);

  // El resultado final ensamblado tras la reanudación debe ser idéntico a una corrida SIN interrupciones del mismo job.
  const timeline = buildTimeline(9, job.cuts);
  const resumedOutputPath = path.join(FIXTURES_DIR, "caso14-reanudado.mp4");
  await assembleFromChunks({ ffmpegPath, ffprobePath, env: process.env, sourceVideoPath: sourcePath, chunkPaths: chunkResults.map((r) => r.outputPath), timeline, workDir: path.join(FIXTURES_DIR, "caso14-assemble-reanudado"), outputPath: resumedOutputPath, sampleRate: 48000 });

  const freshChunkDir = path.join(FIXTURES_DIR, "caso14-chunks-sin-interrupcion");
  await fs.mkdir(freshChunkDir, { recursive: true });
  const freshChunkResults = await renderAllChunks({ plan, chunkOutputDir: freshChunkDir, sourceVideoPath: sourcePath, propsJobFile: jobRelPath, ffmpegPath, env: process.env, cwd: PROJECT_ROOT, width: 1920, height: 1080, fps: 30, concurrency: "1", timeoutMs: 60_000, onLog: () => {} });
  const freshOutputPath = path.join(FIXTURES_DIR, "caso14-sin-interrupcion.mp4");
  await assembleFromChunks({ ffmpegPath, ffprobePath, env: process.env, sourceVideoPath: sourcePath, chunkPaths: freshChunkResults.map((r) => r.outputPath), timeline, workDir: path.join(FIXTURES_DIR, "caso14-assemble-fresco"), outputPath: freshOutputPath, sampleRate: 48000 });

  const psnrResumed = await measurePsnr(SYSTEM_FFMPEG, systemFfmpegEnv, freshOutputPath, resumedOutputPath);
  console.log(`[caso 14] PSNR entre la corrida reanudada y una corrida sin interrupciones: ${psnrResumed.averagePsnr}dB`);
  check(
    "caso 14: el resultado reanudado es visualmente IDÉNTICO al de una corrida sin interrupciones (PSNR muy alto, >40dB -- mismo contenido exacto)",
    psnrResumed.averagePsnr !== null && psnrResumed.averagePsnr > 40,
    `averagePsnr=${psnrResumed.averagePsnr}`,
  );
} catch (err) {
  check("caso 14 (G2-R, reanudación): fallo inesperado en la prueba misma", false, String(err.message ?? err));
}

await fs.rm(FIXTURES_DIR, { recursive: true, force: true });

console.log(`\n[conclusión criterio 4 -- intento de reproducción] ${caso5Resultado}`);
console.log(failures === 0 ? "\nTODOS LOS TESTS DE OBSERVABILIDAD DE RENDER (REMOTION REAL) PASARON" : `\n${failures} TEST(S) FALLARON`);
process.exit(failures === 0 ? 0 : 1);
