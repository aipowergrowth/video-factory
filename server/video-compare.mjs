// Equivalencia visual entre dos videos (Fase 0, 11-nov-2026, puerta G1;
// ampliado 14-nov-2026 para poder medir en el VPS).
//
// Dos caminos:
// - `measurePsnr`: el filtro `psnr` real de FFmpeg. Requiere un FFmpeg
//   que lo tenga compilado -- el de @remotion/compositor-* NO lo trae
//   (confirmado real en CI, 12-nov-2026: "No such filter: 'psnr'"), así
//   que en el VPS (donde solo existe ese binario) no sirve. En CI se
//   usa con el ffmpeg de sistema SOLO como contraste de la
//   implementación propia de abajo.
// - `compareVideosPsnr`: PSNR propio, en Node, sobre cuadros crudos
//   decodificados por el ffmpeg de Remotion (`-f image2pipe -c:v
//   rawvideo` -- confirmado real en CI, 14-nov-2026 con `ffmpeg
//   -muxers`/`-encoders` del binario REAL: "rawvideo" NO existe como
//   MUXER en este build recortado -- solo como ENCODER; `image2pipe`
//   SÍ está compilado y, con el codec `rawvideo` explícito, escribe
//   los cuadros crudos uno tras otro sin ninguna cabecera entre
//   ellos, igual que necesita el lector de abajo. `scale`, el filtro
//   que normaliza tamaño/escala de grises, también está compilado) --
//   funciona igual en CI y en el VPS sin instalar nada. Compara en
//   escala de grises a
//   resolución reducida (320x180 por defecto): suficiente para
//   detectar cuadros desalineados/corruptos (que es lo que se busca),
//   con un costo de memoria acotado (los dos flujos se leen en
//   paralelo cuadro a cuadro, nunca se cargan completos).
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Conteo EXACTO de cuadros de video de un archivo -- paquetes de
 * `ffprobe`, el mismo mecanismo ya probado real en CI (confirmado que
 * `-count_frames`/`nb_read_frames` da `NaN` en el ffmpeg recortado de
 * Remotion; contar paquetes h264 es exacto). Usado para la
 * equivalencia de "duración exacta en cuadros" (adenda criterio 7b)
 * sin depender del campo `duration` del contenedor.
 */
