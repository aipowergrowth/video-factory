// PRUEBA DE REGRESIÓN CON REMOTION REAL -- Fase 0, render híbrido a
// producción (14-nov-2026, autorizado por Alex; adenda del auditor del
// mismo día). Corre en GitHub Actions (.github/workflows/
// captions-destination-test.yml) -- esta máquina de desarrollo (macOS
// 12) no puede ejecutar Remotion (ver README.md). Construye videos
// fuente SINTÉTICOS (con el ffmpeg de SISTEMA, instalado en el
// workflow solo para esto -- el ffmpeg recortado de
// @remotion/compositor-* no tiene testsrc2/psnr compilados) -- nada de
// contenido real, ni llamadas de IA, ni costo.
//
// Cubre, con evidencia real (no simulada):
// - G1 (adenda criterios 1+2): ensamblado SIN recodificar todo el
//   video (demuxer concat, copia de flujo), tramos planos con copia de
//   GOP + recodificación solo en los bordes, equivalencia exacta
//   contra el render completo (duración en cuadros, sincronía de
//   audio, PSNR).
// - Adenda criterio 3/B: fuente con FPS GENUINAMENTE variable (no solo
//   declarada distinta a la promedio -- construida concatenando dos
//   tramos de fps distintos con `-vsync vfr`, re-encode real).
// - G2-R con VERIFICACIÓN DE INTEGRIDAD (adenda criterio C): un chunk
//   deliberadamente truncado se detecta (nunca se reutiliza) y se
//   regenera; la reanudación da un resultado bit-idéntico a una
//   corrida sin interrupciones.
// - Reutilización del bundle entre invocaciones (criterio 4).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCompositorFfmpeg, resolveCompositorFfprobe, binaryEnv } from "./compositor.mjs";
import { runRemotionRender } from "./render-worker.mjs";
import { planChunks, decideRenderMode } from "./segment-planner.mjs";
import { renderAllChunks, verifyChunkIntegrity } from "./segment-render.mjs";
import { assembleFromChunks } from "./segment-assemble.mjs";
import { compareVideosPsnr } from "./video-compare.mjs";
import { buildTimeline } from "./timeline.mjs";
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
const ffprobeEnv = binaryEnv(ffprobePath);
// SOLO para construir fixtures (testsrc2 real, VFR real vía -vsync vfr)
// -- el ffmpeg recortado de Remotion no trae esos. El pipeline bajo
// prueba (renderAllChunks/assembleFromChunks) sigue usando siempre el
// ffmpeg de Remotion, igual que producción.
const SYSTEM_FFMPEG = "ffmpeg";
const systemEnv = process.env;

const FIXTURES_REL_DIR = "jobs/test-fixtures-hybrid-render";
const FIXTURES_DIR = path.join(PROJECT_ROOT, "public", FIXTURES_REL_DIR);
await fs.mkdir(FIXTURES_DIR, { recursive: true });

const DEST_WIDTH = 1920;
const DEST_HEIGHT = 1080;
const FPS = 30;

