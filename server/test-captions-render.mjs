// PRUEBA DE REGRESIÓN CON REMOTION REAL (criterio 6 del dictamen de
// subtítulos, 31-oct-2026, más la verificación de render de "graphic"
// del dictamen de Fase 3B, mismo día): renderiza un cuadro fijo de dos
// jobs IDÉNTICOS salvo el destino (youtube-16-9 / vertical-9-16) y
// confirma, mirando los píxeles reales del cuadro, que el de YouTube
// sale SIN subtítulos pegados y el vertical SÍ los lleva (así la
// prueba no pasa "por accidente" si el renderizador fallara en
// silencio para ambos). Además renderiza un tercer job con un recurso
// `graphic`/`stat` (sin tocar ningún banco externo) para confirmar que
// `ResourceRenderer` de verdad lo despacha a un componente visible.
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

// Fase 3B (31-oct-2026): confirma con un render REAL (no solo tsc) que
// ResourceRenderer de verdad despacha "graphic" a los componentes
// existentes (Chart/CycleDiagram/StatCallout) -- sin tocar ningún banco
// externo, no hace falta clave de Pixabay para esta prueba.
const graphicJobRelPath = `${FIXTURES_REL_DIR}/graphic-test.json`;
await fs.writeFile(
  path.join(PROJECT_ROOT, "public", graphicJobRelPath),
  JSON.stringify(
    {
      channel: "a-mi-no-me-cuadra",
      destination: "youtube-16-9",
      input: { type: "recorded-video", baseVideo: BASE_VIDEO_REL, durationInSeconds: 3 },
      overlays: [],
      captions: [],
      cuts: [],
      zooms: [],
      resources: [
        {
          id: "test-graphic",
          startSeconds: 0,
          endSeconds: 3,
          type: "graphic",
          description: "prueba de render real",
          graphicVariant: "stat",
          graphicData: { value: "73%", label: "prueba de render real" },
          editorialGoal: "evidence",
          segment: "development",
          intensity: "moderate",
          veracityRequirement: "illustrative-ok",
          essential: false,
        },
      ],
    },
    null,
    2,
  ),
);

// Estilo dinámico vertical (03-nov-2026, autorizado por Alex): un
// recurso "emoji" (requiere fonts-noto-color-emoji en el contenedor,
// ver Dockerfile) + subtítulos con desglose por palabra (ver
// server/captions.mjs#groupCaptions) -- una línea con DOS palabras,
// "UNO" (0-1500ms) y "DOS" (1500-3000ms), para confirmar con un render
// real que la palabra resaltada cambia de una a otra, no un color fijo.
const dynamicStyleJobRelPath = `${FIXTURES_REL_DIR}/dynamic-style-test.json`;
await fs.writeFile(
  path.join(PROJECT_ROOT, "public", dynamicStyleJobRelPath),
  JSON.stringify(
    {
      channel: "a-mi-no-me-cuadra", // theme.accentColor = "#E53935" (rojo), conocido para esta prueba
      destination: "vertical-9-16",
      input: { type: "recorded-video", baseVideo: BASE_VIDEO_REL, durationInSeconds: 3 },
      overlays: [],
      captions: [
        {
          text: "UNO DOS",
          startMs: 0,
          endMs: 3000,
          timestampMs: null,
          confidence: null,
          words: [
            { text: "UNO", startFraction: 0, endFraction: 0.5 },
            { text: "DOS", startFraction: 0.5, endFraction: 1 },
          ],
        },
      ],
      cuts: [],
      zooms: [],
      resources: [
        {
          id: "test-emoji",
          startSeconds: 0,
          endSeconds: 3,
          type: "emoji",
          description: "prueba de render real",
          emojiChar: "🚨",
          editorialGoal: "emotion",
          segment: "development",
          intensity: "moderate",
          veracityRequirement: "illustrative-ok",
          essential: false,
        },
      ],
    },
    null,
    2,
  ),
);

