// Conversión automática HEVC/H.265 -> H.264 (autorizado por Alex,
// 03-nov-2026). Causa raíz del problema que resuelve: Chromium (usado
// por Remotion para renderizar) no decodifica HEVC/H.265 de forma
// fiable -- formato típico de grabaciones de iPhone -- así que el
// motor rechazaba esos videos y obligaba a convertirlos a mano antes
// de subirlos (ver el comentario de ALLOWED_VIDEO_CODECS en
// index.mjs). Esta función normaliza el video DENTRO del motor, una
// sola vez por entrada, antes del resto del pipeline (transcripción,
// plan editorial, render).
//
// Capacidades REALES del binario de producción
// (@remotion/compositor-linux-x64-gnu), confirmadas en CI con el
// binario real, no asumidas (ver test-video-conversion-regression.mjs
// y el "configuration:" que imprime `ffmpeg -version`):
//   --enable-decoder='...,h264,hevc,...'      -- decodifica HEVC.
//   --enable-encoder=...,libx264,libx265,...  -- codifica H.264.
//   --enable-filter=zscale --enable-filter=tonemap --enable-libzimg
//                                              -- tonemapping HDR->SDR.
// Aun así, cada conversión vuelve a comprobar estas capacidades en
// tiempo de ejecución (`probeFfmpegCapabilities`) antes de intentar un
// tonemap -- si algún día cambia el binario de producción, el sistema
// debe fallar con un error claro, no asumir en silencio.
//
// Solo se auto-convierte HEVC/H.265 (alcance acotado a propósito, ver
// la autorización: "No ampliar innecesariamente el alcance a
// compatibilidad universal con todos los códecs"). Cualquier otro
// códec no soportado sigue rechazándose igual que antes.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fsp from "node:fs/promises";

const execFileAsync = promisify(execFile);

/** Igual que el `safeRename` de index.mjs (duplicado a propósito, como
 * el resto de los módulos pequeños de este proyecto: este archivo debe
 * poder probarse e importarse solo, sin depender de index.mjs). */
const safeRename = async (src, dest) => {
  try {
    await fsp.rename(src, dest);
  } catch (err) {
    if (err.code !== "EXDEV") throw err;
    await fsp.copyFile(src, dest);
    await fsp.unlink(src);
  }
};

/** Único códec que esta función auto-convierte. Todo lo demás que no
 * esté ya en ALLOWED_VIDEO_CODECS sigue rechazándose como hasta ahora. */
export const AUTO_CONVERTIBLE_CODEC = "hevc";

export const isAutoConvertibleCodec = (codecName) => codecName === AUTO_CONVERTIBLE_CODEC;

// --------------------------------------------------------------------
// Lógica pura de decisión -- sin tocar disco ni ejecutar binarios, para
// poder probarla con datos simulados (nivel 2 de honestidad de
// evidencia) sin un FFmpeg real. La ejecución real vive más abajo.
// --------------------------------------------------------------------

/** ffprobe da el frame rate como fracción ("30000/1001", "25/1", a veces "0/0" si no se puede determinar). */
export const parseFrameRateFraction = (rateString) => {
  if (!rateString || typeof rateString !== "string") return null;
  const [numStr, denStr] = rateString.split("/");
  const num = Number(numStr);
  const den = Number(denStr);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  return num / den;
};

// Frecuencias estándar de video -- si la medida real cae cerca de una
// de estas (margen generoso para redondeos de fracciones NTSC), se usa
// el valor estándar exacto en vez del flotante calculado.
const STANDARD_FPS_VALUES = [23.976023976023978, 24, 25, 29.97002997002997, 30, 48, 50, 59.94005994005994, 60];
export const snapToStandardFps = (rawFps) => {
  if (!Number.isFinite(rawFps) || rawFps <= 0) return null;
  for (const standard of STANDARD_FPS_VALUES) {
    if (Math.abs(rawFps - standard) < 0.02) return standard;
  }
  return Math.round(rawFps * 1000) / 1000;
};

/** Grados de rotación (0/90/180/270), normalizados a positivo, leídos
 * del Display Matrix side data (preferido) o del tag "rotate" legado. */
export const detectRotationDegrees = (videoStream) => {
  if (!videoStream) return 0;
  const displayMatrix = (videoStream.side_data_list ?? []).find(
    (sd) => sd && sd.side_data_type === "Display Matrix" && typeof sd.rotation === "number",
  );
  const raw = displayMatrix ? displayMatrix.rotation : videoStream.tags?.rotate !== undefined ? Number(videoStream.tags.rotate) : 0;
  if (!Number.isFinite(raw)) return 0;
  return ((Math.round(raw) % 360) + 360) % 360;
};

