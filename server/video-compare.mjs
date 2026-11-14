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
import { spawn } from "node:child_process";

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
 * PSNR cuadro a cuadro entre dos videos decodificados en paralelo con
 * `ffmpegPath` (el de Remotion sirve). Devuelve el resumen de
 * `summarizePsnrSeries` más el conteo total de cuadros de cada lado
 * (si difieren, la comparación solo cubre los comunes y
 * `frameCountMismatch` queda en true -- eso YA es un fallo de
 * equivalencia aunque el PSNR sea alto).
 */
export const compareVideosPsnr = ({ ffmpegPath, env, pathA, pathB, width = 320, height = 180 }) =>
  new Promise((resolve) => {
    const frameBytes = width * height;
    // `+genpts+igndts` -- confirmado real en CI, 14-nov-2026: SIN estas
    // banderas, esta lectura perdía 1-2 cuadros en un .mp4 ensamblado
    // por tramos (confirmado con el conteo de paquetes de ffprobe en
    // el ARCHIVO, que SIEMPRE dio el total exacto -- la pérdida era de
    // esta lectura, no del archivo). Mismas banderas que
    // `verifyChunkIntegrity` y el remux final, por la misma causa:
    // discontinuidades de PTS/DTS normales entre tramos.
    const spawnRaw = (p) => spawn(ffmpegPath, ["-v", "error", "-fflags", "+genpts+igndts", "-nostdin", "-i", p, "-an", "-vf", `scale=${width}:${height}:flags=bilinear`, "-pix_fmt", "gray", "-f", "image2pipe", "-c:v", "rawvideo", "pipe:1"], { env });
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
      resolve({ ...summarizePsnrSeries(values), framesA, framesB, frameCountMismatch: framesA !== framesB, width, height, stderrTail: stderr });
    })().catch((err) => resolve({ framesCompared: 0, identicalFrames: 0, averagePsnr: null, minPsnr: null, framesA: null, framesB: null, frameCountMismatch: true, stderrTail: `${stderr} ${err?.message ?? err}` }));
  });