/** Cuadro en el frame pedido (15 por defecto = 0.5s a 30fps) -- bien dentro de la ventana del subtítulo (0-3000ms). */
const renderStill = async (jobFileRelPath, outputPngPath, frame = 15) => {
  await execFileAsync(
    "npx",
    ["remotion", "still", "VideoEngine", outputPngPath, `--props=${JSON.stringify({ jobFile: jobFileRelPath })}`, `--frame=${frame}`, "--image-format=png"],
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
 * dentro de una franja vertical del cuadro (fracción de alto 0-1) -- el
 * fondo negro del cuadro y las cajas semitransparentes (`rgba(0,0,0,x)`)
 * son indistinguibles por color del fondo; el TEXTO claro (blanco en
 * `Captions`, gris claro `#d8d8dc` en la etiqueta de `StatCallout`) sí
 * lo es.
 */
const countWhitePixelsInBand = ({ width, height, channels, pixels }, { topFraction, bottomFraction }, threshold = 200) => {
  const bandTop = Math.floor(height * topFraction);
  const bandBottom = Math.floor(height * bottomFraction);
  let count = 0;
  for (let y = bandTop; y < bandBottom; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * channels;
      if (pixels[offset] >= threshold && pixels[offset + 1] >= threshold && pixels[offset + 2] >= threshold) {
        count += 1;
      }
    }
  }
  return count;
};
const countWhitePixelsInCaptionBand = (frame, threshold) => countWhitePixelsInBand(frame, { topFraction: 0.75, bottomFraction: 1 }, threshold);
const countWhitePixelsInCenterBand = (frame, threshold) => countWhitePixelsInBand(frame, { topFraction: 0.35, bottomFraction: 0.65 }, threshold);

/**
 * Cuenta píxeles "con color real" (no grises/blancos/negros: la
 * diferencia entre su canal más alto y más bajo supera el umbral) en
 * una región rectangular del cuadro (fracciones de ancho/alto 0-1).
 * Estilo dinámico vertical (03-nov-2026): el fondo del fixture es negro
 * puro (max-min=0) y el texto de subtítulos/CTA es blanco o gris (igual
 * max-min bajo) -- un emoji con fuente de color (`fonts-noto-color-emoji`,
 * ver Dockerfile) tiene matices reales (rojo/azul/amarillo), así que
 * esto distingue "hay un emoji de verdad" de "tofu" (un glifo vacío
 * también sería monocromático) o de cualquier otro texto ya existente.
 */
const countColorfulPixelsInRegion = (
  { width, height, channels, pixels },
  { leftFraction, rightFraction, topFraction, bottomFraction },
  saturationThreshold = 40,
) => {
  const left = Math.floor(width * leftFraction);
  const right = Math.floor(width * rightFraction);
  const top = Math.floor(height * topFraction);
  const bottom = Math.floor(height * bottomFraction);
  let count = 0;
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const offset = (y * width + x) * channels;
      const r = pixels[offset];
      const g = pixels[offset + 1];
      const b = pixels[offset + 2];
      if (Math.max(r, g, b) - Math.min(r, g, b) > saturationThreshold) {
        count += 1;
      }
    }
  }
  return count;
};
/** Top-derecha, donde `EmojiOverlay` posiciona el emoji (ver src/engine/EmojiOverlay.tsx). */
const countColorfulPixelsInEmojiRegion = (frame) =>
  countColorfulPixelsInRegion(frame, { leftFraction: 0.55, rightFraction: 1, topFraction: 0, bottomFraction: 0.3 });
/** Dentro de la franja de subtítulos, buscando el color de acento del canal (resaltado de palabra). */
const countAccentColoredPixelsInCaptionBand = (frame) =>
  countColorfulPixelsInRegion(frame, { leftFraction: 0, rightFraction: 1, topFraction: 0.75, bottomFraction: 1 });

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

