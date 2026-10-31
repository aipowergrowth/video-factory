// Resolución del binario de FFmpeg/ffprobe que trae @remotion/compositor-*
// -- extraído de index.mjs para que la herramienta de pruebas de
// regresión (test-audio-regression.mjs, corre en GitHub Actions) use
// EXACTAMENTE la misma lógica que producción para encontrar el binario,
// en vez de reimplementarla aparte (ver dictamen 31-oct-2026: "no
// desarrollar una arquitectura paralela").
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const resolveCompositorBinary = (name, { binariesDirectory } = {}) => {
  const bin = process.platform === "win32" ? `${name}.exe` : name;
  if (binariesDirectory) {
    return path.join(binariesDirectory, bin);
  }

  const candidates = [
    "@remotion/compositor-linux-x64-gnu",
    "@remotion/compositor-linux-x64-musl",
    "@remotion/compositor-linux-arm64-gnu",
    "@remotion/compositor-linux-arm64-musl",
    "@remotion/compositor-darwin-x64",
    "@remotion/compositor-darwin-arm64",
    "@remotion/compositor-win32-x64-msvc",
  ];
  for (const pkg of candidates) {
    try {
      const mod = require(pkg);
      return path.join(mod.dir, bin);
    } catch {
      // Paquete no instalado para esta plataforma/arquitectura; probar el siguiente.
    }
  }
  throw new Error("No se encontró ningún @remotion/compositor-* instalado.");
};

export const resolveCompositorFfprobe = (opts) => resolveCompositorBinary("ffprobe", opts);
export const resolveCompositorFfmpeg = (opts) => resolveCompositorBinary("ffmpeg", opts);

/** macOS (solo desarrollo local) necesita esta variable para encontrar
 * los .dylib que viven junto al binario; en Linux no hace falta. */
export const binaryEnv = (binaryPath) =>
  process.platform === "darwin"
    ? { ...process.env, DYLD_LIBRARY_PATH: path.dirname(binaryPath) }
    : process.env;
