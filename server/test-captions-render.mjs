// PRUEBA DE REGRESIÓN CON REMOTION REAL (criterio 6 del dictamen de
// subtítulos, 31-oct-2026): renderiza un cuadro fijo de dos jobs
// IDÉNTICOS salvo el destino (youtube-16-9 / vertical-9-16) y confirma,
// mirando los píxeles reales del cuadro, que el de YouTube sale SIN
// subtítulos pegados y el vertical SÍ los lleva (así la prueba no pasa
// "por accidente" si el renderizador fallara en silencio para ambos).
//
// Corre en GitHub Actions (.github/workflows/captions-destination-test.yml)
// con Chrome headless real (`npx remotion browser ensure`, lo mismo que
// hace el Dockerfile de producción) -- esta máquina de desarrollo
// (macOS 12) no puede ejecutar Remotion (ver README.md). Usa un video
// base SINTÉTICO (fondo negro) generado con el mismo FFmpeg real de
// producción -- nada de contenido real.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCompositorFfmpeg, resolveCompositorFfprobe, binaryEnv } from "./compositor.mjs";

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

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
const ffmpegEnv = binaryEnv(ffmpegPath);
console.log(`usando FFmpeg real: ${ffmpegPath}`);

const FIXTURES_REL_DIR = "jobs/test-fixtures-captions"; // dentro de public/
const FIXTURES_DIR = path.join(PROJECT_ROOT, "public", FIXTURES_REL_DIR);
await fs.mkdir(FIXTURES_DIR, { recursive: true });

const BASE_VIDEO_REL = `${FIXTURES_REL_DIR}/base.mp4`;
const baseVideoPath = path.join(PROJECT_ROOT, "public", BASE_VIDEO_REL);

// Video sintético: 3s, fondo negro, sin audio -- solo hace falta una
// imagen decodificable, el contenido no importa para esta prueba.
await execFileAsync(
  ffmpegPath,
  ["-y", "-f", "lavfi", "-i", "color=c=black:s=640x360:rate=30:duration=3", "-pix_fmt", "yuv420p", "-c:v", "libx264", baseVideoPath],
  { env: ffmpegEnv },
);

const CAPTION_TEXT = "PRUEBA DE SUBTITULO";
const makeJob = (destination) => ({
  channel: "a-mi-no-me-cuadra",
  destination,
  input: { type: "recorded-video", baseVideo: BASE_VIDEO_REL, durationInSeconds: 3 },
  overlays: [],
  captions: [{ text: CAPTION_TEXT, startMs: 0, endMs: 3000, timestampMs: null, confidence: null }],
  cuts: [],
  zooms: [],
  resources: [],
});

const jobPaths = {};
for (const destination of ["youtube-16-9", "vertical-9-16"]) {
  const relPath = `${FIXTURES_REL_DIR}/${destination}.json`;
  await fs.writeFile(path.join(PROJECT_ROOT, "public", relPath), JSON.stringify(makeJob(destination), null, 2));
  jobPaths[destination] = relPath;
}

/** Cuadro en frame 15 (0.5s a 30fps) -- bien dentro de la ventana del subtítulo (0-3000ms). */
const renderStill = async (jobFileRelPath, outputPngPath) => {
  await execFileAsync(
    "npx",
    ["remotion", "still", "VideoEngine", outputPngPath, `--props=${JSON.stringify({ jobFile: jobFileRelPath })}`, "--frame=15", "--image-format=png"],
    { cwd: PROJECT_ROOT, env: process.env, maxBuffer: 1024 * 1024 * 64 },
  );
};

/** Lee un PNG y devuelve {width, height, pixels: Buffer en RGB24}. */
const readPngAsRgb = async (pngPath) => {
  const { stdout } = await execFileAsync(ffprobePath, [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", pngPath,
  ], { env: ffmpegEnv });
  const [width, height] = stdout.trim().split("x").map(Number);

  const rawPath = `${pngPath}.raw`;
  await execFileAsync(ffmpegPath, ["-y", "-i", pngPath, "-f", "rawvideo", "-pix_fmt", "rgb24", rawPath], { env: ffmpegEnv });
  const pixels = await fs.readFile(rawPath);
  return { width, height, pixels };
};

/**
 * Cuenta píxeles "blanco-ish" (los tres canales por encima del umbral)
 * dentro de la franja inferior donde Captions.tsx ancla el subtítulo
 * (`justifyContent: "flex-end", paddingBottom: 60`) -- el color de
 * fondo del cuadro (negro) y el de la caja del subtítulo
 * (`rgba(0,0,0,0.6)`, semitransparente sobre negro) son indistinguibles
 * por color; el TEXTO blanco (`captionTextColor`) sí lo es.
 */
const countWhitePixelsInCaptionBand = ({ width, height, pixels }, threshold = 200) => {
  const bandTop = Math.floor(height * 0.75);
  let count = 0;
  for (let y = bandTop; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      if (pixels[offset] >= threshold && pixels[offset + 1] >= threshold && pixels[offset + 2] >= threshold) {
        count += 1;
      }
    }
  }
  return count;
};

for (const [destination, jobRelPath] of Object.entries(jobPaths)) {
  const pngPath = path.join(FIXTURES_DIR, `${destination}.png`);
  try {
    await renderStill(jobRelPath, pngPath);
  } catch (err) {
    check(`${destination}: el still de Remotion se renderizó sin error`, false, String(err.message ?? err));
    continue;
  }
  check(`${destination}: el still de Remotion se renderizó sin error`, true);

  const frame = await readPngAsRgb(pngPath);
  const whitePixels = countWhitePixelsInCaptionBand(frame);
  console.log(`[${destination}] píxeles "blanco-ish" en la franja del subtítulo: ${whitePixels}`);

  if (destination === "youtube-16-9") {
    check("youtube-16-9: el MP4 sale SIN subtítulos pegados (sin píxeles de texto en la franja)", whitePixels === 0, `whitePixels=${whitePixels}`);
  } else {
    check("vertical-9-16: SÍ lleva subtítulos pegados (hay píxeles de texto en la franja)", whitePixels > 50, `whitePixels=${whitePixels}`);
  }
}

await fs.rm(FIXTURES_DIR, { recursive: true, force: true });

console.log(failures === 0 ? "\nTODOS LOS TESTS DE RENDER (REMOTION REAL) PASARON" : `\n${failures} TEST(S) DE RENDER FALLARON`);
process.exit(failures === 0 ? 0 : 1);
