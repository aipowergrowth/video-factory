// Render selectivo (Fase 0, reducir el tiempo de render, 11-nov-2026,
// autorizado por Alex, criterio 6) -- PROTOTIPO. Une los chunks de
// video (sin audio, ver segment-render.mjs) con el demuxer `concat`
// de FFmpeg (`-c copy`, sin recodificar en el ensamble -- MEDIDO-SANDBOX
// del dictamen del operador: copiar 1800 cuadros tardó 0,19s, confirma
// que esta etapa es prácticamente gratis cuando los parámetros de
// codificación ya calzan entre todos los chunks) y construye el audio
// final UNA SOLA VEZ desde el video fuente completo, aplicando los
// mismos cortes que el video (vía `buildTimeline`, la misma lógica que
// ya usa el resto del motor) -- nunca concatenando audio por tramo,
// que es justo lo que la documentación oficial de render distribuido
// de Remotion señala como causa de artefactos (padding/encoder delay
// de AAC en cada tramo independiente).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";

const execFileAsync = promisify(execFile);

/** `true` si el video tiene al menos una pista de audio -- `false` (nunca lanza) si no tiene o no se pudo determinar. */
export const hasAudioStream = async (ffprobePath, env, videoPath) => {
  try {
    const { stdout } = await execFileAsync(ffprobePath, ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0", videoPath], { env });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
};

/**
 * Arma el filtro `atrim`+`concat` que construye el audio COMPLETO (con
 * los cortes ya aplicados) de una sola pasada -- pura (solo arma el
 * texto del filtro, no ejecuta nada). Un segmento por tramo
 * SOBREVIVIENTE de `buildTimeline` -- el mismo corte que ya se le
 * aplicó al video, nunca recalculado aparte (si se desincronizaran,
 * audio e imagen quedarían desfasados).
 */
export const buildAudioFilterComplex = (timeline) => {
  if (timeline.segments.length === 0) return null;
  const trims = timeline.segments.map((seg, i) => `[0:a]atrim=start=${seg.sourceStart}:end=${seg.sourceEnd},asetpts=PTS-STARTPTS[a${i}]`);
  const concatInputs = timeline.segments.map((_, i) => `[a${i}]`).join("");
  return `${trims.join(";")};${concatInputs}concat=n=${timeline.segments.length}:v=0:a=1[aout]`;
};

/** Construye el audio final (con los cortes aplicados) en un solo archivo -- `null` si la línea de tiempo no tiene ningún tramo sobreviviente. */
export const buildFullAudioTrack = async ({ ffmpegPath, env, sourceVideoPath, timeline, outputPath, sampleRate = 48000 }) => {
  const filter = buildAudioFilterComplex(timeline);
  if (!filter) return null;
  const args = ["-y", "-i", sourceVideoPath, "-filter_complex", filter, "-map", "[aout]", "-ar", String(sampleRate), "-c:a", "aac", "-b:a", "192k", outputPath];
  await execFileAsync(ffmpegPath, args, { env, maxBuffer: 16 * 1024 * 1024 });
  return outputPath;
};

/**
 * Concatena los chunks de video con el FILTRO `concat` de FFmpeg
 * (`-filter_complex`, uno por cada chunk como `-i` propio), NO el
 * demuxer `concat` (`-f concat -i lista.txt`).
 *
 * Causa raíz encontrada con evidencia real en CI, 12-nov-2026 (no
 * asumida ni simulada): con el DEMUXER, tanto en modo `-c copy` como
 * recodificando (`-c:v libx264 ...`), el video final salía con una
 * duración completamente incorrecta (58,1s en vez de 14s) -- EXACTAMENTE
 * el mismo desajuste (44,1s) en ambos modos, aunque cada chunk
 * individual, medido por separado con ffprobe, tenía la duración
 * exacta esperada. Que recodificar no cambiara el resultado ni un
 * milisegundo descarta la hipótesis inicial (un mismatch de
 * `timescale` del contenedor MP4 entre Remotion y FFmpeg) -- la causa
 * real está en cómo el DEMUXER concat decide los límites de tiempo
 * entre archivos (usa la duración que cada contenedor declara, no los
 * cuadros reales decodificados; puede insertar huecos/relleno al
 * cambiar de archivo). El filtro concat, en cambio, opera sobre
 * CUADROS YA DECODIFICADOS de cada entrada -- nunca lee duración de
 * contenedor ni decide límites de tiempo por su cuenta, así que es
 * inmune a esa clase de error por construcción. Esta etapa recodifica
 * (nunca fue gratis con el filtro concat, que no soporta `-c copy`) --
 * contradice el "prácticamente gratis" de MEDIDO-SANDBOX del dictamen
 * del 10-nov-2026; el costo real queda documentado como parte de la
 * puerta G2, no como cero.
 */
export const concatVideoOnly = async ({ ffmpegPath, env, chunkPaths, outputPath, crf = 18, preset = "medium" }) => {
  const inputArgs = chunkPaths.flatMap((p) => ["-i", p]);
  const filterInputs = chunkPaths.map((_, i) => `[${i}:v:0]`).join("");
  const filter = `${filterInputs}concat=n=${chunkPaths.length}:v=1:a=0[outv]`;
  const args = ["-y", ...inputArgs, "-filter_complex", filter, "-map", "[outv]", "-c:v", "libx264", "-preset", preset, "-crf", String(crf), "-pix_fmt", "yuv420p", outputPath];
  await execFileAsync(ffmpegPath, args, { env, maxBuffer: 16 * 1024 * 1024 });
  return outputPath;
};

/** Mezcla el video (ya concatenado) con el audio final -- sin audio disponible, deja el video solo (nunca inventa una pista muda a propósito sin avisar: lo refleja `audioPath === null` en el resultado). */
export const muxFinal = async ({ ffmpegPath, env, videoOnlyPath, audioPath, outputPath }) => {
  const args = audioPath
    ? ["-y", "-i", videoOnlyPath, "-i", audioPath, "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-movflags", "+faststart", outputPath]
    : ["-y", "-i", videoOnlyPath, "-c", "copy", "-movflags", "+faststart", outputPath];
  await execFileAsync(ffmpegPath, args, { env, maxBuffer: 16 * 1024 * 1024 });
  return outputPath;
};

/**
 * Orquesta las 3 etapas (concatenar video, construir audio una vez,
 * mezclar) para ensamblar el resultado final del render selectivo a
 * partir de los chunks ya renderizados (`segment-render.mjs#renderAllChunks`).
 */
export const assembleFromChunks = async ({ ffmpegPath, ffprobePath, env, sourceVideoPath, chunkPaths, timeline, workDir, outputPath, sampleRate }) => {
  await fs.mkdir(workDir, { recursive: true });
  const videoOnlyPath = `${workDir}/video-only.mp4`;
  await concatVideoOnly({ ffmpegPath, env, chunkPaths, outputPath: videoOnlyPath });

  const sourceHasAudio = await hasAudioStream(ffprobePath, env, sourceVideoPath);
  let audioPath = null;
  if (sourceHasAudio) {
    // ".aac" (flujo crudo, sin contenedor) -- confirmado real en CI,
    // 12-nov-2026: el ffmpeg recortado de @remotion/compositor-*
    // reconoce el muxer "m4a" por nombre, pero no pudo elegir el
    // formato de salida a partir de la extensión ".m4a" ("Unable to
    // choose an output format"). AAC crudo no necesita ese paso --
    // FFmpeg lo mezcla con el video sin problema en `muxFinal` más
    // abajo (mismo patrón que usa Remotion para sus propios tramos
    // de audio intermedios).
    audioPath = `${workDir}/audio-full.aac`;
    await buildFullAudioTrack({ ffmpegPath, env, sourceVideoPath, timeline, outputPath: audioPath, sampleRate });
  }

  await muxFinal({ ffmpegPath, env, videoOnlyPath, audioPath, outputPath });
  return { outputPath, videoOnlyPath, audioPath, sourceHasAudio };
};
