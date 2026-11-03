// PRUEBA SIMULADA (nivel 2 de honestidad de evidencia, CLAUDE.md) --
// lógica de decisión pura de server/video-normalization.mjs: qué
// códecs se auto-convierten, cómo se detecta rotación/Dolby
// Vision/HDR a partir de un `videoStream` de ffprobe (simulado, sin
// ningún binario real), y qué plan de conversión arma
// `buildConversionPlan` para cada combinación. La ejecución REAL contra
// el FFmpeg de producción vive en test-video-conversion-regression.mjs
// (CI, GitHub Actions) -- acá no se toca ningún binario ni archivo real.

import {
  isAutoConvertibleCodec,
  parseFrameRateFraction,
  snapToStandardFps,
  detectRotationDegrees,
  detectDolbyVision,
  detectHdrTransferKind,
  buildConversionPlan,
  buildFfmpegArgs,
} from "./video-normalization.mjs";

let failures = 0;
const check = (label, cond, detail = "") => {
  if (!cond) {
    failures++;
    console.log(`FAIL: ${label}${detail ? ` -- ${detail}` : ""}`);
  } else {
    console.log(`ok: ${label}`);
  }
};

// --- Alcance: solo HEVC se auto-convierte ---
check("isAutoConvertibleCodec: hevc sí", isAutoConvertibleCodec("hevc") === true);
check("isAutoConvertibleCodec: h264 no (ya permitido, no necesita convertirse)", isAutoConvertibleCodec("h264") === false);
check("isAutoConvertibleCodec: vp9 no", isAutoConvertibleCodec("vp9") === false);
check("isAutoConvertibleCodec: mpeg2video no (fuera de alcance, sigue rechazándose)", isAutoConvertibleCodec("mpeg2video") === false);
check("isAutoConvertibleCodec: codec desconocido/undefined no", isAutoConvertibleCodec(undefined) === false);

// --- parseFrameRateFraction / snapToStandardFps ---
check("parseFrameRateFraction: '30000/1001' (NTSC 29.97)", Math.abs(parseFrameRateFraction("30000/1001") - 29.97002997) < 1e-6);
check("parseFrameRateFraction: '25/1'", parseFrameRateFraction("25/1") === 25);
check("parseFrameRateFraction: '0/0' (desconocido) -> null", parseFrameRateFraction("0/0") === null);
check("parseFrameRateFraction: undefined -> null", parseFrameRateFraction(undefined) === null);
check("snapToStandardFps: 29.97002997 ajusta exacto a la fracción NTSC estándar", snapToStandardFps(29.97002997002997) === 29.97002997002997);
check("snapToStandardFps: 29.976 (medido, con redondeo) ajusta a 29.97 estándar", Math.abs(snapToStandardFps(29.976) - 29.97002997002997) < 1e-6);
check("snapToStandardFps: 24.001 ajusta a 24", snapToStandardFps(24.001) === 24);
check("snapToStandardFps: 18.3 (no estándar, VFR raro) se deja como está (redondeado a 3 decimales)", snapToStandardFps(18.3) === 18.3);
check("snapToStandardFps: null/0 -> null", snapToStandardFps(0) === null && snapToStandardFps(null) === null);

// --- detectRotationDegrees ---
check(
  "detectRotationDegrees: Display Matrix rotation=-90 -> 270 (normalizado a positivo)",
  detectRotationDegrees({ side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }] }) === 270,
);
check(
  "detectRotationDegrees: Display Matrix rotation=90 -> 90",
  detectRotationDegrees({ side_data_list: [{ side_data_type: "Display Matrix", rotation: 90 }] }) === 90,
);
check(
  "detectRotationDegrees: sin Display Matrix pero con tag legado rotate=180",
  detectRotationDegrees({ tags: { rotate: "180" } }) === 180,
);
check("detectRotationDegrees: sin ninguna rotación -> 0", detectRotationDegrees({}) === 0);
check("detectRotationDegrees: videoStream null -> 0 (no revienta)", detectRotationDegrees(null) === 0);

// --- detectDolbyVision ---
check("detectDolbyVision: sin side_data -> present=false", detectDolbyVision({}).present === false);
{
  const dv = detectDolbyVision({
    side_data_list: [{ side_data_type: "DOVI configuration record", dv_profile: 8, bl_present_flag: 1, el_present_flag: 0, rpu_present_flag: 1 }],
  });
  check("detectDolbyVision: perfil 8 con capa base detectado", dv.present === true && dv.profile === 8 && dv.blPresent === true);
}
{
  const dv = detectDolbyVision({
    side_data_list: [{ side_data_type: "DOVI configuration record", dv_profile: 5, bl_present_flag: 0, el_present_flag: 0, rpu_present_flag: 1 }],
  });
  check("detectDolbyVision: perfil 5 (sin capa base) detectado como tal", dv.present === true && dv.profile === 5 && dv.blPresent === false);
}