/** Metadata de Dolby Vision (side_data_type "DOVI configuration record"), si existe. */
export const detectDolbyVision = (videoStream) => {
  const dovi = (videoStream?.side_data_list ?? []).find(
    (sd) => typeof sd?.side_data_type === "string" && sd.side_data_type.includes("DOVI"),
  );
  if (!dovi) return { present: false };
  return {
    present: true,
    profile: dovi.dv_profile ?? null,
    blPresent: dovi.bl_present_flag === 1,
    elPresent: dovi.el_present_flag === 1,
    rpuPresent: dovi.rpu_present_flag === 1,
  };
};

/** HDR10 (PQ) o HLG a partir de las características de transferencia reportadas por ffprobe. Null si es SDR. */
export const detectHdrTransferKind = (videoStream) => {
  const transfer = videoStream?.color_transfer;
  if (transfer === "smpte2084") return "pq";
  if (transfer === "arib-std-b67") return "hlg";
  return null;
};

/**
 * Decide el plan de conversión completo para un video ya identificado
 * como HEVC: filtros de video, frecuencia de cuadro objetivo y
 * manejo de audio -- o un rechazo explícito con motivo, si no se
 * puede garantizar una conversión fiable con las capacidades
 * disponibles (nunca una conversión silenciosa e incorrecta).
 *
 * `extendedInfo`: { videoStream, audioStream } (de probeExtendedVideoInfo).
 * `capabilities`: { hasZscale, hasTonemap } (de probeFfmpegCapabilities).
 */
export const buildConversionPlan = (extendedInfo, capabilities) => {
  const videoStream = extendedInfo?.videoStream;
  if (!videoStream) {
    return { ok: false, reason: "El archivo no tiene ninguna pista de video legible." };
  }

  const dolbyVision = detectDolbyVision(videoStream);
  const hdrTransferKind = detectHdrTransferKind(videoStream);

  if (dolbyVision.present) {
    // Perfiles sin capa base retrocompatible con HDR10 (el caso más
    // común sin capa base es el perfil 5, de una sola capa con
    // primarias propietarias IPTPQc2) necesitan el RPU de Dolby Vision
    // para tonemapear de forma fiable -- ninguna herramienta de este
    // proyecto lo soporta (no hay libdovi). Los perfiles CON capa base
    // compatible con HDR10 (8.x) sí se tratan como HDR10/PQ normal,
    // ignorando la capa de realce Dolby -- aproximado y declarado como
    // tal, nunca silencioso.
    if (!dolbyVision.blPresent) {
      return {
        ok: false,
        reason: `Dolby Vision perfil ${dolbyVision.profile ?? "desconocido"} sin capa base retrocompatible con HDR10 -- no se puede convertir de forma fiable sin soporte de RPU (no disponible en el FFmpeg de este proyecto). Requiere conversión manual.`,
      };
    }
  }

  const isHdr = hdrTransferKind !== null || dolbyVision.present;
  const videoFilters = [];

  if (isHdr) {
    if (!capabilities?.hasZscale || !capabilities?.hasTonemap) {
      return {
        ok: false,
        reason: `Video HDR detectado (${dolbyVision.present ? `Dolby Vision perfil ${dolbyVision.profile}, capa base compatible` : hdrTransferKind}), pero este FFmpeg no tiene los filtros zscale/tonemap necesarios para convertirlo a SDR de forma fiable. No se genera un archivo con colores incorrectos.`,
      };
    }
    // Cadena estándar de tonemapping HDR10/HLG (PQ) -> SDR bt709:
    // linealiza, tonemapea en RGB float de alta precisión, y vuelve a
    // etiquetar como bt709/rango tv antes de volver a 8 bits para
    // libx264 (que no acepta 10 bits de entrada en este build).
    videoFilters.push(
      "zscale=t=linear:npl=100",
      "format=gbrpf32le",
      "zscale=p=bt709",
      "tonemap=tonemap=hable:desat=0",
      "zscale=t=bt709:m=bt709:r=tv",
      "format=yuv420p",
    );
  } else {
    // Sin HDR: igual puede venir en 10 bits (HEVC Main10 sin ser HDR)
    // o en un subsampling que libx264 no acepta -- format=yuv420p
    // cubre ambos casos sin tocar el color SDR ya correcto.
    videoFilters.push("format=yuv420p");
  }

  const rawFps = parseFrameRateFraction(videoStream.avg_frame_rate) ?? parseFrameRateFraction(videoStream.r_frame_rate);
  const targetFps = snapToStandardFps(rawFps);

  const audioStream = extendedInfo.audioStream;
  const audioArgs = !audioStream
    ? ["-an"]
    : audioStream.codec_name === "aac"
      ? ["-map", "0:a:0", "-c:a", "copy"]
      : ["-map", "0:a:0", "-c:a", "aac", "-b:a", "192k"];

  return {
    ok: true,
    isHdr,
    hdrKind: dolbyVision.present ? "dolby-vision" : hdrTransferKind,
    dolbyVisionProfile: dolbyVision.present ? dolbyVision.profile : null,
    rotationDegrees: detectRotationDegrees(videoStream),
    videoFilters,
    targetFps,
    audioArgs,
    hasAudio: Boolean(audioStream),
  };
};

