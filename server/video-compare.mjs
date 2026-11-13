// Reducir el tiempo de render (Fase 0, 11-nov-2026, autorizado por
// Alex, puerta G1): equivalencia visual entre dos videos -- usado para
// comparar el render selectivo contra el render completo del MISMO
// clip (deben verse iguales) y, si hace falta más adelante, cualquier
// otra comparación de calidad (p.ej. OffthreadVideo vs @remotion/media).
import { spawn } from "node:child_process";

/**
 * PSNR promedio (dB) entre dos videos, usando el filtro `psnr` real de
 * FFmpeg (no una aproximación propia) -- compara cuadro a cuadro en el
 * orden en que cada archivo los entrega, así que ambos deben tener la
 * MISMA cantidad de cuadros para que la comparación tenga sentido
 * (confirmar duración/conteo de cuadros aparte, ANTES de llamar a
 * esto). El resumen de FFmpeg ("PSNR ... average:X") sale por STDERR
 * incluso cuando el comando termina con código 0 -- se captura
 * directo, sin depender de que el proceso "falle" para poder leerlo.
 * `averagePsnr: null` (nunca un número inventado) si no se pudo
 * encontrar esa línea en la salida.
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
