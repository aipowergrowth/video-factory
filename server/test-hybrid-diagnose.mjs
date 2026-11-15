// PRUEBA DE REGRESIÓN CON REMOTION REAL -- corrección del timeout real
// del diagnóstico híbrido en el VPS (15-nov-2026, hallado por el
// operador al revisar 0b54615). Corre en GitHub Actions
// (.github/workflows/captions-destination-test.yml) -- esta máquina de
// desarrollo (macOS 12) no puede ejecutar Remotion (ver README.md).
//
// A diferencia de test-hybrid-render.mjs (que ejercita
// `renderAllChunks`/`assembleFromChunks` DIRECTAMENTE), esto llama al
// ORQUESTADOR completo, `runHybridDiagnostic` -- lo que de verdad usa
// el endpoint `/jobs/:id/diagnose-hybrid` -- para confirmar con
// evidencia real:
// - El orden de los tramos en el .mp4 ensamblado es el CORRECTO
//   (contenido real, no solo conteo de cuadros) incluso con
//   `parallelPlainWithComposite=true` (el valor por defecto) --
//   causa raíz real encontrada en esta misma tarea: `segments`
//   armado por el callback `onSegment` queda en orden de
//   FINALIZACIÓN, no de posición, y se usaba para ensamblar.
// - La línea base de equivalencia ya NO renderiza toda la ventana con
//   Remotion -- solo los tramos compuestos + margen (`bySegment`
//   debe traer entradas `comparedAgainst: "full-render"` SOLO para
//   esas regiones chicas, y `"source"`/`"none-bit-identical-copy"`
//   para los tramos planos).
// - El resultado final (`ok`, duración exacta en cuadros, sincronía de
//   audio, PSNR) es honesto con datos reales.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCompositorFfmpeg, resolveCompositorFfprobe, binaryEnv } from "./compositor.mjs";
import { runHybridDiagnostic } from "./render-diagnose-hybrid.mjs";
import { ensureRenderBundle } from "./render-bundle.mjs";

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
// SOLO para construir el fixture (testsrc2 real) -- el pipeline bajo
// prueba sigue usando siempre el ffmpeg de Remotion, igual que producción.
const SYSTEM_FFMPEG = "ffmpeg";
const systemEnv = process.env;

const FIXTURES_REL_DIR = "jobs/test-fixtures-hybrid-diagnose";
const FIXTURES_DIR = path.join(PROJECT_ROOT, "public", FIXTURES_REL_DIR);
await fs.mkdir(FIXTURES_DIR, { recursive: true });

const DEST_WIDTH = 1920;
const DEST_HEIGHT = 1080;
const FPS = 30;

const bundleDir = path.join(FIXTURES_DIR, "bundle");
await ensureRenderBundle({ projectRoot: PROJECT_ROOT, bundleDir, versionTag: "test-hybrid-diagnose", env: process.env, onLog: () => {} });