// --- detectHdrTransferKind ---
check("detectHdrTransferKind: smpte2084 -> 'pq'", detectHdrTransferKind({ color_transfer: "smpte2084" }) === "pq");
check("detectHdrTransferKind: arib-std-b67 -> 'hlg'", detectHdrTransferKind({ color_transfer: "arib-std-b67" }) === "hlg");
check("detectHdrTransferKind: bt709 (SDR) -> null", detectHdrTransferKind({ color_transfer: "bt709" }) === null);
check("detectHdrTransferKind: sin color_transfer -> null", detectHdrTransferKind({}) === null);

const SDR_CAPS = { hasZscale: true, hasTonemap: true };
const NO_TONEMAP_CAPS = { hasZscale: false, hasTonemap: false };

// --- buildConversionPlan: casos principales ---
{
  // SDR normal, 29.97fps, audio AAC -- el caso más común (iPhone típico).
  const plan = buildConversionPlan(
    {
      videoStream: { color_transfer: "bt709", avg_frame_rate: "30000/1001", r_frame_rate: "30000/1001" },
      audioStream: { codec_name: "aac" },
    },
    SDR_CAPS,
  );
  check("plan SDR típico: ok=true", plan.ok === true);
  check("plan SDR típico: isHdr=false", plan.isHdr === false);
  check("plan SDR típico: filtros = solo format=yuv420p (sin tonemap)", plan.videoFilters.join(",") === "format=yuv420p");
  check("plan SDR típico: fps objetivo ajustado a 29.97 estándar", Math.abs(plan.targetFps - 29.97002997002997) < 1e-6);
  check("plan SDR típico: audio se copia (ya es AAC, sin recodificar)", plan.audioArgs.includes("copy"));
}

{
  // HDR10 (PQ) con capacidades disponibles -- debe armar la cadena de tonemap completa.
  const plan = buildConversionPlan(
    {
      videoStream: { color_transfer: "smpte2084", avg_frame_rate: "25/1", r_frame_rate: "25/1" },
      audioStream: { codec_name: "ac3" },
    },
    SDR_CAPS,
  );
  check("plan HDR10 (PQ): ok=true", plan.ok === true);
  check("plan HDR10 (PQ): isHdr=true, hdrKind='pq'", plan.isHdr === true && plan.hdrKind === "pq");
  check("plan HDR10 (PQ): cadena de filtros incluye zscale+tonemap+zscale+format", plan.videoFilters.join(",").includes("zscale=t=linear") && plan.videoFilters.join(",").includes("tonemap=tonemap=hable") && plan.videoFilters.at(-1) === "format=yuv420p");
  check("plan HDR10 (PQ): audio no es AAC -- se recodea a AAC (compatibilidad)", plan.audioArgs.includes("aac") && !plan.audioArgs.includes("copy"));
}

{
  // HDR detectado pero el binario NO tiene zscale/tonemap -- debe rechazar con motivo claro, nunca generar un archivo con colores incorrectos.
  const plan = buildConversionPlan(
    { videoStream: { color_transfer: "smpte2084" }, audioStream: null },
    NO_TONEMAP_CAPS,
  );
  check("plan HDR sin zscale/tonemap disponibles: ok=false", plan.ok === false);
  check("plan HDR sin zscale/tonemap disponibles: el motivo menciona zscale/tonemap", /zscale|tonemap/i.test(plan.reason));
}

{
  // Dolby Vision perfil 8 (capa base HDR10-compatible) -- se trata como HDR10/PQ aproximado.
  const plan = buildConversionPlan(
    {
      videoStream: {
        color_transfer: "smpte2084",
        side_data_list: [{ side_data_type: "DOVI configuration record", dv_profile: 8, bl_present_flag: 1, el_present_flag: 1, rpu_present_flag: 1 }],
      },
      audioStream: { codec_name: "aac" },
    },
    SDR_CAPS,
  );
  check("plan Dolby Vision perfil 8 (capa base compatible): ok=true (aproximado vía HDR10)", plan.ok === true);
  check("plan Dolby Vision perfil 8: hdrKind='dolby-vision', dolbyVisionProfile=8", plan.hdrKind === "dolby-vision" && plan.dolbyVisionProfile === 8);
}

