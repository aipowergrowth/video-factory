// Render selectivo (Fase 0, reducir el tiempo de render, 11-nov-2026,
// autorizado por Alex, criterio 6) -- PROTOTIPO, nunca integrado al
// camino de producción (ver server/segment-pipeline.mjs para dónde se
// decide eso con la bandera RENDER_MODE). Dado un chunk de
// `segment-planner.mjs#planChunks`, lo renderiza:
//
// - "plain" (solo video fuente, sin ningún elemento encima): con
//   FFmpeg, re-codificando (no copiando) -- `-ss` ANTES de `-i` con
//   re-encode da un corte EXACTO al cuadro, incluso si el corte cae
//   fuera de un keyframe (confirmado: `-ss` después de `-i` con copia
//   de flujo salta al keyframe más cercano, perdiendo precisión; con
//   re-encode el decodificador sí puede empezar antes del punto
//   pedido y descartar lo sobrante, dando el cuadro exacto -- por eso
//   se re-codifica siempre en este prototipo, no solo "en los
//   bordes": es la forma más simple de garantizar precisión exacta en
//   TODOS los casos sin tener que detectar keyframes a mano). También
//   normaliza a FPS constante (`fps=`) -- necesario si el fuente
//   declara FPS variable (ver server/source-video-diagnostics.mjs).
// - "composite" (con zoom, overlay, recurso o subtítulo quemado): con
//   Remotion real (`runRemotionRender`, el mismo mecanismo de
//   producción -- vigilante, corte de grupo de procesos, evidencia),
//   restringido a ese rango de cuadros vía `--frames`.
//
// Ambos se renderizan SIN audio (`-an`/`--muted`) -- el audio final se
// construye UNA sola vez desde el video fuente completo
// (server/segment-assemble.mjs), nunca concatenando pistas de audio
// por tramo (evita los artefactos de unir AAC que señala la
// documentación oficial de render distribuido de Remotion).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runRemotionRender } from "./render-worker.mjs";

const execFileAsync = promisify(execFile);

/**
 * Arma los argumentos de FFmpeg para un chunk plano -- pura, sin
 * ejecutar nada. El FPS constante de salida se fuerza con `-r`
 * (opción del codificador/muxer), NO con el filtro `fps` dentro de
 * `-vf` -- confirmado real en CI, 12-nov-2026: el ffmpeg recortado de
 * @remotion/compositor-* no compila el filtro `fps` ("Error parsing
 * filterchain"), aunque sí tiene `scale`. `-r` como opción de salida
 * no depende de ese filtro -- duplica/descarta cuadros al nivel del
 * codificador para alcanzar el FPS pedido, funciona igual de bien
 * para normalizar una fuente con FPS variable.
 */
export const buildPlainChunkFfmpegArgs = ({ sourceVideoPath, chunk, outputPath, width, height, fps, crf = 18, preset = "medium" }) => {
  const durationSeconds = Math.max(0, chunk.sourceEndSeconds - chunk.sourceStartSeconds);
  return [
    "-y",
    "-ss",
    String(chunk.sourceStartSeconds),
    "-i",
    sourceVideoPath,
    "-t",
    String(durationSeconds),
    "-an",
    "-vf",
    `scale=${width}:${height}:flags=lanczos`,
    "-r",
    String(fps),
    "-c:v",
    "libx264",
    "-preset",
    preset,
    "-crf",
    String(crf),
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    outputPath,
  ];
};

/** Renderiza un chunk PLANO con FFmpeg real -- devuelve la ruta de salida. */
export const renderPlainChunk = async ({ ffmpegPath, env, sourceVideoPath, chunk, outputPath, width, height, fps, crf, preset }) => {
  const args = buildPlainChunkFfmpegArgs({ sourceVideoPath, chunk, outputPath, width, height, fps, crf, preset });
  await execFileAsync(ffmpegPath, args, { env, maxBuffer: 16 * 1024 * 1024 });
  return { outputPath, args };
};

/**
 * Renderiza un chunk COMPUESTO con Remotion real, restringido a su
 * rango de cuadros (`chunk.outputStartFrame`/`outputEndFrame`, en el
 * mismo índice que usa la composición completa -- un solo chunk es
 * una invocación de Remotion propia, no una selección combinada como
 * el render de diagnóstico). Reusa `runRemotionRender` tal cual (mismo
 * vigilante, mismo corte de grupo de procesos, misma evidencia) --
 * nunca se reescribe esa lógica para el prototipo.
 */
