// PRUEBA SIMULADA (nivel 2 de honestidad de evidencia, CLAUDE.md) --
// server/segment-render.mjs + server/segment-assemble.mjs: solo las
// partes puras (armado de argumentos/filtros, sin ejecutar FFmpeg ni
// Remotion). La confirmación de que el render selectivo funciona de
// verdad (splicing, cortes fuera de keyframe, fuente con FPS
// variable, sincronía de audio, equivalencia visual frente al render
// completo -- puerta G1) vive en test-render-observability.mjs (CI,
// Linux real) -- no se puede ejecutar un render real en esta máquina
// de desarrollo (ver README.md).

import { buildPlainChunkFfmpegArgs } from "./segment-render.mjs";
import { buildAudioFilterComplex } from "./segment-assemble.mjs";

let failures = 0;
const check = (label, cond, detail = "") => {
  if (!cond) {
    failures++;
    console.log(`FAIL: ${label}${detail ? ` -- ${detail}` : ""}`);
  } else {
    console.log(`ok: ${label}`);
  }
};

// --- buildPlainChunkFfmpegArgs ---

{
  const args = buildPlainChunkFfmpegArgs({
    sourceVideoPath: "/src.mp4",
    chunk: { sourceStartSeconds: 4, sourceEndSeconds: 6.5 },
    outputPath: "/out.mp4",
    width: 1920,
    height: 1080,
    fps: 30,
  });
  check("buildPlainChunkFfmpegArgs: -ss ANTES de -i (frame-accurate con re-encode, no snap al keyframe)", args.indexOf("-ss") < args.indexOf("-i") && args[args.indexOf("-ss") + 1] === "4");
  check("buildPlainChunkFfmpegArgs: -t con la duración exacta del chunk (6.5-4=2.5s)", args[args.indexOf("-t") + 1] === "2.5");
  check("buildPlainChunkFfmpegArgs: -an (sin audio -- se construye aparte una sola vez)", args.includes("-an"));
  check("buildPlainChunkFfmpegArgs: -vf escala la resolución (sin el filtro 'fps', no compilado en el ffmpeg de Remotion)", args[args.indexOf("-vf") + 1] === "scale=1920:1080:flags=lanczos");
  check("buildPlainChunkFfmpegArgs: -r normaliza a FPS constante como opción de SALIDA (fuente con FPS variable), no como filtro", args[args.indexOf("-r") + 1] === "30");
  check("buildPlainChunkFfmpegArgs: crf por defecto 18 (el mismo que usa Remotion por defecto, confirmado real en una corrida de --log=verbose)", args.includes("18"));
}

{
  const args = buildPlainChunkFfmpegArgs({ sourceVideoPath: "/src.mp4", chunk: { sourceStartSeconds: 0, sourceEndSeconds: 1 }, outputPath: "/out.mp4", width: 640, height: 360, fps: 30, crf: 23, preset: "fast" });
  check("buildPlainChunkFfmpegArgs: crf/preset configurables", args[args.indexOf("-crf") + 1] === "23" && args[args.indexOf("-preset") + 1] === "fast");
}

// --- buildAudioFilterComplex ---

{
  const timeline = { segments: [{ sourceStart: 0, sourceEnd: 4 }, { sourceStart: 6, sourceEnd: 10 }], outputDurationInSeconds: 8 };
  const filter = buildAudioFilterComplex(timeline);
  check("buildAudioFilterComplex: un atrim por tramo SOBREVIVIENTE (2 tramos -> 2 atrim)", (filter.match(/atrim/g) ?? []).length === 2);
  check("buildAudioFilterComplex: los límites de cada atrim son los del tramo real (0-4 y 6-10, NUNCA el original completo)", filter.includes("atrim=start=0:end=4") && filter.includes("atrim=start=6:end=10"));
  check("buildAudioFilterComplex: concat con n=2 (un tramo por segmento sobreviviente)", filter.includes("concat=n=2:v=0:a=1[aout]"));
}

check("buildAudioFilterComplex: sin ningún tramo sobreviviente (línea de tiempo vacía) -> null, nunca un filtro vacío/inválido", buildAudioFilterComplex({ segments: [] }) === null);

console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
process.exit(failures === 0 ? 0 : 1);