export const countVideoPackets = async (ffprobePath, env, filePath) => {
  const { stdout } = await execFileAsync(ffprobePath, ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=flags", "-of", "json", filePath], { env, maxBuffer: 16 * 1024 * 1024 });
  return (JSON.parse(stdout).packets ?? []).length;
};

/** Duración (segundos) de un stream (`"v:0"`/`"a:0"`) vía ffprobe -- usado para sincronía de audio/video (adenda criterio 7b). `null` si el stream no existe o no se pudo leer. */
export const probeStreamDuration = async (ffprobePath, env, filePath, streamSelector) => {
  try {
    const { stdout } = await execFileAsync(ffprobePath, ["-v", "error", "-select_streams", streamSelector, "-show_entries", "stream=duration", "-of", "csv=p=0", filePath], { env });
    const value = Number(stdout.trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
};

/**
 * PSNR promedio (dB) con el filtro `psnr` real de FFmpeg. Compara
 * cuadro a cuadro en el orden en que cada archivo los entrega, así que
 * ambos deben tener la MISMA cantidad de cuadros (confirmar aparte).
 * El resumen ("PSNR ... average:X") sale por STDERR incluso con código
 * 0. `averagePsnr: null` si no se encontró esa línea.
 */
export const measurePsnr = (ffmpegPath, env, pathA, pathB) =>
  new Promise((resolve) => {
    const child = spawn(ffmpegPath, ["-i", pathA, "-i", pathB, "-lavfi", "psnr", "-f", "null", "-"], { env });
    let stderr = "";
    child.stderr.on("data", (c) => {
      stderr += c.toString("utf8");
    });
    child.on("close", () => {
      const match = /PSNR[^\n]*average:([\d.]+|inf)/i.exec(stderr);
      resolve({
        averagePsnr: match ? (match[1].toLowerCase() === "inf" ? Infinity : Number(match[1])) : null,
        stderrTail: stderr.slice(-2000),
      });
    });
    child.on("error", () => resolve({ averagePsnr: null, stderrTail: stderr.slice(-2000) }));
  });

/** PSNR (dB) a partir de un error cuadrático medio, para muestras de 8 bits -- `Infinity` si son idénticos. Pura. */
export const psnrFromMse = (mse, maxValue = 255) => (mse <= 0 ? Infinity : 10 * Math.log10((maxValue * maxValue) / mse));

/** PSNR entre dos cuadros crudos del mismo tamaño (Buffer/Uint8Array). Pura. */
export const computeFramePsnr = (a, b) => {
  if (a.length !== b.length || a.length === 0) return null;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return psnrFromMse(sum / a.length);
};

/**
 * Resume una serie de PSNR por cuadro -- pura. `averagePsnr` es el
 * promedio de los cuadros NO idénticos (los idénticos, PSNR infinito,
 * se cuentan aparte en `identicalFrames`; si todos son idénticos,
 * `averagePsnr` es `Infinity`, igual que reporta FFmpeg). `minPsnr` es
 * el peor cuadro -- el dato que delata UN cuadro desalineado aunque el
 * promedio sea alto.
 */
export const summarizePsnrSeries = (values) => {
  const finite = values.filter((v) => Number.isFinite(v));
  const identicalFrames = values.filter((v) => v === Infinity).length;
  const round2 = (n) => Math.round(n * 100) / 100;
  return {
    framesCompared: values.length,
    identicalFrames,
    averagePsnr: values.length === 0 ? null : finite.length === 0 ? Infinity : round2(finite.reduce((s, v) => s + v, 0) / finite.length),
    minPsnr: values.length === 0 ? null : finite.length === 0 ? Infinity : round2(Math.min(...finite)),
  };
};

const createFrameReader = (stream, frameBytes, { highWaterFrames = 8 } = {}) => {
  const chunks = [];
  let buffered = 0;
  let ended = false;
  let waiter = null;
  const wake = () => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w();
    }
  };
  stream.on("data", (c) => {
    chunks.push(c);
    buffered += c.length;
    if (buffered > frameBytes * highWaterFrames) stream.pause();
    wake();
  });
  stream.on("end", () => {
    ended = true;
    wake();
  });
  stream.on("error", () => {
    ended = true;
    wake();
  });
  const next = async () => {
    while (buffered < frameBytes) {
      if (ended) return null; // un resto parcial (cuadro incompleto) se descarta, nunca se compara
      await new Promise((r) => {
        waiter = r;
      });
    }
    const out = Buffer.allocUnsafe(frameBytes);
    let filled = 0;
    while (filled < frameBytes) {
      const head = chunks[0];
      const take = Math.min(head.length, frameBytes - filled);
      head.copy(out, filled, 0, take);
      filled += take;
      if (take === head.length) chunks.shift();
      else chunks[0] = head.subarray(take);
    }
    buffered -= frameBytes;
    if (buffered <= frameBytes * (highWaterFrames / 2)) stream.resume();
    return out;
  };
  return { next };
};

/**
 * Desglosa una serie de PSNR por cuadro (en espacio de cuadros de
 * SALIDA, uno por índice) en resúmenes POR TRAMO y POR EMPALME -- pura.
 *
 * Adenda del auditor, 14-nov-2026, criterio 2: "reporte PSNR por tramo
 * y en cada empalme" -- antes solo existía un promedio/mínimo GLOBAL
 * de todo el video, que no distingue "un defecto real en UN empalme"
 * de "ruido parejo en todos lados" (el 13,8dB mínimo medido en el VPS
 * podía ser cualquiera de los dos, sin esto no había forma de saber
 * cuál). `chunks` es la lista de `planChunks` (cada uno con
 * `outputStartFrame`/`outputEndFrame`/`type`); `byBoundary` cubre una
 * ventana de `boundaryMarginFrames` cuadros a cada lado de CADA punto
 * donde un tramo termina y el siguiente empieza -- el lugar exacto
 * donde viviría un defecto de empalme si lo hay.
 */
export const summarizePsnrByChunks = (values, chunks, { boundaryMarginFrames = 5 } = {}) => {
  if (!Array.isArray(chunks) || chunks.length === 0 || !Array.isArray(values)) return { byChunk: [], byBoundary: [] };
  const byChunk = chunks.map((c) => {
    const slice = values.slice(c.outputStartFrame, c.outputEndFrame);
    return { type: c.type, outputStartFrame: c.outputStartFrame, outputEndFrame: c.outputEndFrame, ...summarizePsnrSeries(slice) };
  });
  const byBoundary = [];
  for (let i = 1; i < chunks.length; i++) {
    const boundaryFrame = chunks[i].outputStartFrame;
    const windowStart = Math.max(0, boundaryFrame - boundaryMarginFrames);
    const windowEnd = Math.min(values.length, boundaryFrame + boundaryMarginFrames);
    const slice = values.slice(windowStart, windowEnd);
    byBoundary.push({ boundaryFrame, fromType: chunks[i - 1].type, toType: chunks[i].type, windowStart, windowEnd, ...summarizePsnrSeries(slice) });
  }
  return { byChunk, byBoundary };
};

/**
 * PSNR cuadro a cuadro entre dos videos decodificados en paralelo con
 * `ffmpegPath` (el de Remotion sirve). Devuelve el resumen de
 * `summarizePsnrSeries` más el conteo total de cuadros de cada lado
 * (si difieren, la comparación solo cubre los comunes y
 * `frameCountMismatch` queda en true -- eso YA es un fallo de
 * equivalencia aunque el PSNR sea alto).
 *
 * `fps` (adenda criterio 2, 14-nov-2026 -- causa raíz real del PSNR
 * mínimo de 13,8dB medido en el VPS): SIN esto, los cuadros se
 * emparejaban por POSICIÓN de lectura cruda -- si un lado tiene una
 * discontinuidad de timestamps en un empalme (normal, documentado en
 * `concatTsFiles`) que hace que el decodificador entregue los cuadros
 * en un orden/cadencia levemente distinto al del otro lado, el cuadro
 * N de un archivo deja de corresponder al cuadro N del otro -- un
 * desajuste de POSICIÓN, no de contenido, que esta herramienta
 * confundía con un defecto visual real. `-r <fps>` como opción de
 * SALIDA de AMBAS decodificaciones fuerza a cada una a entregar
 * EXACTAMENTE un cuadro por cada 1/fps de tiempo de PRESENTACIÓN
 * (duplicando/descartando cuadros para lograrlo, el mismo mecanismo ya
 * usado y probado en `buildPlainPieceFfmpegArgs`) -- así el cuadro N
 * de cualquiera de los dos lados representa el MISMO instante nominal,
 * y comparar por posición ya es, por construcción, comparar por
 * tiempo de presentación. `chunks` (opcional, ver
 * `summarizePsnrByChunks`): si se da, el resultado trae `bySegment`
 * con el desglose por tramo y por empalme.
 */
export const compareVideosPsnr = ({ ffmpegPath, env, pathA, pathB, width = 320, height = 180, fps, chunks, boundaryMarginFrames = 5 }) =>
  new Promise((resolve) => {
    const frameBytes = width * height;
    // `+genpts+igndts` -- confirmado real en CI, 14-nov-2026: SIN estas
    // banderas, esta lectura perdía 1-2 cuadros en un .mp4 ensamblado
    // por tramos (confirmado con el conteo de paquetes de ffprobe en
    // el ARCHIVO, que SIEMPRE dio el total exacto -- la pérdida era de
    // esta lectura, no del archivo). Mismas banderas que
    // `verifyChunkIntegrity` y el remux final, por la misma causa:
    // discontinuidades de PTS/DTS normales entre tramos.
    const spawnRaw = (p) =>
      spawn(
        ffmpegPath,
        [
          "-v", "error", "-fflags", "+genpts+igndts", "-nostdin", "-i", p, "-an",
          "-vf", `scale=${width}:${height}:flags=bilinear`,
          ...(fps ? ["-r", String(fps)] : []),
          "-pix_fmt", "gray", "-f", "image2pipe", "-c:v", "rawvideo", "pipe:1",
        ],
        { env },
      );
    const a = spawnRaw(pathA);
    const b = spawnRaw(pathB);
    let stderr = "";
    for (const child of [a, b]) {
      child.stderr.on("data", (c) => {
        stderr = (stderr + c.toString("utf8")).slice(-2000);
      });
      child.on("error", (err) => {
        stderr = (stderr + String(err?.message ?? err)).slice(-2000);
      });
    }
    const readerA = createFrameReader(a.stdout, frameBytes);
    const readerB = createFrameReader(b.stdout, frameBytes);

    (async () => {
      const values = [];
      let framesA = 0;
      let framesB = 0;
      for (;;) {
        const [fa, fb] = await Promise.all([readerA.next(), readerB.next()]);
        if (fa) framesA++;
        if (fb) framesB++;
        if (!fa || !fb) {
          // Un lado terminó: se sigue contando el otro para reportar el desajuste exacto de cuadros.
          const drain = async (reader, count) => {
            let n = count;
            for (;;) {
              const f = await reader.next();
              if (!f) return n;
              n++;
            }
          };
          if (fa && !fb) framesA = await drain(readerA, framesA);
          if (fb && !fa) framesB = await drain(readerB, framesB);
          break;
        }
        values.push(computeFramePsnr(fa, fb));
      }
      await Promise.all([a, b].map((child) => new Promise((r) => (child.exitCode !== null ? r() : child.once("close", r)))));
      const bySegment = chunks ? summarizePsnrByChunks(values, chunks, { boundaryMarginFrames }) : null;
      resolve({ ...summarizePsnrSeries(values), framesA, framesB, frameCountMismatch: framesA !== framesB, width, height, fps: fps ?? null, bySegment, stderrTail: stderr });
    })().catch((err) => resolve({ framesCompared: 0, identicalFrames: 0, averagePsnr: null, minPsnr: null, framesA: null, framesB: null, frameCountMismatch: true, bySegment: null, stderrTail: `${stderr} ${err?.message ?? err}` }));
  });
