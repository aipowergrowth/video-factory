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
import zlib from "node:zlib";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCompositorFfmpeg, binaryEnv } from "./compositor.mjs";

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
const ffmpegEnv = binaryEnv(ffmpegPath);
console.log(`usando FFmpeg real: ${ffmpegPath}`);

const FIXTURES_REL_DIR = "jobs/test-fixtures-captions"; // dentro de public/
const FIXTURES_DIR = path.join(PROJECT_ROOT, "public", FIXTURES_REL_DIR);
await fs.mkdir(FIXTURES_DIR, { recursive: true });

const BASE_VIDEO_REL = `${FIXTURES_REL_DIR}/base.mp4`;
const baseVideoPath = path.join(PROJECT_ROOT, "public", BASE_VIDEO_REL);

// Video sintético: 3s, fondo negro, sin audio -- solo hace falta una
// imagen decodificable, el contenido no importa para esta prueba.
// "color" NO está en la lista de filtros habilitados del FFmpeg de
// producción (confirmado en CI: "No such filter: 'color'") -- "nullsrc"
// sí lo está y produce frames negros; se limita la duración con `-t`
// (opción de salida, no depende de qué filtros estén habilitados) en
// vez de un parámetro del propio filtro.
await execFileAsync(
  ffmpegPath,
  ["-y", "-f", "lavfi", "-i", "nullsrc=size=640x360:rate=30", "-t", "3", "-pix_fmt", "yuv420p", "-c:v", "libx264", baseVideoPath],
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

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Deshace el filtro PNG de una fila usando la fila anterior ya reconstruida (spec PNG 9.2). */
const unfilterRow = (filterType, row, previousRow, bpp) => {
  const out = Buffer.alloc(row.length);
  for (let i = 0; i < row.length; i++) {
    const a = i >= bpp ? out[i - bpp] : 0; // izquierda
    const b = previousRow ? previousRow[i] : 0; // arriba
    const c = i >= bpp && previousRow ? previousRow[i - bpp] : 0; // arriba-izquierda
    let value = row[i];
    if (filterType === 1) value += a;
    else if (filterType === 2) value += b;
    else if (filterType === 3) value += Math.floor((a + b) / 2);
    else if (filterType === 4) {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }
    out[i] = value & 0xff;
  }
  return out;
};

/**
 * Decodificador PNG mínimo (sin dependencias) -- soporta lo que produce
 * Remotion/Chrome con `--image-format=png`: 8 bits por canal, RGB o
 * RGBA, sin interlazado, sin paleta. No hace falta más: esta prueba
 * solo necesita leer los píxeles del cuadro renderizado, no soportar
 * cualquier PNG posible.
 */
const decodePng = (buffer) => {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("No es un PNG válido (falta la firma).");
  }
  let offset = 8;
  let width, height, bitDepth, colorType;
  const idatChunks = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    if (type === "IHDR") {
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      bitDepth = buffer.readUInt8(dataStart + 8);
      colorType = buffer.readUInt8(dataStart + 9);
      const interlace = buffer.readUInt8(dataStart + 12);
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
        throw new Error(`PNG no soportado por este decodificador mínimo (bitDepth=${bitDepth}, colorType=${colorType}, interlace=${interlace}).`);
      }
    } else if (type === "IDAT") {
      idatChunks.push(buffer.subarray(dataStart, dataStart + length));
    } else if (type === "IEND") {
      break;
    }
    offset = dataStart + length + 4; // +4 = CRC
  }

  const channels = colorType === 6 ? 4 : 3;
  const bpp = channels; // 8 bits por canal
  const stride = 1 + width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idatChunks));

  const pixels = Buffer.alloc(width * height * channels);
  let previousRow = null;
  for (let y = 0; y < height; y++) {
    const rowStart = y * stride;
    const filterType = raw[rowStart];
    const filteredRow = raw.subarray(rowStart + 1, rowStart + stride);
    const row = unfilterRow(filterType, filteredRow, previousRow, bpp);
    row.copy(pixels, y * width * channels);
    previousRow = row;
  }

  return { width, height, channels, pixels };
};

/** Lee un PNG (del render de Remotion) y devuelve {width, height, channels, pixels}. */
const readPngAsRgb = async (pngPath) => decodePng(await fs.readFile(pngPath));

/**
 * Cuenta píxeles "blanco-ish" (los tres canales por encima del umbral)
 * dentro de la franja inferior donde Captions.tsx ancla el subtítulo
 * (`justifyContent: "flex-end", paddingBottom: 60`) -- el color de
 * fondo del cuadro (negro) y el de la caja del subtítulo
 * (`rgba(0,0,0,0.6)`, semitransparente sobre negro) son indistinguibles
 * por color; el TEXTO blanco (`captionTextColor`) sí lo es.
 */
const countWhitePixelsInCaptionBand = ({ width, height, channels, pixels }, threshold = 200) => {
  const bandTop = Math.floor(height * 0.75);
  let count = 0;
  for (let y = bandTop; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * channels;
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
