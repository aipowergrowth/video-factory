// Puerto en JS plano de src/engine/timeline.ts -- misma lógica exacta,
// MISMOS TESTS (ver scripts/test-timeline.mjs). Existe por separado porque
// server/ corre con `node` directo (sin bundler) y no puede importar un
// .ts; src/engine/timeline.ts es la versión que de verdad usa el motor de
// Remotion. Si uno cambia, el otro debe cambiar igual -- es intencional
// mantener ambos en lugar de pelear con el toolchain por una lógica tan
// chica y pura.
//
// Se usa en el servidor para la Fase 2 (planificación de recursos): la IA
// editorial piensa los tiempos de cada recurso en el video ORIGINAL (igual
// que cuts/zooms/captions), y esto los traduce a la línea temporal FINAL
// (ya con los cortes aplicados) antes de guardarlos en el job.

const EPSILON = 1e-6;

/** Ordena, recorta a los límites del video y fusiona cortes solapados o contiguos. */
export const normalizeCuts = (cuts, durationInSeconds) => {
  const clamped = cuts
    .map((cut) => ({
      startSeconds: Math.max(0, Math.min(cut.startSeconds, durationInSeconds)),
      endSeconds: Math.max(0, Math.min(cut.endSeconds, durationInSeconds)),
    }))
    .filter((cut) => cut.endSeconds - cut.startSeconds > EPSILON)
    .sort((a, b) => a.startSeconds - b.startSeconds);

  const merged = [];
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
export const buildTimeline = (durationInSeconds, cuts) => {
  const mergedCuts = normalizeCuts(cuts, durationInSeconds);

  const segments = [];
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
 * Traduce un rango en tiempo ORIGINAL a tiempo de SALIDA. Si un corte
 * partió el rango en dos pedazos que sobreviven, devuelve los dos -- sin
 * inventar continuidad entre ellos. Si el rango cayó entero dentro de un
 * corte, devuelve un array vacío.
 */
export const remapRangeToOutput = (timeline, range) => {
  const result = [];
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