{
  // Dolby Vision perfil 5 (sin capa base retrocompatible) -- debe rechazar con error claro, NUNCA generar un archivo con colores incorrectos.
  const plan = buildConversionPlan(
    {
      videoStream: {
        color_transfer: "smpte2084",
        side_data_list: [{ side_data_type: "DOVI configuration record", dv_profile: 5, bl_present_flag: 0, el_present_flag: 0, rpu_present_flag: 1 }],
      },
      audioStream: null,
    },
    SDR_CAPS,
  );
  check("plan Dolby Vision perfil 5 (sin capa base): ok=false, nunca se genera un SDR incorrecto en silencio", plan.ok === false);
  check("plan Dolby Vision perfil 5: el motivo menciona el perfil y la falta de soporte RPU", /perfil 5/.test(plan.reason) && /RPU/i.test(plan.reason));
}

{
  // Sin pista de video -- debe rechazar de inmediato.
  const plan = buildConversionPlan({ videoStream: null, audioStream: null }, SDR_CAPS);
  check("plan sin pista de video: ok=false", plan.ok === false);
}

{
  // Sin pista de audio -- "-an", no debe intentar mapear audio inexistente.
  const plan = buildConversionPlan({ videoStream: { color_transfer: "bt709" }, audioStream: null }, SDR_CAPS);
  check("plan sin audio: ok=true, hasAudio=false, audioArgs=['-an']", plan.ok === true && plan.hasAudio === false && plan.audioArgs.join(",") === "-an");
}

{
  // Rotación detectada se propaga al plan (para el log de observabilidad), aunque ffmpeg la aplique solo via autorotate.
  const plan = buildConversionPlan(
    { videoStream: { color_transfer: "bt709", side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }] }, audioStream: null },
    SDR_CAPS,
  );
  check("plan con rotación: rotationDegrees=270 queda expuesto para el log", plan.rotationDegrees === 270);
}

// --- buildFfmpegArgs: forma correcta de los argumentos (pura, sin ejecutar nada) ---
{
  const plan = { videoFilters: ["format=yuv420p"], targetFps: 29.97002997002997, audioArgs: ["-map", "0:a:0", "-c:a", "copy"] };
  const args = buildFfmpegArgs({ inputPath: "/tmp/in.mp4", outputPath: "/tmp/out.mp4", plan, threads: 4, preset: "veryfast", crf: 20 });
  check("buildFfmpegArgs: incluye -i con el input correcto", args[args.indexOf("-i") + 1] === "/tmp/in.mp4");
  check("buildFfmpegArgs: mapea explícitamente el video 0:v:0", args.includes("0:v:0"));
  check("buildFfmpegArgs: -vf con la cadena de filtros del plan", args[args.indexOf("-vf") + 1] === "format=yuv420p");
  check("buildFfmpegArgs: -r con el fps objetivo del plan", args[args.indexOf("-r") + 1] === "29.97002997002997");
  check("buildFfmpegArgs: codifica a libx264, nunca a hevc/libx265", args[args.indexOf("-c:v") + 1] === "libx264");
  check("buildFfmpegArgs: pix_fmt yuv420p explícito (compatibilidad libx264)", args[args.indexOf("-pix_fmt") + 1] === "yuv420p");
  check("buildFfmpegArgs: -threads respeta el límite pasado (4, igual al límite de CPU del contenedor)", args[args.indexOf("-threads") + 1] === "4");
  check("buildFfmpegArgs: el archivo de salida es el último argumento", args.at(-1) === "/tmp/out.mp4");
  check("buildFfmpegArgs: -movflags +faststart para reproducción/streaming", args.includes("+faststart"));
  check("buildFfmpegArgs: -y para sobrescribir sin preguntar (archivo temporal propio)", args[0] === "-y");
}
{
  // Sin targetFps (no se pudo determinar) -- no debe agregar -r en absoluto.
  const plan = { videoFilters: ["format=yuv420p"], targetFps: null, audioArgs: ["-an"] };
  const args = buildFfmpegArgs({ inputPath: "in.mp4", outputPath: "out.mp4", plan, threads: 2, preset: "fast", crf: 23 });
  check("buildFfmpegArgs: sin targetFps, no se agrega -r", !args.includes("-r"));
  check("buildFfmpegArgs: sin audio, -an presente", args.includes("-an"));
}

console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
process.exit(failures === 0 ? 0 : 1);
