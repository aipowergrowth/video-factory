// Reducir el tiempo de render (Fase 0, 11-nov-2026, autorizado por
// Alex, puerta G0). Objetivo: saber, de un job YA persistido, qué
// fracción de sus cuadros de SALIDA son "planos" (solo el video base,
// sin ningún elemento encima) frente a "compuestos" (llevan zoom,
// overlay, recurso o subtítulo quemado) -- SIN renderizar nada. Es el
// dato que decide si vale la pena el render selectivo (arquitectura
// híbrida del dictamen del operador, 10-nov-2026): copiar con FFmpeg
// los tramos planos y renderizar con Remotion solo los compuestos.
//
// Pura -- opera solo sobre el job ya parseado (igual que
// `buildTimeline`/`remapRangeToOutput` de timeline.mjs, que reutiliza
// tal cual, sin reimplementar el remapeo de cortes). `zooms`/
// `overlays`/`captions` viajan en tiempo del video ORIGINAL (como
// `cuts`) y se remapean a tiempo de SALIDA con `remapRangeToOutput`;
// `resources` ya vienen en tiempo de SALIDA (ver el comentario grande
// en src/types.ts -- remapearlos otra vez aplicaría el desplazamiento
// de los cortes dos veces, defecto real que esta nota evita a
// propósito).
import { buildTimeline, remapRangeToOutput } from "./timeline.mjs";
import { shouldBurnCaptions } from "./subtitles.mjs";
import { ENGINE_FPS } from "./render-worker.mjs";
import { isRenderableByEngine } from "./cta-guarantee.mjs";

const EPSILON = 1e-6;

/** Convierte un rango en segundos a un rango de ÍNDICES de cuadro [a, b) -- medio abierto, para poder sumar sin contar el mismo cuadro dos veces en el borde. */
const secondsRangeToFrameRange = (startSeconds, endSeconds, fps) => {
  const startFrame = Math.max(0, Math.round(startSeconds * fps));
  const endFrame = Math.max(startFrame, Math.round(endSeconds * fps));
  return { startFrame, endFrame };
};

/**
 * Fusiona rangos de cuadros [a,b) que se solapan o son contiguos --
 * misma idea que `normalizeCuts` de timeline.mjs pero en espacio de
 * ÍNDICES de cuadro (enteros), no de segundos, para que sumar
 * duraciones de muchos intervalos cortos no acumule error de
 * redondeo.
 */
const mergeFrameRanges = (ranges) => {
  const sorted = [...ranges].sort((a, b) => a.startFrame - b.startFrame);
  const merged = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.startFrame <= last.endFrame) {
      last.endFrame = Math.max(last.endFrame, r.endFrame);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
};

const countFramesInRanges = (ranges) => ranges.reduce((sum, r) => sum + (r.endFrame - r.startFrame), 0);

const clampFrameRangeToTotal = (range, totalFrames) => ({
  startFrame: Math.max(0, Math.min(range.startFrame, totalFrames)),
  endFrame: Math.max(0, Math.min(range.endFrame, totalFrames)),
});

/**
 * Traduce una lista de rangos en tiempo ORIGINAL (overlays/zooms/
 * captions) a rangos de cuadros de SALIDA, usando la línea de tiempo
 * ya construida (cortes aplicados) -- un rango puede partirse en
 * varios tramos si un corte cayó en el medio (mismo comportamiento de
 * `remapRangeToOutput`, nunca inventa continuidad).
 */
const sourceRangesToOutputFrameRanges = (timeline, ranges, fps, totalFrames) => {
  const frameRanges = [];
  for (const range of ranges) {
    for (const outputRange of remapRangeToOutput(timeline, range)) {
      const fr = secondsRangeToFrameRange(outputRange.startSeconds, outputRange.endSeconds, fps);
      frameRanges.push(clampFrameRangeToTotal(fr, totalFrames));
    }
  }
  return mergeFrameRanges(frameRanges.filter((r) => r.endFrame > r.startFrame));
};