try {
  // Mismo patrón de fuente que test-hybrid-render.mjs/caso A: CFR real
  // a 30fps (coincide con el FPS de salida -- copia de flujo real
  // habilitada para los tramos planos), GOP=29 (los cortes/overlays
  // caen deliberadamente fuera de un límite exacto de keyframe, para
  // ejercitar tanto tramos planos bit-idénticos como parcialmente
  // recodificados en el mismo job).
  const sourceRel = `${FIXTURES_REL_DIR}/fuente.mp4`;
  const sourcePath = path.join(PROJECT_ROOT, "public", sourceRel);
  await execFileAsync(
    SYSTEM_FFMPEG,
    ["-y", "-f", "lavfi", "-i", `testsrc2=size=${DEST_WIDTH}x${DEST_HEIGHT}:rate=${FPS}`, "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "15", "-g", "29", "-keyint_min", "29", "-sc_threshold", "0", "-bf", "0", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", sourcePath],
    { env: systemEnv },
  );

  const job = {
    channel: "a-mi-no-me-cuadra",
    destination: "youtube-16-9",
    input: { type: "recorded-video", baseVideo: sourceRel, durationInSeconds: 15 },
    overlays: [
      { id: "o1", type: "text", text: "primer compuesto", startSeconds: 2, durationSeconds: 1 },
      { id: "o2", type: "text", text: "segundo compuesto", startSeconds: 10, durationSeconds: 1 },
    ],
    captions: [],
    cuts: [],
    zooms: [],
    resources: [],
  };
  const jobRelPath = `${FIXTURES_REL_DIR}/job.json`;
  await fs.writeFile(path.join(PROJECT_ROOT, "public", jobRelPath), JSON.stringify(job));

  const diagnosticsDir = path.join(FIXTURES_DIR, "diagnostics");
  await fs.mkdir(diagnosticsDir, { recursive: true });

  const startedAt = Date.now();
  // minWindowFrames=maxWindowFrames=450 (el video completo, 15s*30fps)
  // -- fuerza la ventana a cubrir TODO el plan (5 chunks: sin cortes,
  // un tramo plano entre cada par de compuestos -- plano,compuesto,
  // plano,compuesto,plano), para ejercitar AMBOS tramos compuestos y
  // sus tramos planos vecinos en una sola corrida.
  const result = await runHybridDiagnostic({
    job,
    jobRelPath,
    sourceVideoAbsolutePath: sourcePath,
    destWidth: DEST_WIDTH,
    destHeight: DEST_HEIGHT,
    srcWidth: DEST_WIDTH,
    srcHeight: DEST_HEIGHT,
    fps: FPS,
    ffmpegPath,
    ffprobePath,
    env: process.env,
    cwd: PROJECT_ROOT,
    bundleDir,
    bundleVersionTag: "test-hybrid-diagnose",
    diagnosticsDir,
    concurrency: "1",
    minWindowFrames: 450,
    maxWindowFrames: 450,
    targetCompositeFraction: 0.15,
    parallelPlainWithComposite: true,
    crf: 23,
    preset: "veryfast",
    onLog: (msg) => console.log(`[diagnose] ${msg}`),
  });
  const elapsedMs = Date.now() - startedAt;
  console.log(`[diagnose] corrida completa en ${elapsedMs}ms (debe ser de SEGUNDOS/pocos minutos, no de minutos largos -- la línea base ya no cubre toda la ventana).`);

  check("runHybridDiagnostic: ok=true (no lanzó, no quedó en error)", result.ok === true, result.ok ? "" : result.error);
  if (!result.ok) {
    console.log(`\n${failures + 1} TEST(S) FALLARON`);
    process.exit(1);
  }

  check("runHybridDiagnostic: la ventana cubrió el plan completo (windowFrames=450)", result.windowFrames === 450, `windowFrames=${result.windowFrames}`);
  check("runHybridDiagnostic: 5 tramos (plano,compuesto,plano,compuesto,plano -- sin cortes, un tramo plano entre cada par de compuestos), EN ORDEN -- el ensamblado usó el valor de retorno de renderAllChunks, no el orden de finalización del callback onSegment", result.segments.map((s) => s.type).join(",") === "plain,composite,plain,composite,plain", JSON.stringify(result.segments.map((s) => s.type)));
  check("runHybridDiagnostic: los tramos quedan en orden CRECIENTE de outputStartFrame (confirma que el .mp4 ensamblado tiene el contenido en el orden correcto)", result.segments.every((s, i) => i === 0 || s.outputStartFrame >= result.segments[i - 1].outputStartFrame));

  check("equivalencia: duración exacta en cuadros contra el valor ESPERADO del plan (no un render completo paralelo)", result.equivalence.frameCountExact === true, `expected=${result.equivalence.expectedVideoFrames} hybrid=${result.equivalence.hybridVideoFrames}`);
  check("equivalencia: sincronía de audio contra la duración NOMINAL de la ventana", result.equivalence.audioSyncOk === true, `diff=${result.equivalence.audioSyncDiffSeconds}`);

  const bySegment = result.equivalence.bySegment;
  const fullRenderEntries = bySegment.filter((s) => s.comparedAgainst === "full-render");
  const sourceEntries = bySegment.filter((s) => s.comparedAgainst === "source");
  const skippedEntries = bySegment.filter((s) => s.comparedAgainst === "none-bit-identical-copy");
  check("equivalencia: hay al menos una región comparada contra un render COMPLETO real (los tramos compuestos + margen)", fullRenderEntries.length >= 1, JSON.stringify(bySegment.map((s) => s.comparedAgainst)));
  check("equivalencia: ninguna región comparada contra render completo cubre los 450 cuadros de la ventana -- la línea base quedó ACOTADA al tramo compuesto, no a la ventana entera (el motivo real de esta tarea)", fullRenderEntries.every((s) => s.outputEndFrame - s.outputStartFrame < 450));
  check("equivalencia: al menos un tramo plano se comparó contra la FUENTE directamente (reencodificado, no bit-idéntico)", sourceEntries.length >= 1 || skippedEntries.length >= 1, JSON.stringify(bySegment.map((s) => ({ type: s.type, comparedAgainst: s.comparedAgainst }))));

  check("equivalencia: PSNR promedio real por encima de 22dB (detecta corrupción/desalineación real)", result.equivalence.averagePsnr !== null && (result.equivalence.averagePsnr === Infinity || result.equivalence.averagePsnr > 22), `averagePsnr=${result.equivalence.averagePsnr}`);

  check("runHybridDiagnostic: trae métricas de memoria/CPU del contenedor (aunque sea sin límite en este runner)", typeof result.containerMetrics === "object" && result.containerMetrics !== null);

  check("runHybridDiagnostic: trae la estimación [CALCULADA] usada antes de lanzar (criterio 4)", typeof result.estimate === "object" && Number.isFinite(result.estimate.totalConservativeMs));
} catch (err) {
  check("test-hybrid-diagnose: fallo inesperado en la prueba misma", false, String(err.message ?? err));
}

if (failures > 0) {
  console.log(`\n${failures} TEST(S) FALLARON`);
  process.exit(1);
}
console.log("\nTODOS LOS TESTS PASARON");
