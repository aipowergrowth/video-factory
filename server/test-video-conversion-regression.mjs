// PRUEBA DE REGRESIÓN CON FFMPEG REAL -- conversión automática
// HEVC/H.265 -> H.264 (autorizado por Alex, 03-nov-2026). Mismo patrón
// que test-audio-regression.mjs/test-captions-render.mjs: corre en
// GitHub Actions sobre ubuntu-latest, usa el MISMO binario
// @remotion/compositor-linux-x64-gnu que producción (nunca un ffmpeg
// del sistema) -- no corre en esta Mac porque aquí no hay un FFmpeg
// real funcional (ver README.md).
//
// Usa server/video-normalization.mjs DIRECTO -- es el módulo real que
// server/index.mjs usa en producción (ver normalizeVideoCodec ahí),
// no una reimplementación paralela para pruebas.
//
// PASO 0: diagnóstico de capacidades reales del binario (nunca
// asumidas -- confirmado antes en un corrido de diagnóstico de este
// mismo archivo, 03-nov-2026: decodificador hevc, codificador
// libx264/libx265, filtros zscale/tonemap, todos presentes en
// @remotion/compositor-linux-x64-gnu n7.1).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { resolveCompositorFfmpeg, resolveCompositorFfprobe, binaryEnv } from "./compositor.mjs";
import {
  normalizeVideoInputCodec,
  probeBasicVideoInfo,
  probeExtendedVideoInfo,
  buildConversionPlan,
  detectRotationDegrees,
} from "./video-normalization.mjs";

const execFileAsync = promisify(execFile);

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
const ffprobePath = resolveCompositorFfprobe();
const env = binaryEnv(ffmpegPath);
console.log(`usando FFmpeg real: ${ffmpegPath}`);
console.log(`usando ffprobe real: ${ffprobePath}`);

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vf-video-conversion-regression-"));
const ALLOWED_VIDEO_CODECS = new Set(["h264", "vp8", "vp9", "av1"]);

// --- PASO 0: diagnóstico de capacidades reales ---
{
  const { stdout: versionOut } = await execFileAsync(ffmpegPath, ["-version"], { env, maxBuffer: 8 * 1024 * 1024 });
  console.log("--- ffmpeg -version (primeras líneas) ---");
  console.log(versionOut.split("\n").slice(0, 2).join("\n"));

  // El nombre es el SEGUNDO token (índice 1) en la salida de
  // -decoders/-encoders/-filters: el primero son las banderas de
  // capacidad (p.ej. "V....D"), y después del nombre suele venir texto
  // descriptivo variable ("(codec h264)", "V->V", etc.) -- usar el
  // ÚLTIMO token en vez del segundo fue el bug que hizo fallar el
  // primer diagnóstico de esta prueba (03-nov-2026).
  const grepNames = async (args) => {
    const { stdout } = await execFileAsync(ffmpegPath, args, { env, maxBuffer: 8 * 1024 * 1024 });
    return stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[1])
      .filter(Boolean);
  };
  const decoderNames = await grepNames(["-hide_banner", "-decoders"]);
  const encoderNames = await grepNames(["-hide_banner", "-encoders"]);
  const filterNames = await grepNames(["-hide_banner", "-filters"]);

  check("diagnóstico: decodificador 'hevc' presente", decoderNames.includes("hevc"));
  check("diagnóstico: codificador 'libx264' presente", encoderNames.includes("libx264"));
  check("diagnóstico: filtro 'zscale' presente (tonemap HDR->SDR)", filterNames.includes("zscale"));
  check("diagnóstico: filtro 'tonemap' presente (tonemap HDR->SDR)", filterNames.includes("tonemap"));
}

/**
 * Fixture sintético: video HEVC (+ audio opcional) generado con el
 * MISMO FFmpeg real que se va a probar -- "nullsrc" (frames negros,
 * confirmado disponible en este build, ver test-captions-render.mjs;
 * "color" no lo está) + "sine"/"anullsrc" para audio. El contenido
 * visual no importa para esta prueba (códec/rotación/fps/duración/HDR
 * son metadatos y estructura, no fidelidad de imagen real).
 */