/** Arma los argumentos completos de ffmpeg para `plan` (de buildConversionPlan). Pura, sin ejecutar nada. */
export const buildFfmpegArgs = ({ inputPath, outputPath, plan, threads, preset, crf }) => [
  "-y",
  "-i",
  inputPath,
  "-map",
  "0:v:0",
  ...plan.audioArgs,
  "-vf",
  plan.videoFilters.join(","),
  ...(plan.targetFps ? ["-r", String(plan.targetFps)] : []),
  "-c:v",
  "libx264",
  "-preset",
  preset,
  "-crf",
  String(crf),
  "-pix_fmt",
  "yuv420p",
  "-threads",
  String(threads),
  "-movflags",
  "+faststart",
  outputPath,
];

// --------------------------------------------------------------------
// Ejecución real (ffmpeg/ffprobe de verdad) -- probada solo en CI con
// el binario real de producción (test-video-conversion-regression.mjs),
// igual que audio-analysis.mjs/quality-gate.mjs con sus
// realDetectSilences/realRunFfmpeg.
// --------------------------------------------------------------------

/** Códec/ancho/alto/duración de un video, en una sola pasada de
 * ffprobe -- igual al `probeVideoInfo` que ya existía en index.mjs
 * (movido acá para que este módulo no dependa de index.mjs y se pueda
 * probar/importar solo; index.mjs ahora delega a esta misma función). */
export const probeBasicVideoInfo = async (filePath, { ffprobePath, env }) => {
  const { stdout } = await execFileAsync(
    ffprobePath,
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,width,height",
      "-show_entries",
      "format=duration",
      "-of",
      "default=nw=1",
      filePath,
    ],
    { env },
  );
  const fields = Object.fromEntries(
    stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const idx = line.indexOf("=");
        return [line.slice(0, idx), line.slice(idx + 1)];
      }),
  );
  return {
    codec: fields.codec_name,
    width: fields.width ? Number(fields.width) : null,
    height: fields.height ? Number(fields.height) : null,
    durationSeconds: fields.duration ? Number(fields.duration) : null,
  };
};

/** Probe extendido (JSON completo de ffprobe) -- necesario para leer
 * side_data_list (rotación, Dolby Vision) y color_transfer, que el
 * `probeVideoInfo` liviano de index.mjs no pide. */
export const probeExtendedVideoInfo = async (filePath, { ffprobePath, env }) => {
  const { stdout } = await execFileAsync(
    ffprobePath,
    ["-v", "error", "-show_streams", "-show_format", "-of", "json", filePath],
    { env, maxBuffer: 16 * 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout);
  const streams = parsed.streams ?? [];
  return {
    videoStream: streams.find((s) => s.codec_type === "video") ?? null,
    audioStream: streams.find((s) => s.codec_type === "audio") ?? null,
    format: parsed.format ?? null,
  };
};

let cachedCapabilities = null;
/** Solo para pruebas: fuerza a `probeFfmpegCapabilities` a volver a consultar el binario real. */
export const __resetFfmpegCapabilitiesCacheForTesting = () => {
  cachedCapabilities = null;
};

/** Consulta real (una sola vez, cacheada) de qué filtros tiene el
 * binario de ffmpeg en uso -- nunca se asume zscale/tonemap presentes. */
export const probeFfmpegCapabilities = async (ffmpegPath, env) => {
  if (cachedCapabilities) return cachedCapabilities;
  const { stdout } = await execFileAsync(ffmpegPath, ["-hide_banner", "-filters"], { env, maxBuffer: 8 * 1024 * 1024 });
  const names = stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[1])
    .filter(Boolean);
  cachedCapabilities = {
    hasZscale: names.includes("zscale"),
    hasTonemap: names.includes("tonemap"),
  };
  return cachedCapabilities;
};

class ConversionTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConversionTimeoutError";
  }
}

/**
 * Ejecuta la conversión real con ffmpeg (spawn, no execFile: puede
 * tardar minutos en un video largo y necesitamos progreso + poder
 * matarlo). Nunca borra `inputPath` -- eso lo decide el llamador,
 * después de verificar `outputPath` (ver normalizeVideoCodec).
 */
export const runFfmpegConversion = ({
  ffmpegPath,
  env,
  inputPath,
  outputPath,
  plan,
  durationSeconds,
  threads = 4,
  preset = "veryfast",
  crf = 20,
  timeoutMs = 0,
  onProgress,
  registerChild,
}) =>
  new Promise((resolve, reject) => {
    const args = buildFfmpegArgs({ inputPath, outputPath, plan, threads, preset, crf });
    const child = spawn(ffmpegPath, args, { env });
    registerChild?.(child);

    let stderrTail = "";
    let timedOut = false;
    let timer = null;

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderrTail = (stderrTail + text).slice(-4000);
      const match = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
      if (match && durationSeconds > 0) {
        const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
        onProgress?.({ percent: Math.min(100, Math.round((seconds / durationSeconds) * 1000) / 10), timeSeconds: seconds });
      }
    });

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 10_000);
      }, timeoutMs);
    }

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        reject(new ConversionTimeoutError(`La conversión de video superó el límite de tiempo (${Math.round(timeoutMs / 60000)} min). Última salida de ffmpeg: ${stderrTail}`));
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg (conversión de video) salió con code=${code} signal=${signal}. Última salida: ${stderrTail}`));
      }
    });
  });

export { ConversionTimeoutError };

/**
 * Orquesta la normalización completa de un video de entrada: si el
 * códec ya está permitido, solo lo mueve a `destPath`; si es
 * HEVC/H.265, lo convierte automáticamente a H.264 (probe extendido +
 * capacidades reales + plan + conversión + verificación + reemplazo
 * atómico); cualquier otro códec se rechaza igual que antes. Vive acá
 * (no en index.mjs) para poder probarse con el FFmpeg real en CI sin
 * levantar el servidor (igual que el resto de este módulo) -- es
 * EXACTAMENTE la función que usa server/index.mjs en producción, no
 * una reimplementación paralela para pruebas.
 *
 * `sourcePath` nunca se borra antes de verificar que la conversión
 * terminó bien: en caso de códec no soportado se borra de entrada
 * (igual que el comportamiento previo a esta función); en caso de
 * fallo de conversión se preserva; solo se borra al final, una vez
 * que el archivo convertido pasó la verificación y fue renombrado a
 * `destPath`.
 *
 * Dependencias inyectadas (para pruebas y para no importar nada de
 * index.mjs): `ffmpegPath`/`ffprobePath`/`env` ya resueltos por quien
 * llama; `onStatus(patch)`/`onLog(message)` opcionales; `registerChild`
 * opcional (para poder cancelar, ver index.mjs); `isCancelled()` +
 * `makeCancelledError()` opcionales (si no se pasan, un proceso matado
 * durante la conversión se reporta como error común, no como
 * cancelación).
 */
export const normalizeVideoInputCodec = async ({
  jobId,
  sourcePath,
  destPath,
  allowedCodecs,
  ffmpegPath,
  ffprobePath,
  env,
  threads = 4,
  preset = "veryfast",
  crf = 20,
  timeoutMs = 0,
  onStatus = () => {},
  onLog = () => {},
  registerChild = () => {},
  unregisterChild = () => {},
  isCancelled = () => false,
  makeCancelledError = (id) => new Error(`El trabajo ${id} fue cancelado.`),
}) => {
  const info = await probeBasicVideoInfo(sourcePath, { ffprobePath, env }).catch(async (probeErr) => {
    // Un archivo que ni ffprobe puede leer nunca va a poder usarse --
    // se descarta de entrada, igual que un códec no soportado, para no
    // dejarlo huérfano (ver requisito "evitar archivos huérfanos").
    await fsp.unlink(sourcePath).catch(() => {});
    throw new Error(`No se pudo leer el video (formato no reconocido o archivo dañado): ${probeErr.message ?? probeErr}`);
  });

  if (allowedCodecs.has(info.codec)) {
    await safeRename(sourcePath, destPath);
    return info;
  }

  if (!isAutoConvertibleCodec(info.codec)) {
    await fsp.unlink(sourcePath).catch(() => {});
    throw new Error(
      `Códec de video "${info.codec}" no soportado. H.264/VP8/VP9/AV1 se aceptan directamente; HEVC/H.265 (típico de iPhone) se convierte automáticamente. Este códec no es ninguno de esos -- convierte el video antes de subirlo.`,
    );
  }

  onLog(
    `video HEVC/H.265 detectado (${info.width}x${info.height}, ${info.durationSeconds?.toFixed(1) ?? "?"}s) -- iniciando conversión automática a H.264.`,
  );
  onStatus({ status: "converting" });

  const extended = await probeExtendedVideoInfo(sourcePath, { ffprobePath, env });
  const capabilities = await probeFfmpegCapabilities(ffmpegPath, env);
  const plan = buildConversionPlan(extended, capabilities);

  if (!plan.ok) {
    await fsp.unlink(sourcePath).catch(() => {});
    throw new Error(`No se pudo convertir el video HEVC: ${plan.reason}`);
  }

  onLog(
    `plan de conversión -- HDR: ${plan.isHdr ? plan.hdrKind : "no"}` +
      `${plan.dolbyVisionProfile ? ` (Dolby Vision perfil ${plan.dolbyVisionProfile})` : ""}, ` +
      `rotación detectada: ${plan.rotationDegrees}°, fps objetivo: ${plan.targetFps ?? "sin cambio"}, ` +
      `audio: ${!plan.hasAudio ? "sin pista de audio" : plan.audioArgs.includes("copy") ? "copiado sin recodificar" : "recodeado a AAC"}.`,
  );

  const tempOutputPath = `${destPath}.converting.mp4`;
  const startedAt = Date.now();
  let lastWrittenPercent = -10;

  try {
    await runFfmpegConversion({
      ffmpegPath,
      env,
      inputPath: sourcePath,
      outputPath: tempOutputPath,
      plan,
      durationSeconds: info.durationSeconds ?? 0,
      threads,
      preset,
      crf,
      timeoutMs,
      onProgress: ({ percent, timeSeconds }) => {
        if (percent - lastWrittenPercent >= 1) {
          lastWrittenPercent = percent;
          onStatus({ status: "converting", conversionPercent: percent });
          if (Math.round(percent) % 10 === 0) {
            onLog(`conversión HEVC->H.264 en curso: ${percent}% (${timeSeconds.toFixed(0)}s de ${info.durationSeconds?.toFixed(0) ?? "?"}s).`);
          }
        }
      },
      registerChild,
    });
  } catch (err) {
    unregisterChild();
    await fsp.unlink(tempOutputPath).catch(() => {});
    if (isCancelled()) {
      throw makeCancelledError(jobId);
    }
    throw new Error(`Falló la conversión HEVC->H.264: ${err.message ?? err}`);
  }
  unregisterChild();

  const conversionSeconds = (Date.now() - startedAt) / 1000;
  const convertedInfo = await probeBasicVideoInfo(tempOutputPath, { ffprobePath, env }).catch((probeErr) => {
    throw new Error(`La conversión terminó pero el archivo resultante no se pudo verificar: ${probeErr.message ?? probeErr}`);
  });

  const toleranceSeconds = Math.max(2, (info.durationSeconds ?? 0) * 0.05);
  const durationOk =
    !info.durationSeconds ||
    (convertedInfo.durationSeconds > 0 && Math.abs(convertedInfo.durationSeconds - info.durationSeconds) <= toleranceSeconds);

  if (!allowedCodecs.has(convertedInfo.codec) || !durationOk) {
    await fsp.unlink(tempOutputPath).catch(() => {});
    throw new Error(
      `La conversión HEVC->H.264 terminó pero el archivo resultante no pasó la verificación (códec resultante="${convertedInfo.codec}", duración original=${info.durationSeconds}s, duración convertida=${convertedInfo.durationSeconds}s).`,
    );
  }

  const originalSizeBytes = await fsp.stat(sourcePath).then((s) => s.size).catch(() => null);
  await safeRename(tempOutputPath, destPath);
  await fsp.unlink(sourcePath).catch(() => {});
  const convertedSizeBytes = await fsp.stat(destPath).then((s) => s.size).catch(() => null);

  onLog(
    `conversión HEVC->H.264 verificada OK: ${info.width}x${info.height} -> ${convertedInfo.width}x${convertedInfo.height}, ` +
      `duración ${convertedInfo.durationSeconds?.toFixed(1)}s, tardó ${conversionSeconds.toFixed(1)}s de proceso, ` +
      `tamaño ${originalSizeBytes ?? "?"} -> ${convertedSizeBytes ?? "?"} bytes.`,
  );

  return convertedInfo;
};