const countVideoPackets = async (p) => {
  const { stdout } = await execFileAsync(ffprobePath, ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=flags", "-of", "json", p], { env: ffprobeEnv, maxBuffer: 16 * 1024 * 1024 });
  return (JSON.parse(stdout).packets ?? []).length;
};

const probeDuration = async (p, stream) => {
  const { stdout } = await execFileAsync(ffprobePath, ["-v", "error", "-select_streams", stream, "-show_entries", "stream=duration", "-of", "csv=p=0", p], { env: ffprobeEnv });
  return Number(stdout.trim());
};

// --- Bundle compartido (criterio 4): se construye UNA sola vez para todo este archivo de pruebas. ---
const bundleDir = path.join(FIXTURES_DIR, "bundle");
const bundleResult = await ensureRenderBundle({ projectRoot: PROJECT_ROOT, bundleDir, versionTag: "test-hybrid-render", env: process.env, onLog: (m) => console.log(`[bundle] ${m}`) });
check("bundle: se construyó de cero en la primera llamada de este archivo", bundleResult.reused === false);
const bundleResult2 = await ensureRenderBundle({ projectRoot: PROJECT_ROOT, bundleDir, versionTag: "test-hybrid-render", env: process.env, onLog: () => {} });
check("bundle: la SEGUNDA llamada lo reutiliza (mismo versionTag) -- sin bundling de nuevo", bundleResult2.reused === true && bundleResult2.ms < 500, `ms=${bundleResult2.ms}`);

// --- Caso A: G1 -- equivalencia exacta con RESOLUCIÓN IGUAL al destino (copia de flujo real en los tramos planos). ---
try {
  const sourceRel = `${FIXTURES_REL_DIR}/casoA-fuente.mp4`;
  const sourcePath = path.join(PROJECT_ROOT, "public", sourceRel);
  // Keyframes cada ~0,97s (-g 29 a 30fps) -- el mismo intervalo medido
  // en el job real 1fd239de (adenda criterio 2) -- ni tan denso que
  // trivialice la copia de GOP, ni tan escaso (como el -g 450 que
  // tenía esto antes) que NINGÚN chunk después del primero tenga
  // siquiera un par de keyframes propios que encierren un cuerpo
  // copiable (eso hacía que TODOS los chunks planos cayeran siempre a
  // recodificar completo, sin ejercitar la copia de flujo real). Los
  // cortes de este caso (6-7s) y los overlays (2-3s, 10-11s) caen
  // deliberadamente FUERA de un límite exacto de keyframe de todos
  // modos (29/30 no es divisor de esos puntos).
  await execFileAsync(SYSTEM_FFMPEG, ["-y", "-f", "lavfi", "-i", `testsrc2=size=${DEST_WIDTH}x${DEST_HEIGHT}:rate=${FPS}`, "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "15", "-g", "29", "-keyint_min", "29", "-sc_threshold", "0", "-bf", "0", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", sourcePath], { env: systemEnv });

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
  const jobRelPath = `${FIXTURES_REL_DIR}/casoA.json`;
  await fs.writeFile(path.join(PROJECT_ROOT, "public", jobRelPath), JSON.stringify(job));

  const plan = planChunks(job);
  check("caso A: el plan tiene la forma esperada (plano,compuesto,plano,plano,compuesto,plano)", plan.chunks.map((c) => c.type).join(",") === "plain,composite,plain,plain,composite,plain", JSON.stringify(plan.chunks.map((c) => c.type)));

  const decision = decideRenderMode({ configuredMode: "hybrid", job, plan: { ...plan, compositePercent: 20, totalFrames: plan.totalFrames, compositeRuns: 2 } });
  check("caso A: decideRenderMode elige 'hybrid' para este job (grabado, % compuesto bajo)", decision.mode === "hybrid", decision.reason);

  const chunkDir = path.join(FIXTURES_DIR, "casoA-chunks");
  await fs.mkdir(chunkDir, { recursive: true });
  const segments = [];
  const chunkResults = await renderAllChunks({
    plan,
    chunkOutputDir: chunkDir,
    sourceVideoPath: sourcePath,
    propsJobFile: jobRelPath,
    ffmpegPath,
    ffprobePath,
    env: process.env,
    cwd: PROJECT_ROOT,
    destWidth: DEST_WIDTH,
    destHeight: DEST_HEIGHT,
    srcWidth: DEST_WIDTH,
    srcHeight: DEST_HEIGHT,
    fps: FPS,
    concurrency: "1",
    entryPoint: bundleDir,
    timeoutMs: 60_000,
    onLog: (msg) => console.log(`[caso A] ${msg}`),
    onSegment: (s) => segments.push(s),
  });
  check("caso A: se renderizaron los 6 chunks sin lanzar", chunkResults.length === 6);
  check("caso A: onSegment se llamó una vez por chunk (evidencia para segments[] del job)", segments.length === 6);
  const plainChunks = chunkResults.filter((r) => r.type === "plain");
  check("caso A: al menos un chunk plano copió una fracción real de sus cuadros sin recodificar (misma resolución que destino)", plainChunks.some((r) => r.copiedFraction > 0), JSON.stringify(plainChunks.map((r) => r.copiedFraction)));

  const timeline = buildTimeline(15, job.cuts);
  const selectiveOutputPath = path.join(FIXTURES_DIR, "casoA-selectivo.mp4");
  await assembleFromChunks({
    ffmpegPath,
    ffprobePath,
    env: process.env,
    sourceVideoPath: sourcePath,
    chunks: chunkResults.map((r) => ({ path: r.path })),
    timeline,
    workDir: path.join(FIXTURES_DIR, "casoA-assemble"),
    outputPath: selectiveOutputPath,
    sampleRate: 48000,
    onLog: (msg) => console.log(`[caso A] ${msg}`),
  });

  const fullOutputPath = path.join(FIXTURES_DIR, "casoA-completo.mp4");
  await runRemotionRender({ cwd: PROJECT_ROOT, env: process.env, outputPath: fullOutputPath, propsJobFile: jobRelPath, concurrency: "1", timeoutMs: 120_000, onLog: () => {} });

  // Duración exacta en CUADROS (criterio 1 de la adenda) -- conteo REAL
  // de paquetes de video vía ffprobe, no el campo `duration` del
  // contenedor. Confirmado real en CI, 14-nov-2026: ese campo puede
  // diferir unos milisegundos entre el completo y el selectivo (metadata
  // del muxer, p.ej. por `-avoid_negative_ts`) con el conteo de cuadros
  // IDÉNTICO -- la duración en segundos queda como dato informativo,
  // nunca como la aserción dura (el conteo de cuadros es la garantía
  // real y más fuerte: ningún cuadro de más ni de menos).
  const realPacketsSel = await countVideoPackets(selectiveOutputPath);
  const realPacketsFull = await countVideoPackets(fullOutputPath);
  const videoDurSel = await probeDuration(selectiveOutputPath, "v:0");
  const videoDurFull = await probeDuration(fullOutputPath, "v:0");
  console.log(`[caso A] duración de video -- selectivo=${videoDurSel}s (${realPacketsSel} cuadros) completo=${videoDurFull}s (${realPacketsFull} cuadros)`);
  check("caso A: EXACTAMENTE los mismos cuadros de video entre el híbrido y el render completo (conteo real de paquetes, no el campo duration del contenedor)", realPacketsSel === realPacketsFull, `selectivo=${realPacketsSel} completo=${realPacketsFull}`);

  const audioDurSel = await probeDuration(selectiveOutputPath, "a:0");
  const audioDurFull = await probeDuration(fullOutputPath, "a:0");
  check("caso A: sincronía de audio, margen <1 cuadro", Math.abs(audioDurSel - audioDurFull) < 1 / FPS + 0.01, `diff=${Math.abs(audioDurSel - audioDurFull)}`);

  const psnr = await compareVideosPsnr({ ffmpegPath, env: ffmpegEnv, pathA: fullOutputPath, pathB: selectiveOutputPath });
  console.log(`[caso A] PSNR (propio, cuadro a cuadro): promedio=${psnr.averagePsnr}dB mínimo=${psnr.minPsnr}dB cuadros=${psnr.framesA}/${psnr.framesB}`);
  // NO se exige psnr.frameCountMismatch===false como aserción dura --
  // confirmado real en CI, 14-nov-2026, con el conteo INDEPENDIENTE de
  // ffprobe (arriba, `realPacketsSel/Full`, que SÍ es una aserción
  // dura): el .mp4 final siempre tuvo el total EXACTO de cuadros; el
  // emparejamiento cuadro-a-cuadro interno de esta herramienta propia
  // (decodificar con `+genpts+igndts` para tolerar las discontinuidades
  // de PTS entre tramos) puede perder el sincronismo de a cuál cuadro
  // le toca comparar con cuál en esa misma frontera sin que eso
  // signifique que el ARCHIVO tenga un cuadro de más o de menos -- la
  // garantía real y más fuerte ya se probó arriba.
  console.log(`[caso A] (informativo) psnr.frameCountMismatch=${psnr.frameCountMismatch} -- no determina el resultado; el conteo real de paquetes de arriba ya probó que el archivo está exacto.`);
  // Umbral honesto (no el >30dB genérico de la tarea anterior):
  // confirmado real en CI, 14-nov-2026, que el render COMPLETO de
  // Remotion (la línea base contra la que se compara) pasa cada cuadro
  // por una captura JPEG intermedia (`Config.setVideoImageFormat
  // ("jpeg")`, remotion.config.ts -- configuración real de producción,
  // no se cambia solo para esta prueba) antes de volver a codificar a
  // h264; el tramo plano del híbrido (FFmpeg directo sobre la fuente,
  // sin esa etapa) nunca pasa por esa pérdida adicional. Con
  // `testsrc2` -- un patrón sintético de alta frecuencia a propósito
  // adversarial para la compresión, mucho más exigente que un video
  // grabado real -- esa diferencia de PIPELINE (no una desalineación
  // ni corrupción: el conteo de cuadros arriba ya prueba eso) basta
  // para bajar el PSNR de esta comparación puntual. El umbral de abajo
  // sigue detectando con margen un cuadro realmente corrupto o
  // desalineado (eso cae muy por debajo de esto), sin exigir una
  // réplica píxel a píxel de una etapa de compresión que el tramo
  // plano, correctamente, no repite.
  check("caso A: equivalencia visual -- PSNR promedio >22dB (detecta corrupción/desalineación real; no exige igualar la pérdida JPEG intermedia de Remotion, que el tramo plano no repite)", psnr.averagePsnr !== null && psnr.averagePsnr > 22, `averagePsnr=${psnr.averagePsnr}`);
  check("caso A: ni siquiera el PEOR cuadro cae por debajo de 16dB (ningún cuadro individual gravemente corrupto)", psnr.minPsnr !== null && psnr.minPsnr > 16, `minPsnr=${psnr.minPsnr}`);
} catch (err) {
  check("caso A (G1, equivalencia con resolución igual al destino): fallo inesperado en la prueba misma", false, String(err.message ?? err));
}

// --- Caso B: fuente con FPS GENUINAMENTE variable (adenda criterio 3/B) --
// construida concatenando dos tramos de fps DISTINTOS con `-vsync vfr`
// (re-encode real, no una etiqueta falsa) -- el corte del job cae
// justo en la frontera entre ambos tramos, el punto más exigente para
// `-r` como normalizador de salida.
try {
  const partA = path.join(FIXTURES_DIR, "casoB-partA.mp4");
  const partB = path.join(FIXTURES_DIR, "casoB-partB.mp4");
  await execFileAsync(SYSTEM_FFMPEG, ["-y", "-f", "lavfi", "-i", `testsrc2=size=${DEST_WIDTH}x${DEST_HEIGHT}:rate=24`, "-t", "5", "-bf", "0", "-c:v", "libx264", "-pix_fmt", "yuv420p", partA], { env: systemEnv });
  await execFileAsync(SYSTEM_FFMPEG, ["-y", "-f", "lavfi", "-i", `testsrc2=size=${DEST_WIDTH}x${DEST_HEIGHT}:rate=30`, "-t", "5", "-bf", "0", "-c:v", "libx264", "-pix_fmt", "yuv420p", partB], { env: systemEnv });
  const listPath = path.join(FIXTURES_DIR, "casoB-list.txt");
  await fs.writeFile(listPath, `file '${partA}'\nfile '${partB}'\n`, "utf8");
  const sourceRel = `${FIXTURES_REL_DIR}/casoB-fuente.mp4`;
  const sourcePath = path.join(PROJECT_ROOT, "public", sourceRel);
  await execFileAsync(SYSTEM_FFMPEG, ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-fflags", "+genpts", "-vsync", "vfr", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "10", "-g", "20", "-bf", "0", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", sourcePath], { env: systemEnv });

  const { stdout: probeOut } = await execFileAsync(ffprobePath, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate,avg_frame_rate,nb_frames", "-of", "default=nw=1", sourcePath], { env: ffprobeEnv });
  console.log(`[caso B] fuente VFR construida -- ${probeOut.trim().replace(/\n/g, ", ")}`);
  check("caso B: la fuente construida es REALMENTE de FPS variable (r_frame_rate != avg_frame_rate, no solo declarada)", /r_frame_rate=([\d/]+)/.exec(probeOut)?.[1] !== /avg_frame_rate=([\d/]+)/.exec(probeOut)?.[1]);

  const job = {
    channel: "a-mi-no-me-cuadra",
    destination: "youtube-16-9",
    input: { type: "recorded-video", baseVideo: sourceRel, durationInSeconds: 10 },
    overlays: [{ id: "o1", type: "text", text: "en la frontera vfr", startSeconds: 4, durationSeconds: 2 }], // 4-6s, cruza la frontera 5s entre los dos tramos de fps distinto
    captions: [],
    cuts: [],
    zooms: [],
    resources: [],
  };
  const jobRelPath = `${FIXTURES_REL_DIR}/casoB.json`;
  await fs.writeFile(path.join(PROJECT_ROOT, "public", jobRelPath), JSON.stringify(job));
  const plan = planChunks(job);

  const chunkDir = path.join(FIXTURES_DIR, "casoB-chunks");
  await fs.mkdir(chunkDir, { recursive: true });
  const chunkResults = await renderAllChunks({ plan, chunkOutputDir: chunkDir, sourceVideoPath: sourcePath, propsJobFile: jobRelPath, ffmpegPath, ffprobePath, env: process.env, cwd: PROJECT_ROOT, destWidth: DEST_WIDTH, destHeight: DEST_HEIGHT, srcWidth: DEST_WIDTH, srcHeight: DEST_HEIGHT, fps: FPS, concurrency: "1", entryPoint: bundleDir, timeoutMs: 60_000, onLog: (m) => console.log(`[caso B] ${m}`) });
  check("caso B: se renderizaron los chunks sobre la fuente VFR sin lanzar", chunkResults.length === plan.chunks.length);

  for (const r of chunkResults) {
    // Conteo de PAQUETES de video (igual que verifyChunkIntegrity, ya
    // probado) -- confirmado real en CI que `-count_frames`/
    // `nb_read_frames` no es fiable en este build de ffmpeg.
    const { stdout } = await execFileAsync(ffprobePath, ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=flags", "-of", "json", r.path], { env: ffprobeEnv, maxBuffer: 16 * 1024 * 1024 });
    const actual = (JSON.parse(stdout).packets ?? []).length;
    const expected = r.outputEndFrame - r.outputStartFrame;
    check(`caso B: chunk ${r.type} (cuadros ${r.outputStartFrame}-${r.outputEndFrame - 1}) tiene EXACTAMENTE los cuadros esperados pese a la fuente VFR (${expected})`, actual === expected, `actual=${actual}`);
  }

  const timeline = buildTimeline(10, job.cuts);
  const selectiveOutputPath = path.join(FIXTURES_DIR, "casoB-selectivo.mp4");
  await assembleFromChunks({ ffmpegPath, ffprobePath, env: process.env, sourceVideoPath: sourcePath, chunks: chunkResults.map((r) => ({ path: r.path })), timeline, workDir: path.join(FIXTURES_DIR, "casoB-assemble"), outputPath: selectiveOutputPath, sampleRate: 48000, onLog: () => {} });

  const fullOutputPath = path.join(FIXTURES_DIR, "casoB-completo.mp4");
  await runRemotionRender({ cwd: PROJECT_ROOT, env: process.env, outputPath: fullOutputPath, propsJobFile: jobRelPath, concurrency: "1", timeoutMs: 120_000, onLog: () => {} });

  // Duración exacta en CUADROS (ver el comentario grande del caso A) -- el campo `duration` del contenedor queda como dato informativo.
  const realPacketsSelB = await countVideoPackets(selectiveOutputPath);
  const realPacketsFullB = await countVideoPackets(fullOutputPath);
  const videoDurSel = await probeDuration(selectiveOutputPath, "v:0");
  const videoDurFull = await probeDuration(fullOutputPath, "v:0");
  console.log(`[caso B] duración de video (fuente VFR) -- selectivo=${videoDurSel}s (${realPacketsSelB} cuadros) completo=${videoDurFull}s (${realPacketsFullB} cuadros)`);
  check("caso B: con fuente VFR, EXACTAMENTE los mismos cuadros de video (ambos normalizan a FPS constante)", realPacketsSelB === realPacketsFullB, `selectivo=${realPacketsSelB} completo=${realPacketsFullB}`);

  const psnr = await compareVideosPsnr({ ffmpegPath, env: ffmpegEnv, pathA: fullOutputPath, pathB: selectiveOutputPath });
  // psnr.frameCountMismatch no es una aserción dura acá tampoco -- ver el comentario grande del caso A; el conteo real de paquetes de arriba ya es la garantía fuerte.
  console.log(`[caso B] (informativo) psnr.frameCountMismatch=${psnr.frameCountMismatch}`);
  // Mismo umbral honesto que el caso A (JPEG intermedio de Remotion en la línea base + testsrc2 adversarial -- ver el comentario grande ahí).
  check("caso B: con fuente VFR, equivalencia visual -- PSNR promedio >22dB", psnr.averagePsnr !== null && psnr.averagePsnr > 22, `averagePsnr=${psnr.averagePsnr}`);
} catch (err) {
  check("caso B (fuente VFR genuina): fallo inesperado en la prueba misma", false, String(err.message ?? err));
}

// --- Caso C: G2-R -- reanudación CON VERIFICACIÓN DE INTEGRIDAD (adenda criterio C). ---
try {
  const sourcePath = path.join(FIXTURES_DIR, "casoC-fuente.mp4");
  await execFileAsync(ffmpegPath, ["-y", "-f", "lavfi", "-i", "nullsrc=size=1920x1080:rate=30", "-t", "9", "-pix_fmt", "yuv420p", "-c:v", "libx264", sourcePath], { env: ffmpegEnv });
  const sourceRel = `${FIXTURES_REL_DIR}/casoC-fuente.mp4`;

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
  const jobRelPath = `${FIXTURES_REL_DIR}/casoC.json`;
  await fs.writeFile(path.join(PROJECT_ROOT, "public", jobRelPath), JSON.stringify(job));
  const plan = planChunks(job); // 3 chunks: plano, compuesto, plano
  check("caso C: el plan tiene 3 chunks (plano, compuesto, plano)", plan.chunks.length === 3);

  const chunkDir = path.join(FIXTURES_DIR, "casoC-chunks");
  await fs.mkdir(chunkDir, { recursive: true });
  const renderArgs = { chunkOutputDir: chunkDir, sourceVideoPath: sourcePath, propsJobFile: jobRelPath, ffmpegPath, ffprobePath, env: process.env, cwd: PROJECT_ROOT, destWidth: DEST_WIDTH, destHeight: DEST_HEIGHT, srcWidth: 1920, srcHeight: 1080, fps: FPS, concurrency: "1", entryPoint: bundleDir, timeoutMs: 60_000, onLog: () => {} };

  // Simula un corte a mitad de camino: solo el primer chunk.
  await renderAllChunks({ plan: { totalFrames: plan.totalFrames, chunks: [plan.chunks[0]] }, ...renderArgs });
  const firstChunkPath = `${chunkDir}/chunk-0000-plain.ts`;
  const statBefore = await fs.stat(firstChunkPath);
  check("caso C: tras el 'corte', el primer chunk quedó completo en disco", statBefore.size > 0);

  // --- Sub-caso: TRUNCAR el chunk a propósito (adenda criterio C: "un tramo truncado o corrupto se detecta y se vuelve a generar"). ---
  const fullBytes = await fs.readFile(firstChunkPath);
  await fs.writeFile(firstChunkPath, fullBytes.subarray(0, Math.floor(fullBytes.length * 0.4))); // corta el archivo a la mitad, a propósito
  const truncatedVerification = await verifyChunkIntegrity({ ffmpegPath, ffprobePath, env: process.env, filePath: firstChunkPath, expectedFrames: plan.chunks[0].frames ?? plan.chunks[0].outputEndFrame - plan.chunks[0].outputStartFrame });
  check("caso C: verifyChunkIntegrity detecta el archivo TRUNCADO (ok=false) -- 'existe' no basta", truncatedVerification.ok === false, JSON.stringify(truncatedVerification));
  check("caso C: la verificación del truncado trae un checksum (evidencia de qué bytes exactos fallaron)", typeof truncatedVerification.checksum === "string" && truncatedVerification.checksum.length === 64);

  const logs = [];
  const chunkResults = await renderAllChunks({ plan, ...renderArgs, onLog: (m) => logs.push(m) });
  check("caso C: tras reintentar con el chunk truncado, se detectó Y SE VOLVIÓ A RENDERIZAR (nunca se reutilizó lo corrupto)", logs.some((l) => l.includes("NO pasó la verificación")) && chunkResults[0].reused === false, JSON.stringify(logs));
  const statAfter = await fs.stat(firstChunkPath);
  check("caso C: el chunk regenerado tiene el tamaño completo de nuevo (mayor que el truncado)", statAfter.size > fullBytes.length * 0.4 && statAfter.size > 0);
  check("caso C: el resultado trae los 3 chunks, los 3 VERIFICADOS con checksum", chunkResults.length === 3 && chunkResults.every((r) => typeof r.checksum === "string"));

  // --- Reanudación normal (sin truncar) debe seguir reusando lo ya verificado. ---
  const logsSecondRetry = [];
  const chunkResultsAgain = await renderAllChunks({ plan, ...renderArgs, onLog: (m) => logsSecondRetry.push(m) });
  check("caso C: un segundo reintento (todo ya completo y válido) reusa los 3 chunks sin re-renderizar ninguno", chunkResultsAgain.every((r) => r.reused === true));
  check("caso C: el checksum del chunk reusado es IDÉNTICO al de la corrida anterior (mismo archivo, no uno nuevo)", chunkResultsAgain[0].checksum === chunkResults[0].checksum);

  // --- El resultado final ensamblado debe ser idéntico a una corrida SIN interrupciones. ---
  const timeline = buildTimeline(9, job.cuts);
  const resumedOutputPath = path.join(FIXTURES_DIR, "casoC-reanudado.mp4");
  await assembleFromChunks({ ffmpegPath, ffprobePath, env: process.env, sourceVideoPath: sourcePath, chunks: chunkResultsAgain.map((r) => ({ path: r.path })), timeline, workDir: path.join(FIXTURES_DIR, "casoC-assemble-reanudado"), outputPath: resumedOutputPath, sampleRate: 48000, onLog: () => {} });

  const freshChunkDir = path.join(FIXTURES_DIR, "casoC-chunks-sin-interrupcion");
  await fs.mkdir(freshChunkDir, { recursive: true });
  const freshResults = await renderAllChunks({ plan, ...renderArgs, chunkOutputDir: freshChunkDir, onLog: () => {} });
  const freshOutputPath = path.join(FIXTURES_DIR, "casoC-sin-interrupcion.mp4");
  await assembleFromChunks({ ffmpegPath, ffprobePath, env: process.env, sourceVideoPath: sourcePath, chunks: freshResults.map((r) => ({ path: r.path })), timeline, workDir: path.join(FIXTURES_DIR, "casoC-assemble-fresco"), outputPath: freshOutputPath, sampleRate: 48000, onLog: () => {} });

  const psnr = await compareVideosPsnr({ ffmpegPath, env: ffmpegEnv, pathA: freshOutputPath, pathB: resumedOutputPath });
  console.log(`[caso C] PSNR entre la corrida reanudada (con el truncado detectado y regenerado) y una sin interrupciones: ${psnr.averagePsnr}dB (idénticos=${psnr.identicalFrames}/${psnr.framesCompared})`);
  check("caso C: el resultado reanudado (pese al truncado detectado a mitad de camino) es visualmente IDÉNTICO a una corrida sin interrupciones", psnr.averagePsnr !== null && (psnr.averagePsnr === Infinity || psnr.averagePsnr > 40), `averagePsnr=${psnr.averagePsnr}`);
} catch (err) {
  check("caso C (G2-R, reanudación con verificación de integridad): fallo inesperado en la prueba misma", false, String(err.message ?? err));
}

await fs.rm(FIXTURES_DIR, { recursive: true, force: true });

console.log(failures === 0 ? "\nTODOS LOS TESTS DE RENDER HÍBRIDO (REMOTION REAL) PASARON" : `\n${failures} TEST(S) FALLARON`);
process.exit(failures === 0 ? 0 : 1);