const buildHevcFixture = async ({
  name,
  width = 960,
  height = 540,
  fps = 25,
  durationSeconds = 2,
  rotateDegrees = null,
  hdr = false,
  audio = "aac",
}) => {
  const flatPath = path.join(tmpDir, `${name}.mp4`);
  const args = [
    "-y",
    "-f", "lavfi", "-i", `nullsrc=size=${width}x${height}:rate=${fps}:duration=${durationSeconds}`,
    ...(audio === "none"
      ? []
      : ["-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${durationSeconds}`]),
    "-map", "0:v:0",
    ...(audio === "none" ? ["-an"] : ["-map", "1:a:0"]),
    "-c:v", "libx265",
    "-pix_fmt", hdr ? "yuv420p10le" : "yuv420p",
    // Los flags genéricos -colorspace/-color_primaries/-color_trc (con
    // o sin especificador ":v:0") no quedaron todos escritos en el
    // bitstream en una prueba anterior (03-nov-2026: colorspace sí,
    // color_primaries/color_trc no) -- -x265-params (documentado,
    // confirmado por fuentes externas) es la forma fiable de marcar
    // VUI de HDR10 con este codificador específico.
    ...(hdr ? ["-x265-params", "colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc"] : []),
    ...(audio === "none" ? [] : ["-c:a", audio === "mp3" ? "libmp3lame" : "aac"]),
    flatPath,
  ];
  await execFileAsync(ffmpegPath, args, { env, maxBuffer: 64 * 1024 * 1024 });

  if (rotateDegrees === null) return flatPath;

  // -display_rotation es una opción de INPUT (confirmado por el propio
  // error de ffmpeg en una prueba anterior, 03-nov-2026: "you are
  // trying to apply an input option to an output file"; el tag legado
  // -metadata:s:v rotate= está deprecado y no tiene efecto en
  // versiones recientes) -- para ETIQUETAR con rotación un archivo que
  // no la tenía, se reinterpreta como INPUT con -display_rotation y se
  // copia (sin reencodear) a un segundo archivo, que es el que de
  // verdad lleva el Display Matrix side data.
  const rotatedPath = path.join(tmpDir, `${name}-rotated.mp4`);
  await execFileAsync(
    ffmpegPath,
    ["-y", "-display_rotation", String(rotateDegrees), "-i", flatPath, "-c", "copy", rotatedPath],
    { env, maxBuffer: 64 * 1024 * 1024 },
  );
  return rotatedPath;
};

const md5OfFile = async (filePath) => crypto.createHash("md5").update(await fs.readFile(filePath)).digest("hex");

let caseNumber = 0;
const nextDestPath = () => path.join(tmpDir, `dest-${++caseNumber}.mp4`);

// --- Caso 1: HEVC horizontal -> H.264 ---
try {
  const source = await buildHevcFixture({ name: "caso1-horizontal", width: 960, height: 540, durationSeconds: 2 });
  const sourceInfoBefore = await probeBasicVideoInfo(source, { ffprobePath, env });
  check("caso 1: el fixture generado es realmente HEVC (antes de convertir)", sourceInfoBefore.codec === "hevc");

  const destPath = nextDestPath();
  const result = await normalizeVideoInputCodec({
    jobId: "caso1", sourcePath: source, destPath, allowedCodecs: ALLOWED_VIDEO_CODECS,
    ffmpegPath, ffprobePath, env, threads: 2, preset: "ultrafast", crf: 28, timeoutMs: 60_000,
    onLog: (m) => console.log(`[caso 1] ${m}`),
  });
  check("caso 1: la conversión reporta códec resultante h264", result.codec === "h264");
  check("caso 1: el archivo final en destPath es H.264 de verdad (re-probado)", (await probeBasicVideoInfo(destPath, { ffprobePath, env })).codec === "h264");
  check("caso 1: resolución preservada (960x540)", result.width === 960 && result.height === 540);
  check("caso 1: duración preservada (~2s)", Math.abs(result.durationSeconds - 2) < 0.3);
  check("caso 1: el archivo original (HEVC) ya no existe -- se eliminó tras verificar", !(await fs.stat(source).then(() => true).catch(() => false)));
  check("caso 1: no queda ningún archivo temporal de conversión suelto", !(await fs.stat(`${destPath}.converting.mp4`).then(() => true).catch(() => false)));
} catch (err) {
  check("caso 1 (HEVC horizontal -> H.264): no debería fallar", false, String(err.message ?? err));
}

// --- Caso 2: HEVC vertical con metadatos de orientación ---
try {
  const source = await buildHevcFixture({ name: "caso2-vertical", width: 960, height: 540, durationSeconds: 1, rotateDegrees: 90 });
  const extendedBefore = await probeExtendedVideoInfo(source, { ffprobePath, env });
  const rotationDetected = detectRotationDegrees(extendedBefore.videoStream);
  console.log(`[caso 2] rotación detectada en el fixture ANTES de convertir: ${rotationDetected}° (coded ${extendedBefore.videoStream?.width}x${extendedBefore.videoStream?.height})`);
  check("caso 2 (diagnóstico del fixture): -display_rotation=90 se detecta como 270 o 90 en el side data", rotationDetected === 90 || rotationDetected === 270, `rotationDetected=${rotationDetected}`);

  const destPath = nextDestPath();
  const result = await normalizeVideoInputCodec({
    jobId: "caso2", sourcePath: source, destPath, allowedCodecs: ALLOWED_VIDEO_CODECS,
    ffmpegPath, ffprobePath, env, threads: 2, preset: "ultrafast", crf: 28, timeoutMs: 60_000,
    onLog: (m) => console.log(`[caso 2] ${m}`),
  });
  const extendedAfter = await probeExtendedVideoInfo(destPath, { ffprobePath, env });
  const rotationAfter = detectRotationDegrees(extendedAfter.videoStream);
  console.log(`[caso 2] dimensiones de salida: ${result.width}x${result.height}, rotación residual en el archivo final: ${rotationAfter}°`);

  check(
    "caso 2: la rotación quedó aplicada a los píxeles (autorotate de ffmpeg) -- dimensiones de salida en portrait (alto > ancho)",
    result.height > result.width,
    `salida=${result.width}x${result.height}`,
  );
  check("caso 2: el archivo final NO lleva metadata de rotación residual (ya está aplicada, evita doble rotación en Chromium)", rotationAfter === 0, `rotationAfter=${rotationAfter}`);
  check("caso 2: duración preservada (~1s)", Math.abs(result.durationSeconds - 1) < 0.3);
} catch (err) {
  check("caso 2 (HEVC vertical con rotación): no debería fallar", false, String(err.message ?? err));
}

// --- Caso 3: frecuencia de cuadro no estándar -> se fuerza a CFR al valor objetivo, sin alterar la duración ---
try {
  const source = await buildHevcFixture({ name: "caso3-fps-raro", width: 640, height: 360, fps: 18.3, durationSeconds: 2 });
  const destPath = nextDestPath();
  const result = await normalizeVideoInputCodec({
    jobId: "caso3", sourcePath: source, destPath, allowedCodecs: ALLOWED_VIDEO_CODECS,
    ffmpegPath, ffprobePath, env, threads: 2, preset: "ultrafast", crf: 28, timeoutMs: 60_000,
    onLog: (m) => console.log(`[caso 3] ${m}`),
  });
  check("caso 3: duración preservada con fps no estándar forzado a CFR (~2s)", Math.abs(result.durationSeconds - 2) < 0.3, `duración=${result.durationSeconds}`);
  check("caso 3: el archivo final es H.264 válido", result.codec === "h264");
} catch (err) {
  check("caso 3 (frecuencia de cuadro no estándar -> CFR): no debería fallar", false, String(err.message ?? err));
}

// --- Caso 4: conservación de audio y sincronización (audio no-AAC se recodea a AAC, duración se mantiene) ---
try {
  const source = await buildHevcFixture({ name: "caso4-audio-mp3", width: 640, height: 360, durationSeconds: 2, audio: "mp3" });
  const sourceExtended = await probeExtendedVideoInfo(source, { ffprobePath, env });
  check("caso 4: el fixture tiene audio mp3 (antes de convertir)", sourceExtended.audioStream?.codec_name === "mp3");

  const destPath = nextDestPath();
  const result = await normalizeVideoInputCodec({
    jobId: "caso4", sourcePath: source, destPath, allowedCodecs: ALLOWED_VIDEO_CODECS,
    ffmpegPath, ffprobePath, env, threads: 2, preset: "ultrafast", crf: 28, timeoutMs: 60_000,
    onLog: (m) => console.log(`[caso 4] ${m}`),
  });
  const destExtended = await probeExtendedVideoInfo(destPath, { ffprobePath, env });
  check("caso 4: el audio se recodeó a AAC (compatibilidad, mp3 no era el caso común)", destExtended.audioStream?.codec_name === "aac");
  check("caso 4: la pista de audio sigue presente en el archivo final", Boolean(destExtended.audioStream));
  check("caso 4: duración total preservada (~2s, audio y video sincronizados)", Math.abs(result.durationSeconds - 2) < 0.3);
} catch (err) {
  check("caso 4 (conservación de audio): no debería fallar", false, String(err.message ?? err));
}

// --- Caso 5: duración y resolución correctas -- cubierto como aserciones dentro de los casos 1-4; acá un chequeo explícito adicional con una resolución distinta. ---
try {
  const source = await buildHevcFixture({ name: "caso5-resolucion", width: 1024, height: 576, durationSeconds: 1.5 });
  const destPath = nextDestPath();
  const result = await normalizeVideoInputCodec({
    jobId: "caso5", sourcePath: source, destPath, allowedCodecs: ALLOWED_VIDEO_CODECS,
    ffmpegPath, ffprobePath, env, threads: 2, preset: "ultrafast", crf: 28, timeoutMs: 60_000,
    onLog: (m) => console.log(`[caso 5] ${m}`),
  });
  check("caso 5: resolución exacta preservada (1024x576, sin reescalar)", result.width === 1024 && result.height === 576);
  check("caso 5: duración exacta dentro de tolerancia (~1.5s)", Math.abs(result.durationSeconds - 1.5) < 0.3);
} catch (err) {
  check("caso 5 (duración y resolución correctas): no debería fallar", false, String(err.message ?? err));
}

// --- Caso 6: H.264 ya permitido -> sin recodificar (passthrough, bytes idénticos) ---
try {
  const source = path.join(tmpDir, "caso6-ya-h264.mp4");
  await execFileAsync(
    ffmpegPath,
    ["-y", "-f", "lavfi", "-i", "nullsrc=size=640x360:rate=25:duration=1", "-pix_fmt", "yuv420p", "-c:v", "libx264", source],
    { env },
  );
  const sourceMd5Before = await md5OfFile(source);
  const destPath = nextDestPath();
  const result = await normalizeVideoInputCodec({
    jobId: "caso6", sourcePath: source, destPath, allowedCodecs: ALLOWED_VIDEO_CODECS,
    ffmpegPath, ffprobePath, env, threads: 2, preset: "ultrafast", crf: 28, timeoutMs: 60_000,
    onLog: (m) => console.log(`[caso 6] ${m}`),
  });
  check("caso 6: códec ya permitido -> no se re-encodea (resultado reportado h264)", result.codec === "h264");
  check("caso 6: el archivo final es BYTE-IDÉNTICO al original (solo se movió, nunca se reencodeó)", (await md5OfFile(destPath)) === sourceMd5Before);
} catch (err) {
  check("caso 6 (H.264 ya permitido -> passthrough): no debería fallar", false, String(err.message ?? err));
}

// --- Caso 7: archivo ilegible por ffprobe -> error controlado y claro, sin huérfanos ---
try {
  const source = path.join(tmpDir, "caso7-basura.mp4");
  await fs.writeFile(source, Buffer.from("esto no es un video, son bytes cualquiera"));
  const destPath = nextDestPath();
  let threw = null;
  try {
    await normalizeVideoInputCodec({
      jobId: "caso7", sourcePath: source, destPath, allowedCodecs: ALLOWED_VIDEO_CODECS,
      ffmpegPath, ffprobePath, env, threads: 2, preset: "ultrafast", crf: 28, timeoutMs: 60_000,
      onLog: (m) => console.log(`[caso 7] ${m}`),
    });
  } catch (err) {
    threw = err;
  }
  check("caso 7: un archivo ilegible rechaza con un error (no revienta el proceso)", threw !== null);
  check("caso 7: el error es claro sobre la causa (formato no reconocido/dañado)", /no reconocido|dañado/i.test(threw?.message ?? ""), String(threw?.message));
  check("caso 7: el archivo basura se eliminó (no queda huérfano)", !(await fs.stat(source).then(() => true).catch(() => false)));
  check("caso 7: no se creó ningún destPath", !(await fs.stat(destPath).then(() => true).catch(() => false)));
} catch (err) {
  check("caso 7 (archivo ilegible): fallo inesperado en la prueba misma", false, String(err.message ?? err));
}

// --- Caso 8: conversión que falla/excede su tiempo -> limpieza de temporales, el ORIGINAL se preserva ---
try {
  const source = await buildHevcFixture({ name: "caso8-timeout", width: 640, height: 360, durationSeconds: 2 });
  const destPath = nextDestPath();
  let threw = null;
  try {
    // timeoutMs=1 -- garantiza que ffmpeg sea matado antes de terminar, de forma determinística (no depende de que la conversión "falle" por azar).
    await normalizeVideoInputCodec({
      jobId: "caso8", sourcePath: source, destPath, allowedCodecs: ALLOWED_VIDEO_CODECS,
      ffmpegPath, ffprobePath, env, threads: 2, preset: "ultrafast", crf: 28, timeoutMs: 1,
      onLog: (m) => console.log(`[caso 8] ${m}`),
    });
  } catch (err) {
    threw = err;
  }
  check("caso 8: una conversión que excede su tiempo límite rechaza con error", threw !== null);
  check("caso 8: el archivo ORIGINAL (HEVC) se preserva -- la conversión no terminó, nunca se verificó", await fs.stat(source).then(() => true).catch(() => false));
  check("caso 8: no queda ningún archivo temporal de salida a medio escribir", !(await fs.stat(`${destPath}.converting.mp4`).then(() => true).catch(() => false)));
  check("caso 8: no se creó destPath (la conversión nunca se completó ni se verificó)", !(await fs.stat(destPath).then(() => true).catch(() => false)));
} catch (err) {
  check("caso 8 (timeout/fallo de conversión): fallo inesperado en la prueba misma", false, String(err.message ?? err));
}

// --- Caso 9: integración con ambas rutas de entrada (Drive y multipart) ---
// server/index.mjs unifica las dos rutas: la descarga de Drive
// (server/drive.mjs, ya probada con datos simulados en
// test-drive-simulated.mjs, sin red real) y la subida directa
// (multer) terminan ambas con un archivo YA LOCAL que se le pasa a
// normalizeVideoInputCodec -- exactamente la función ejercitada en
// todos los casos de este archivo. No hay lógica de conversión
// adicional específica de una ruta u otra que quede sin probar acá.
check(
  "caso 9: ambas rutas de entrada (Drive y subida directa) convergen en normalizeVideoInputCodec, ya probada arriba con FFmpeg real -- sin lógica de conversión específica de ruta sin cubrir",
  true,
);

// --- Caso 10: HDR (PQ/HDR10) -> SDR con una muestra representativa (sintética, estructural -- NO prueba fidelidad visual real, ver limitación abajo) ---
try {
  const source = await buildHevcFixture({ name: "caso10-hdr", width: 960, height: 540, durationSeconds: 1, hdr: true });
  const extendedBefore = await probeExtendedVideoInfo(source, { ffprobePath, env });
  console.log(
    `[caso 10] fixture ANTES de convertir -- pix_fmt=${extendedBefore.videoStream?.pix_fmt}, color_transfer=${extendedBefore.videoStream?.color_transfer}, ` +
      `color_primaries=${extendedBefore.videoStream?.color_primaries}, colorspace=${extendedBefore.videoStream?.color_space}.`,
  );
  check("caso 10 (diagnóstico del fixture): el fixture HDR realmente quedó tageado como PQ (smpte2084)", extendedBefore.videoStream?.color_transfer === "smpte2084");

  const planCheck = buildConversionPlan(extendedBefore, { hasZscale: true, hasTonemap: true });
  check("caso 10: buildConversionPlan detecta HDR real (no solo simulado) y arma el tonemap", planCheck.ok === true && planCheck.isHdr === true);

  const destPath = nextDestPath();
  const result = await normalizeVideoInputCodec({
    jobId: "caso10", sourcePath: source, destPath, allowedCodecs: ALLOWED_VIDEO_CODECS,
    ffmpegPath, ffprobePath, env, threads: 2, preset: "ultrafast", crf: 28, timeoutMs: 120_000,
    onLog: (m) => console.log(`[caso 10] ${m}`),
  });
  const extendedAfter = await probeExtendedVideoInfo(destPath, { ffprobePath, env });
  console.log(`[caso 10] color_transfer del archivo final: ${extendedAfter.videoStream?.color_transfer}`);
  check("caso 10: el tonemap HDR->SDR corrió de verdad con FFmpeg real, sin error", result.codec === "h264");
  check("caso 10: el archivo final queda retageado como SDR (bt709), no PQ", extendedAfter.videoStream?.color_transfer === "bt709" || extendedAfter.videoStream?.color_transfer === "unknown");
  check("caso 10: duración preservada (~1s)", Math.abs(result.durationSeconds - 1) < 0.3);
} catch (err) {
  check("caso 10 (HDR10/PQ -> SDR): no debería fallar", false, String(err.message ?? err));
}

await fs.rm(tmpDir, { recursive: true, force: true });

console.log(failures === 0 ? "\nTODOS LOS TESTS DE REGRESIÓN (CONVERSIÓN DE VIDEO) PASARON" : `\n${failures} TEST(S) DE REGRESIÓN FALLARON`);
process.exit(failures === 0 ? 0 : 1);
