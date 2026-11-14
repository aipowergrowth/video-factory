// Ensamblado del render híbrido (Fase 0, 14-nov-2026, autorizado por
// Alex, criterio 1: "ensamblado sin recodificar todo el video").
//
// Diseño (lo que el código HACE, no lo que se asumió antes):
// - Cada tramo llega como MPEG-TS (`.ts`) de solo video: los planos los
//   produce FFmpeg (copia de flujo por GOP + bordes recodificados, ver
//   segment-render.mjs) y los compuestos los produce Remotion con
//   `--codec=h264-ts` -- el mismo contenedor intermedio que la
//   documentación oficial de render distribuido de Remotion prescribe
//   para unir tramos h264.
// - La unión es CONCATENACIÓN BINARIA DIRECTA de los .ts (sin invocar
//   a FFmpeg para unirlos -- ver `concatTsFiles`) y recién después una
//   única pasada de FFmpeg para remuxear ese .ts ya unido a .mp4 con
//   copia de flujo (nunca recodifica NINGÚN cuadro). TS -> MP4 con
//   copia de flujo convierte Annex B a avcC en el muxer (comportamiento
//   estándar de FFmpeg).
// - El audio final se construye UNA SOLA VEZ desde el video fuente
//   completo, aplicando los mismos cortes que el video (vía
//   `buildTimeline`, la misma lógica que ya usa el resto del motor) --
//   nunca concatenando audio por tramo (artefactos de AAC que señala la
//   documentación de Remotion).
//
// Historia honesta (por qué se llegó a esto): la versión original unía
// chunks MP4 con el DEMUXER `concat` de FFmpeg y daba una duración
// incorrecta (58,1s en vez de 14s); un primer intento de arreglo
// recodificó todo el video en el ensamblado, lo cual contradecía el
// objetivo. El demuxer `concat` resultó tener el MISMO defecto tanto
// uniendo piezas DENTRO de un tramo como uniendo tramos ENTRE sí
// (confirmado real en CI, 14-nov-2026, con varias banderas de
// tolerancia de timestamps probadas sin ningún efecto) -- la causa no
// estaba en qué tan permisivo era el lector, sino en la aritmética del
// demuxer al escribir, entre archivos de orígenes de reloj distintos.
// MPEG-TS es concatenable a nivel de BYTES por diseño (por eso la
// documentación de render distribuido de Remotion lo recomienda para
// unir tramos h264) -- evitar el demuxer `concat` por completo y
// concatenar los .ts directamente como bytes, dejando que una sola
// pasada de FFmpeg con banderas tolerantes (`+genpts+igndts`) resuelva
// las discontinuidades de PTS/DTS en cada frontera al leer, es lo que
// de verdad funciona. Se diagnostica con evidencia directa (ffprobe de
// cada tramo, antes y después de unir) en test-hybrid-render.mjs (CI)
// y se documenta en el informe de esta tarea.
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
 * Argumentos para remuxear un .ts YA UNIDO (ver `concatChunksToMp4`) a
 * .mp4 SIN recodificar -- pura. `-fflags +genpts+igndts` (mismas
 * banderas que `verifyChunkIntegrity`, confirmadas reales en CI,
 * 14-nov-2026): el .ts de entrada es la concatenación BINARIA de
 * varios tramos con orígenes de reloj distintos -- tiene
 * discontinuidades de PTS/DTS normales en cada frontera, que estas
 * banderas ya saben tolerar al leer.
 */
export const buildTsToMp4ConcatArgs = ({ inputPath, outputPath }) => ["-y", "-fflags", "+genpts+igndts", "-i", inputPath, "-map", "0:v:0", "-c:v", "copy", "-an", "-avoid_negative_ts", "make_zero", "-movflags", "+faststart", "-f", "mp4", outputPath];

/**
 * Une varios .ts (p.ej. el borde recodificado + el cuerpo copiado de
 * un mismo tramo plano) en un solo .ts -- CONCATENACIÓN BINARIA
 * DIRECTA, sin invocar a FFmpeg.
 *
 * Causa raíz real con evidencia de CI, 14-nov-2026 (varios intentos
 * con `-fflags +genpts`/`+igndts`, al leer Y al escribir, con el MISMO
 * resultado exacto cada vez -- "non monotonically increasing dts...
 * 62 >= 58", números idénticos sin importar la bandera): el demuxer
 * `concat` de FFmpeg hace aritmética de continuidad de tiempo entre
 * archivos de ORIGEN DE RELOJ distinto (una pieza "copy" conserva el
 * reloj original de la fuente; una "reencode" arranca su propio PTS
 * cerca de 0) y ninguna bandera de tolerancia de timestamps cambió el
 * resultado -- la causa no estaba en qué tan permisivo es el LECTOR,
 * sino en la aritmética del demuxer al ESCRIBIR. MPEG-TS, a propósito
 * de diseño (es justo por qué la documentación de render distribuido
 * de Remotion recomienda este contenedor para unir tramos), es
 * concatenable a nivel de BYTES -- cada paquete de 188 bytes es
 * autocontenido; el salto de PTS/DTS en la frontera queda en el
 * archivo (como una discontinuidad normal de TS, no corrupción) y lo
 * resuelve quien lo vuelva a leer con banderas tolerantes (ver
 * `verifyChunkIntegrity`, que ya usa `+genpts+igndts`). Nunca
 * recodifica -- sigue cumpliendo el criterio 1 de la adenda.
 */
