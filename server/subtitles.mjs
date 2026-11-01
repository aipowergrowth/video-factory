import { remapRangeToOutput } from "./timeline.mjs";

// Decisión de Alex (31-oct-2026): YouTube ya muestra sus propios
// subtítulos (y su traducción al idioma del espectador) ENCIMA de
// cualquier cosa pegada a la imagen -- se ven dobles y montados. Por
// eso el video horizontal (youtube-16-9) no lleva subtítulos pegados;
// en su lugar, el servidor entrega un archivo .srt aparte para subir a
// YouTube directamente. Shorts/Reels/TikTok (vertical-9-16) siguen
// llevando los subtítulos pegados, como siempre -- esas plataformas no
// tienen un equivalente al "subtítulo + traducción automática" de
// YouTube superponiéndose.
//
// shouldBurnCaptions está DUPLICADA a propósito en src/types.ts (no
// importada) -- el servidor corre con `node` plano y no puede importar
// ese `.ts` (mismo motivo que server/timeline.mjs vs. src/engine/timeline.ts).
// Si una cambia, la otra debe cambiar igual.
export const shouldBurnCaptions = (job) => job.burnCaptions ?? job.destination !== "youtube-16-9";

const pad = (n, len = 2) => String(n).padStart(len, "0");

/** ms -> "HH:MM:SS,mmm" (formato de timestamp del .srt). */
export const formatSrtTimestamp = (ms) => {
  const totalMs = Math.max(0, Math.round(ms));
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const millis = totalMs % 1000;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(millis, 3)}`;
};

/**
 * Construye el .srt a partir de `captions` (ya con las correcciones del
 * canal aplicadas y agrupadas en líneas legibles -- ver
 * captions.mjs#groupCaptions, es la MISMA fuente que usa el motor para
 * pegar subtítulos, nunca una segunda transcripción ni un segundo
 * agrupado) y `timeline` (de timeline.mjs#buildTimeline, construida con
 * los cortes YA aplicados) -- la misma traducción tiempo-original ->
 * tiempo-de-salida que usa VideoEngine.tsx para pegarlos, así que el
 * .srt describe exactamente lo que se vería pegado si estuviera
 * activado, nunca otra cosa.
 *
 * Un subtítulo que cae entero dentro de un corte desaparece
 * (remapRangeToOutput no devuelve nada para él); uno partido por un
 * corte en el medio se convierte en dos entradas separadas del .srt --
 * nunca se inventa continuidad entre los dos pedazos que sobreviven.
 */
export const buildSrt = (captions, timeline) => {
  const entries = [];
  for (const caption of captions ?? []) {
    const ranges = remapRangeToOutput(timeline, {
      startSeconds: caption.startMs / 1000,
      endSeconds: caption.endMs / 1000,
    });
    for (const range of ranges) {
      if (range.endSeconds - range.startSeconds <= 1e-6) continue;
      entries.push({
        startMs: range.startSeconds * 1000,
        endMs: range.endSeconds * 1000,
        text: caption.text,
      });
    }
  }
  // Por construcción (remapRangeToOutput conserva el orden y nunca
  // solapa dos tramos vivos) esto ya debería salir ordenado -- se
  // ordena explícitamente de todas formas, por seguridad, nunca por
  // necesidad conocida.
  entries.sort((a, b) => a.startMs - b.startMs);

  return (
    entries
      .map(
        (entry, i) =>
          `${i + 1}\n${formatSrtTimestamp(entry.startMs)} --> ${formatSrtTimestamp(entry.endMs)}\n${entry.text}\n`,
      )
      .join("\n") + (entries.length > 0 ? "\n" : "")
  );
};