export const renderCompositeChunk = ({ cwd, env, propsJobFile, outputPath, chunk, concurrency = "1", enableMultiprocessOnLinux, browserExecutable, binariesDirectory, timeoutMs = 120_000, onLog = () => {} }) =>
  runRemotionRender({
    cwd,
    env,
    outputPath,
    propsJobFile,
    concurrency,
    enableMultiprocessOnLinux,
    browserExecutable,
    binariesDirectory,
    frames: `${chunk.outputStartFrame}-${chunk.outputEndFrame - 1}`,
    muted: true,
    timeoutMs,
    onLog,
  });

/**
 * Renderiza TODOS los chunks de un plan (en orden, uno por uno --
 * nunca en paralelo en este prototipo, para que un error en un chunk
 * sea fácil de atribuir) y devuelve la lista de archivos de video
 * (sin audio) en el MISMO orden que `plan.chunks`, listos para
 * `segment-assemble.mjs#concatVideoOnly`.
 *
 * REANUDABLE (criterio G2-R, 11-nov-2026): cada chunk se renderiza
 * primero a `<outputPath>.tmp` y solo se renombra al nombre FINAL
 * (`fs.rename`, atómico en el mismo disco) si terminó bien -- igual
 * patrón que `atomic-json-store.mjs` para el estado del job. Si esta
 * función se llama de nuevo después de un fallo/corte a mitad de
 * camino (el proceso del servidor murió, por ejemplo), cualquier
 * chunk cuyo archivo FINAL ya exista se OMITE -- nunca se vuelve a
 * renderizar lo que ya está completo. Un `.tmp` que haya quedado de
 * un corte a mitad de un chunk nunca cuenta como completo (no se
 * renombró) -- ese chunk se vuelve a renderizar desde cero.
 */
export const renderAllChunks = async ({ plan, chunkOutputDir, sourceVideoPath, propsJobFile, ffmpegPath, env, cwd, width, height, fps, concurrency, enableMultiprocessOnLinux, browserExecutable, binariesDirectory, crf, preset, timeoutMs, onLog = () => {} }) => {
  const fs = await import("node:fs/promises");
  const results = [];
  for (let i = 0; i < plan.chunks.length; i++) {
    const chunk = plan.chunks[i];
    const outputPath = `${chunkOutputDir}/chunk-${String(i).padStart(4, "0")}-${chunk.type}.mp4`;
    const alreadyDone = await fs
      .access(outputPath)
      .then(() => true)
      .catch(() => false);
    if (alreadyDone) {
      onLog(`chunk ${i + 1}/${plan.chunks.length} (${chunk.type}): ya estaba completo de un intento anterior -- NO se vuelve a renderizar.`);
      results.push({ outputPath, chunk, reused: true });
      continue;
    }
    // ".tmp.mp4" (nunca ".mp4.tmp") -- confirmado real en CI,
    // 12-nov-2026: tanto FFmpeg como Remotion adivinan el contenedor
    // de salida por la EXTENSIÓN del archivo; un ".tmp" al final hace
    // que ninguno de los dos reconozca el formato ("Error initializing
    // the muxer... Invalid argument"). Con ".tmp.mp4" la extensión
    // real sigue siendo ".mp4" -- el nombre deja claro que es temporal
    // sin romper esa detección.
    const tmpOutputPath = outputPath.replace(/\.mp4$/, ".tmp.mp4");
    onLog(`chunk ${i + 1}/${plan.chunks.length} (${chunk.type}): cuadros ${chunk.outputStartFrame}-${chunk.outputEndFrame - 1}, fuente ${chunk.sourceStartSeconds}s-${chunk.sourceEndSeconds}s`);
    if (chunk.type === "plain") {
      await renderPlainChunk({ ffmpegPath, env, sourceVideoPath, chunk, outputPath: tmpOutputPath, width, height, fps, crf, preset });
    } else {
      await renderCompositeChunk({ cwd, env, propsJobFile, outputPath: tmpOutputPath, chunk, concurrency, enableMultiprocessOnLinux, browserExecutable, binariesDirectory, timeoutMs, onLog });
    }
    await fs.rename(tmpOutputPath, outputPath);
    results.push({ outputPath, chunk, reused: false });
  }
  return results;
};
