/**
 * Los cortes (`cuts`) y el zoom (`zooms`) se piensan en el tiempo del video
 * ORIGINAL — el mismo tiempo que ya usa whisper para transcribir y el que ya
 * usan `overlays`/`captions` hoy. Así la IA editorial (Etapa 2) decide todo
 * en una sola línea de tiempo ("corta de 12.0 a 14.5", "pon un subtítulo en
 * 20.1") sin tener que recalcular nada después de cada corte.
 *
 * Este módulo traduce ese tiempo original a tiempo de SALIDA (ya con los
 * cortes aplicados) para que el motor sepa dónde colocar cada `Sequence`.
 */

export type TimeRange = {
  startSeconds: number;
  endSeconds: number;
};

export type TimelineSegment = {
  /** Tramo del video original que sobrevive. */
  sourceStart: number;
  sourceEnd: number;
  /** Dónde cae ese mismo tramo en la salida, tras quitar los cortes previos. */
  outputStart: number;
  outputEnd: number;
};

export type Timeline = {
  segments: TimelineSegment[];
  outputDurationInSeconds: number;
};

const EPSILON = 1e-6;

/** Ordena, recorta a los límites del video y fusiona cortes solapados o contiguos. */
export const normalizeCuts = (
  cuts: TimeRange[],
  durationInSeconds: number,
): TimeRange[] => {
  const clamped = cuts
    .map((cut) => ({
      startSeconds: Math.max(0, Math.min(cut.startSeconds, durationInSeconds)),
      endSeconds: Math.max(0, Math.min(cut.endSeconds, durationInSeconds)),
    }))
    .filter((cut) => cut.endSeconds - cut.startSeconds > EPSILON)
    .sort((a, b) => a.startSeconds - b.startSeconds);

  const merged: TimeRange[] = [];
  for (const cut of clamped) {
    const last = merged[merged.length - 1];
    if (last && cut.startSeconds <= last.endSeconds + EPSILON) {
      last.endSeconds = Math.max(last.endSeconds, cut.endSeconds);
    } else {
      merged.push({ ...cut });
    }
  }
  return merged;
};

/** Construye la línea de tiempo de salida: qué tramos del original sobreviven y dónde caen. */
export const buildTimeline = (
  durationInSeconds: number,
  cuts: TimeRange[],
): Timeline => {
  const mergedCuts = normalizeCuts(cuts, durationInSeconds);

  const segments: TimelineSegment[] = [];
  let cursorSource = 0;
  let cursorOutput = 0;

  for (const cut of mergedCuts) {
    if (cut.startSeconds - cursorSource > EPSILON) {
      const length = cut.startSeconds - cursorSource;
      segments.push({
        sourceStart: cursorSource,
        sourceEnd: cut.startSeconds,
        outputStart: cursorOutput,
        outputEnd: cursorOutput + length,
      });
      cursorOutput += length;
    }
    cursorSource = cut.endSeconds;
  }

  if (durationInSeconds - cursorSource > EPSILON) {
    const length = durationInSeconds - cursorSource;
    segments.push({
      sourceStart: cursorSource,
      sourceEnd: durationInSeconds,
      outputStart: cursorOutput,
      outputEnd: cursorOutput + length,
    });
    cursorOutput += length;
  }

  return { segments, outputDurationInSeconds: cursorOutput };
};

/**
 * Traduce un rango en tiempo ORIGINAL (p.ej. un overlay o un subtítulo) a
 * tiempo de SALIDA. Si el corte partió el rango en dos pedazos que
 * sobreviven, devuelve los dos. Si el rango cayó entero dentro de un corte,
 * devuelve un array vacío.
 */
export const remapRangeToOutput = (
  timeline: Timeline,
  range: TimeRange,
): TimeRange[] => {
  const result: TimeRange[] = [];
  for (const segment of timeline.segments) {
    const overlapStart = Math.max(range.startSeconds, segment.sourceStart);
    const overlapEnd = Math.min(range.endSeconds, segment.sourceEnd);
    if (overlapEnd - overlapStart > EPSILON) {
      result.push({
        startSeconds: segment.outputStart + (overlapStart - segment.sourceStart),
        endSeconds: segment.outputStart + (overlapEnd - segment.sourceStart),
      });
    }
  }
  return result;
};