/** Resources ya vienen en tiempo de SALIDA -- solo se convierten a cuadros, NUNCA se remapean con la línea de tiempo (ver comentario grande arriba). */
const outputRangesToFrameRanges = (ranges, fps, totalFrames) =>
  mergeFrameRanges(
    ranges
      .map((r) => clampFrameRangeToTotal(secondsRangeToFrameRange(r.startSeconds, r.endSeconds, fps), totalFrames))
      .filter((r) => r.endFrame > r.startFrame),
  );

/**
 * Cuenta las "corridas" (tramos contiguos) de una lista de rangos de
 * cuadros YA fusionada -- cuántas invocaciones separadas de Remotion
 * necesitaría la arquitectura híbrida si cada corrida compuesta fuera
 * su propio tramo renderizado.
 */
const countRuns = (mergedFrameRanges) => mergedFrameRanges.length;

/**
 * Arma la línea de tiempo + cuenta cuadros compuestos por tipo --
 * extraído de `planSegments` para que `planChunks` (más abajo) pueda
 * reusar EXACTAMENTE la misma clasificación plano/compuesto sin
 * duplicar la lógica de remapeo.
 */
const analyzeJob = (job, fps) => {
  const durationInSeconds = job.input?.durationInSeconds ?? 0;
  const timeline = buildTimeline(durationInSeconds, job.cuts ?? []);
  const totalFrames = Math.max(0, Math.round(timeline.outputDurationInSeconds * fps));

  const zoomFrameRanges = sourceRangesToOutputFrameRanges(
    timeline,
    (job.zooms ?? []).map((z) => ({ startSeconds: z.startSeconds, endSeconds: z.endSeconds })),
    fps,
    totalFrames,
  );
  const overlayFrameRanges = sourceRangesToOutputFrameRanges(
    timeline,
    (job.overlays ?? []).map((o) => ({ startSeconds: o.startSeconds, endSeconds: o.startSeconds + o.durationSeconds })),
    fps,
    totalFrames,
  );
  const renderableResources = (job.resources ?? []).filter(isRenderableByEngine);
  const resourceFrameRanges = outputRangesToFrameRanges(
    renderableResources.map((r) => ({ startSeconds: r.startSeconds, endSeconds: r.endSeconds })),
    fps,
    totalFrames,
  );
  const burnsCaptions = shouldBurnCaptions(job);
  const captionFrameRanges = burnsCaptions
    ? sourceRangesToOutputFrameRanges(
        timeline,
        (job.captions ?? []).map((c) => ({ startSeconds: c.startMs / 1000, endSeconds: c.endMs / 1000 })),
        fps,
        totalFrames,
      )
    : [];

  const compositeFrameRanges = mergeFrameRanges([...zoomFrameRanges, ...overlayFrameRanges, ...resourceFrameRanges, ...captionFrameRanges]);

  return { timeline, totalFrames, burnsCaptions, zoomFrameRanges, overlayFrameRanges, resourceFrameRanges, captionFrameRanges, compositeFrameRanges };
};

/**
 * Analiza un job YA persistido (parseado desde su job.json) y devuelve
 * cuántos cuadros de SALIDA son planos vs. compuestos, con el desglose
 * por tipo de elemento (zooms, overlays, recursos, subtítulos
 * quemados) y cuántas corridas compuestas separadas hay -- todo sin
 * renderizar nada. `fps` por defecto `ENGINE_FPS` (30, el mismo que
 * usa el motor real).
 */
export const planSegments = (job, { fps = ENGINE_FPS } = {}) => {
  const { timeline, totalFrames, burnsCaptions, zoomFrameRanges, overlayFrameRanges, resourceFrameRanges, captionFrameRanges, compositeFrameRanges } = analyzeJob(job, fps);
  const compositeFrames = countFramesInRanges(compositeFrameRanges);
  const plainFrames = Math.max(0, totalFrames - compositeFrames);
  const round1 = (n) => Math.round(n * 10) / 10;

  return {
    totalFrames,
    outputDurationInSeconds: Math.round(timeline.outputDurationInSeconds * 100) / 100,
    plainFrames,
    plainPercent: totalFrames > 0 ? round1((plainFrames / totalFrames) * 100) : 0,
    compositeFrames,
    compositePercent: totalFrames > 0 ? round1((compositeFrames / totalFrames) * 100) : 0,
    compositeRuns: countRuns(compositeFrameRanges),
    byType: {
      zoomFrames: countFramesInRanges(zoomFrameRanges),
      overlayFrames: countFramesInRanges(overlayFrameRanges),
      resourceFrames: countFramesInRanges(resourceFrameRanges),
      captionFrames: countFramesInRanges(captionFrameRanges),
    },
    burnsCaptions,
  };
};

