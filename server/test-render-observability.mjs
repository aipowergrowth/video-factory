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

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCompositorFfmpeg, binaryEnv } from "./compositor.mjs";
import { runRemotionRender, RenderTimeoutError } from "./render-worker.mjs";

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

// --- Caso 2: timeout -- el mismo mecanismo de antes sigue funcionando tras la extracción ---
try {
  const jobRelPath = await makeJobFile("caso2", 6);
  const outputPath = path.join(FIXTURES_DIR, "caso2-out.mp4");
  let threw = null;
  try {
    await runRemotionRender({
      cwd: PROJECT_ROOT,
      env: process.env,
      outputPath,
      propsJobFile: jobRelPath,
      concurrency: "1",
      timeoutMs: 1, // garantiza el timeout de forma determinística
      onLog: () => {},
    });
  } catch (err) {
    threw = err;
  }
  check("caso 2: un timeout muy corto rechaza con RenderTimeoutError", threw instanceof RenderTimeoutError);
  check("caso 2: el mensaje menciona el límite de tiempo", /superó el límite/.test(threw?.message ?? ""));
} catch (err) {
  check("caso 2 (timeout): fallo inesperado en la prueba misma", false, String(err.message ?? err));
}

// --- Caso 3: cancelación -- isCancelled/makeCancelledError se respetan igual que antes ---
try {
  const jobRelPath = await makeJobFile("caso3", 6);
  const outputPath = path.join(FIXTURES_DIR, "caso3-out.mp4");
  class FakeCancelledError extends Error {}
  let cancelledFlag = false;
  let childRef = null;
  const renderPromise = runRemotionRender({
    cwd: PROJECT_ROOT,
    env: process.env,
    outputPath,
    propsJobFile: jobRelPath,
    concurrency: "1",
    timeoutMs: 60_000,
    onLog: () => {},
    registerChild: (child) => {
      childRef = child;
    },
    isCancelled: () => cancelledFlag,
    makeCancelledError: () => new FakeCancelledError("cancelado para la prueba"),
  });
  // Deja arrancar el proceso real un instante y lo cancela "desde afuera" -- mismo patrón que POST /jobs/:id/cancel en index.mjs.
  await new Promise((r) => setTimeout(r, 300));
  cancelledFlag = true;
  childRef?.kill("SIGTERM");

  let threw = null;
  try {
    await renderPromise;
  } catch (err) {
    threw = err;
  }
  check("caso 3: cancelar mientras corre rechaza con el error que da makeCancelledError (no un error genérico)", threw instanceof FakeCancelledError);
} catch (err) {
  check("caso 3 (cancelación): fallo inesperado en la prueba misma", false, String(err.message ?? err));
}

await fs.rm(FIXTURES_DIR, { recursive: true, force: true });

console.log(failures === 0 ? "\nTODOS LOS TESTS DE OBSERVABILIDAD DE RENDER (REMOTION REAL) PASARON" : `\n${failures} TEST(S) FALLARON`);
process.exit(failures === 0 ? 0 : 1);