{
  const pngPath = path.join(FIXTURES_DIR, "graphic-test.png");
  try {
    await renderStill(graphicJobRelPath, pngPath);
    check("graphic (stat): el still de Remotion se renderizó sin error", true);
    const frame = await readPngAsRgb(pngPath);
    const whitePixels = countWhitePixelsInCenterBand(frame);
    console.log(`[graphic-test] píxeles "blanco-ish" en la franja central: ${whitePixels}`);
    check("graphic (stat): ResourceRenderer despachó a StatCallout -- hay contenido visible en el centro del cuadro", whitePixels > 20, `whitePixels=${whitePixels}`);
  } catch (err) {
    check("graphic (stat): el still de Remotion se renderizó sin error", false, String(err.message ?? err));
  }
}

{
  // Estilo dinámico vertical: emoji con color real (fuente instalada
  // en el contenedor) + resaltado de palabra activo en dos cuadros
  // distintos del mismo job (cada uno debería tener EXACTAMENTE una
  // palabra resaltada, "UNO" o "DOS" según el cuadro -- la aritmética
  // exacta de qué palabra corresponde a qué fracción ya se prueba de
  // forma aislada y determinística en test-captions-grouping.mjs; esta
  // prueba solo confirma que un render real de Remotion/Chromium
  // efectivamente pinta el color de acento en la franja de subtítulos
  // cuando `words` está presente, no un resaltado fijo en un color o
  // ausente).
  const pngUno = path.join(FIXTURES_DIR, "dynamic-style-uno.png");
  const pngDos = path.join(FIXTURES_DIR, "dynamic-style-dos.png");
  try {
    // Frame 15 (0.5s): dentro de la mitad "UNO" (fracción 0-0.5 de 0-3000ms).
    await renderStill(dynamicStyleJobRelPath, pngUno, 15);
    // Frame 75 (2.5s): dentro de la mitad "DOS" (fracción 0.5-1).
    await renderStill(dynamicStyleJobRelPath, pngDos, 75);
    check("estilo dinámico: ambos cuadros se renderizaron sin error", true);

    const frameUno = await readPngAsRgb(pngUno);
    const frameDos = await readPngAsRgb(pngDos);

    const emojiPixelsUno = countColorfulPixelsInEmojiRegion(frameUno);
    const emojiPixelsDos = countColorfulPixelsInEmojiRegion(frameDos);
    console.log(`[dynamic-style] píxeles con color real en la región del emoji: frame15=${emojiPixelsUno}, frame75=${emojiPixelsDos}`);
    check(
      "emoji: hay píxeles con color real en su región (no son tofu ni fondo negro) en AMBOS cuadros -- la fuente de emoji está instalada y Remotion lo dibuja",
      emojiPixelsUno > 5 && emojiPixelsDos > 5,
      `emojiPixelsUno=${emojiPixelsUno} emojiPixelsDos=${emojiPixelsDos}`,
    );

    const accentPixelsUno = countAccentColoredPixelsInCaptionBand(frameUno);
    const accentPixelsDos = countAccentColoredPixelsInCaptionBand(frameDos);
    console.log(`[dynamic-style] píxeles con el color de acento en la franja de subtítulos: frame15(UNO activa)=${accentPixelsUno}, frame75(DOS activa)=${accentPixelsDos}`);
    check(
      "resaltado de palabra: aparece el color de acento del canal en la franja de subtítulos en AMBOS cuadros (nunca texto plano blanco) -- confirma que Captions.tsx usó el desglose por palabra de verdad en un render real, no el fallback de línea completa",
      accentPixelsUno > 5 && accentPixelsDos > 5,
      `accentPixelsUno=${accentPixelsUno} accentPixelsDos=${accentPixelsDos}`,
    );
  } catch (err) {
    check("estilo dinámico: el still de Remotion se renderizó sin error", false, String(err.message ?? err));
  }
}

await fs.rm(FIXTURES_DIR, { recursive: true, force: true });

console.log(failures === 0 ? "\nTODOS LOS TESTS DE RENDER (REMOTION REAL) PASARON" : `\n${failures} TEST(S) DE RENDER FALLARON`);
process.exit(failures === 0 ? 0 : 1);