export const concatTsFiles = async ({ entries, outputPath }) => {
  const buffers = await Promise.all(entries.map((e) => fs.readFile(e.path)));
  await fs.writeFile(outputPath, Buffer.concat(buffers));
  return outputPath;
};

/**
 * Une los .ts de TODOS los tramos (en orden) en un .mp4 de solo
 * video, SIN recodificar ningún cuadro -- la etapa que antes
 * recodificaba todo.
 *
 * Causa raíz real con evidencia de CI, 14-nov-2026 (el mismo defecto
 * que ya se encontró y corrigió para unir las piezas de UN tramo --
 * ver `concatTsFiles`, pero acá entre TRAMOS distintos): el demuxer
 * `concat` de FFmpeg, yendo directo de varios .ts a .mp4, podía perder
 * más de 1 segundo del video final (confirmado real: 12,9s en vez de
 * 14s) sin ningún error -- la misma aritmética de continuidad de
 * tiempo entre archivos de orígenes de reloj distintos. Se evita
 * exactamente igual: concatenar los .ts a nivel de BYTES primero
 * (`concatTsFiles`, ya probado) y recién ahí hacer a un .mp4, en una
 * sola pasada de FFmpeg sobre un solo archivo de entrada -- nunca
 * dejando que el demuxer `concat` decida los límites entre archivos.
 */
export const concatChunksToMp4 = async ({ ffmpegPath, env, entries, workDir, outputPath }) => {
  const joinedTsPath = `${workDir}/joined.ts`;
  await concatTsFiles({ entries, outputPath: joinedTsPath });
  await execFileAsync(ffmpegPath, buildTsToMp4ConcatArgs({ inputPath: joinedTsPath, outputPath }), { env, maxBuffer: 16 * 1024 * 1024 });
  return outputPath;
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

/** Mezcla el video (ya unido) con el audio final, ambos en copia de flujo -- sin audio disponible, deja el video solo (`audioPath === null` en el resultado lo refleja, nunca se inventa una pista muda sin avisar). */
export const muxFinal = async ({ ffmpegPath, env, videoOnlyPath, audioPath, outputPath }) => {
  const args = audioPath
    ? ["-y", "-i", videoOnlyPath, "-i", audioPath, "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-movflags", "+faststart", outputPath]
    : ["-y", "-i", videoOnlyPath, "-c", "copy", "-movflags", "+faststart", outputPath];
  await execFileAsync(ffmpegPath, args, { env, maxBuffer: 16 * 1024 * 1024 });
  return outputPath;
};

/**
 * Orquesta las 3 etapas (unir video sin recodificar, construir audio
 * una vez, mezclar) y devuelve rutas + tiempos por etapa. `chunks` son
 * `{ path }` en orden de salida -- la unión es binaria directa (ver
 * `concatTsFiles`), nunca necesita la duración de cada uno.
 */
export const assembleFromChunks = async ({ ffmpegPath, ffprobePath, env, sourceVideoPath, chunks, timeline, workDir, outputPath, sampleRate, onLog = () => {} }) => {
  await fs.mkdir(workDir, { recursive: true });
  const videoOnlyPath = `${workDir}/video-only.mp4`;

  let t = Date.now();
  await concatChunksToMp4({
    ffmpegPath,
    env,
    entries: chunks.map((c) => ({ path: c.path })),
    workDir,
    outputPath: videoOnlyPath,
  });
  const concatMs = Date.now() - t;
  onLog(`video unido sin recodificar (${chunks.length} tramo(s), copia de flujo) en ${concatMs}ms.`);

  t = Date.now();
  const sourceHasAudio = await hasAudioStream(ffprobePath, env, sourceVideoPath);
  let audioPath = null;
  if (sourceHasAudio) {
    // ".aac" (flujo crudo ADTS) -- confirmado real en CI, 12-nov-2026:
    // el ffmpeg recortado de @remotion/compositor-* no pudo elegir el
    // formato de salida a partir de la extensión ".m4a". FFmpeg lo
    // mezcla en el MP4 final (muxFinal) sin problema.
    audioPath = `${workDir}/audio-full.aac`;
    await buildFullAudioTrack({ ffmpegPath, env, sourceVideoPath, timeline, outputPath: audioPath, sampleRate });
  }
  const audioMs = Date.now() - t;
  onLog(sourceHasAudio ? `audio construido una sola vez desde la fuente (con los cortes aplicados) en ${audioMs}ms.` : `la fuente no tiene audio -- el resultado queda sin pista de audio.`);

  t = Date.now();
  await muxFinal({ ffmpegPath, env, videoOnlyPath, audioPath, outputPath });
  const muxMs = Date.now() - t;
  onLog(`mezcla final (copia de flujo) en ${muxMs}ms.`);

  return { outputPath, videoOnlyPath, audioPath, sourceHasAudio, stages: { concatMs, audioMs, muxMs } };
};