/**
 * Render selectivo (criterio 6, arquitectura híbrida): arma la lista
 * ORDENADA de tramos ("chunks") en que hay que partir el render --
 * cada uno "plano" (copiar/recodificar con FFmpeg desde el video
 * fuente) o "compuesto" (renderizar con Remotion). Un tramo plano que
 * en tiempo de SALIDA cruza un corte (p.ej. dos tramos planos
 * separados por un corte en el medio) se PARTE en dos chunks propios
 * -- cada chunk queda SIEMPRE dentro de un solo tramo de la línea de
 * tiempo (`buildTimeline`), nunca cruza un corte, porque del otro lado
 * de un corte el video fuente salta a un punto distinto y no se puede
 * extraer con una sola llamada a FFmpeg.
 *
 * Los "puntos de quiebre" son la unión de: los límites de cada tramo
 * de la línea de tiempo (cada corte) y los límites de cada rango
 * compuesto ya fusionado -- entre dos puntos de quiebre consecutivos,
 * el tipo (plano/compuesto) y el tramo fuente son constantes por
 * construcción. Chunks consecutivos del MISMO tipo que ya quedaron
 * dentro del mismo tramo se fusionan de vuelta (p.ej. cuando dos
 * elementos compuestos distintos cayeron uno justo después del otro).
 */
export const planChunks = (job, { fps = ENGINE_FPS } = {}) => {
  const { timeline, totalFrames, compositeFrameRanges } = analyzeJob(job, fps);
  if (totalFrames <= 0) return { totalFrames: 0, chunks: [] };

  const segmentBoundaries = timeline.segments.map((seg) => ({
    sourceStart: seg.sourceStart,
    outputStartFrame: Math.round(seg.outputStart * fps),
    outputEndFrame: Math.round(seg.outputEnd * fps),
  }));

  const breakpoints = new Set([0, totalFrames]);
  for (const s of segmentBoundaries) {
    breakpoints.add(s.outputStartFrame);
    breakpoints.add(s.outputEndFrame);
  }
  for (const r of compositeFrameRanges) {
    breakpoints.add(r.startFrame);
    breakpoints.add(r.endFrame);
  }
  const sortedBreakpoints = [...breakpoints].filter((b) => b >= 0 && b <= totalFrames).sort((a, b) => a - b);

  const rawChunks = [];
  for (let i = 0; i < sortedBreakpoints.length - 1; i++) {
    const start = sortedBreakpoints[i];
    const end = sortedBreakpoints[i + 1];
    if (end <= start) continue;
    const segment = segmentBoundaries.find((s) => start >= s.outputStartFrame && start < s.outputEndFrame);
    if (!segment) continue; // no debería pasar -- los puntos de quiebre incluyen todos los límites de tramo
    const isComposite = compositeFrameRanges.some((r) => start >= r.startFrame && start < r.endFrame);
    const sourceStartSeconds = segment.sourceStart + (start - segment.outputStartFrame) / fps;
    const sourceEndSeconds = segment.sourceStart + (end - segment.outputStartFrame) / fps;
    rawChunks.push({
      type: isComposite ? "composite" : "plain",
      outputStartFrame: start,
      outputEndFrame: end,
      sourceStartSeconds: Math.round(sourceStartSeconds * 1000) / 1000,
      sourceEndSeconds: Math.round(sourceEndSeconds * 1000) / 1000,
    });
  }

  const chunks = [];
  for (const c of rawChunks) {
    const last = chunks[chunks.length - 1];
    if (last && last.type === c.type && last.outputEndFrame === c.outputStartFrame && Math.abs(last.sourceEndSeconds - c.sourceStartSeconds) < 1e-4) {
      last.outputEndFrame = c.outputEndFrame;
      last.sourceEndSeconds = c.sourceEndSeconds;
    } else {
      chunks.push({ ...c });
    }
  }

  return { totalFrames, chunks };
};
