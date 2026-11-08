// Diagnóstico del video FUENTE antes de renderizar (Fase 0, render
// trabado, 08-nov-2026, autorizado por Alex, criterio 2). Motivado por
// el job real 1fd239de-8f9e-4642-8e42-d848b17d8481: un render de 23
// min (41.331 cuadros) se quedó en "0/41331 cuadros (0%)" durante más
// de 43 minutos sin avanzar NI UN cuadro, sin que se supiera nada de
// las características del video fuente. El motor nunca había
// registrado códec/FPS/bitrate/intervalo de keyframes de la entrada.
//
// Causa raíz investigada contra evidencia externa (no asumida): un
// mantenedor de Remotion confirmó en una discusión pública que
// OffthreadVideo se vuelve muy lento (o directamente se cuelga, según
// otro issue del mismo repositorio, "sat for 70 minutes until we
// killed it", "every process at 0% CPU") cuando el video fuente tiene
// MUY POCOS keyframes -- FFmpeg tiene que decodificar una porción
// grande del video antes de poder entregar el cuadro pedido. Ver el
// informe de esta tarea para las citas completas y los enlaces.
//
// Intervalo de keyframes: se cuenta cuántos paquetes de video tienen
// la bandera "K" (keyframe) sobre el total, y se divide la duración
// entre esa cuenta -- NUNCA se intenta calcular el intervalo EXACTO
// restando pts_time entre keyframes consecutivos, porque ffprobe
// devuelve los paquetes en orden de DECODIFICACIÓN, no de
// presentación (confirmado real en CI, 08-nov-2026: con B-frames, el
// segundo paquete de la lista puede tener un pts_time MENOR que el
// primero) -- el promedio por conteo es inmune a ese orden.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Umbrales propios (no vienen de la documentación de Remotion/FFmpeg,
 * que no fija ningún número) -- un intervalo de keyframes de más de
 * unos pocos segundos ya se reportó como causa de lentitud severa de
 * OffthreadVideo (ver el comentario de arriba); por encima de ~8-10s
 * se trata como riesgo alto. Ajustables sin tocar la lógica, son solo
 * para que la línea de log sea legible sin tener que interpretar los
 * números a mano.
 */
export const classifyKeyframeIntervalRisk = (avgKeyframeIntervalSeconds) => {
  if (avgKeyframeIntervalSeconds === null) return "desconocido";
  if (avgKeyframeIntervalSeconds <= 2) return "bajo";
  if (avgKeyframeIntervalSeconds <= 6) return "medio";
  return "alto";
};

/**
 * Probe completo del video fuente: códec, resolución, duración,
 * bitrate, tamaño, FPS (constante o variable), y el intervalo
 * promedio de keyframes -- todo lo que pide el criterio 2. Se hacen
 * DOS llamadas a ffprobe (streams/format, y paquetes) porque pedir
 * todo junto con "-show_packets" infla demasiado la salida de
 * "-show_streams" por job real largo; separarlas es más liviano.
 */
export const probeSourceVideoDiagnostics = async (filePath, { ffprobePath, env }) => {
  const { stdout: streamsRaw } = await execFileAsync(
    ffprobePath,
    ["-v", "error", "-select_streams", "v:0", "-show_streams", "-show_format", "-of", "json", filePath],
    { env, maxBuffer: 16 * 1024 * 1024 },
  );
  const parsedStreams = JSON.parse(streamsRaw);
  const videoStream = (parsedStreams.streams ?? []).find((s) => s.codec_type === "video") ?? null;
  const format = parsedStreams.format ?? null;

  // Solo las banderas de cada paquete (sin pts_time, sin nada más) --
  // lo más liviano posible para no sumarle su propio costo a un
  // video ya largo. Para 41.331 cuadros esto es un escaneo de
  // paquetes (no una decodificación de cuadros), del orden de
  // segundos, no minutos.
  const { stdout: packetsRaw } = await execFileAsync(
    ffprobePath,
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=flags", "-of", "json", filePath],
    { env, maxBuffer: 64 * 1024 * 1024 },
  );
  const packets = JSON.parse(packetsRaw).packets ?? [];
  const totalPackets = packets.length;
  const keyframeCount = packets.filter((p) => typeof p.flags === "string" && p.flags.startsWith("K")).length;

  const durationSeconds = format?.duration ? Number(format.duration) : null;
  const avgKeyframeIntervalSeconds =
    durationSeconds !== null && keyframeCount > 0 ? Math.round((durationSeconds / keyframeCount) * 100) / 100 : null;

  const rFrameRate = videoStream?.r_frame_rate ?? null;
  const avgFrameRate = videoStream?.avg_frame_rate ?? null;
  const likelyVfr = rFrameRate !== null && avgFrameRate !== null && rFrameRate !== avgFrameRate;

  return {
    codec: videoStream?.codec_name ?? null,
    width: videoStream?.width ?? null,
    height: videoStream?.height ?? null,
    durationSeconds,
    bitRateBps: format?.bit_rate ? Number(format.bit_rate) : null,
    sizeBytes: format?.size ? Number(format.size) : null,
    rFrameRate,
    avgFrameRate,
    likelyVfr,
    totalPackets,
    keyframeCount,
    avgKeyframeIntervalSeconds,
    keyframeIntervalRisk: classifyKeyframeIntervalRisk(avgKeyframeIntervalSeconds),
  };
};

/** Una sola línea legible para el log de Portainer -- criterio 2: "debe verse en el log". */
export const formatSourceVideoDiagnosticsLine = (diag) => {
  const mb = diag.sizeBytes !== null ? (diag.sizeBytes / 1024 / 1024).toFixed(1) : "?";
  const kbps = diag.bitRateBps !== null ? Math.round(diag.bitRateBps / 1000) : "?";
  return (
    `códec=${diag.codec ?? "?"} ${diag.width ?? "?"}x${diag.height ?? "?"}, duración=${diag.durationSeconds?.toFixed(1) ?? "?"}s, ` +
    `tamaño=${mb}MB, bitrate=${kbps}kbps, fps_declarado=${diag.rFrameRate ?? "?"} fps_promedio=${diag.avgFrameRate ?? "?"}` +
    `${diag.likelyVfr ? " (POSIBLE FPS VARIABLE -- declarado y promedio no coinciden)" : " (fps constante)"}, ` +
    `keyframes=${diag.keyframeCount}/${diag.totalPackets} cuadros, intervalo promedio=${diag.avgKeyframeIntervalSeconds ?? "?"}s ` +
    `(riesgo de lentitud/cuelgue en OffthreadVideo: ${diag.keyframeIntervalRisk})`
  );
};
