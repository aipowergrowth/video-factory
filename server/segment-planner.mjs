// Reducir el tiempo de render (Fase 0, 11-nov-2026, autorizado por
// Alex, puerta G0; ampliado 14-nov-2026 para la ruta híbrida detrás de
// bandera). Objetivo: saber, de un job YA persistido, qué fracción de
// sus cuadros de SALIDA son "planos" (solo el video base, sin ningún
// elemento encima) frente a "compuestos" (llevan zoom, overlay, recurso
// o subtítulo quemado) -- SIN renderizar nada -- y partir el render en
// tramos: FFmpeg para los planos, Remotion solo para los compuestos.
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
 * Fusión de tramos compuestos cercanos (criterio 4, 14-nov-2026): dos
 * corridas compuestas separadas por un hueco plano de hasta
 * `fuseGapFrames` cuadros se unen en UNA sola invocación de Remotion
 * (el hueco se renderiza por Chrome). Vale la pena cuando renderizar
 * el hueco cuesta menos que un arranque de Remotion: a 3,47 cuadros/s
 * medidos en el VPS, un arranque de ~10-16s equivale a ~35-55 cuadros
 * -- por eso el valor por defecto del servidor es 45 (configurable,
 * ver HYBRID_FUSE_GAP_FRAMES en index.mjs). Pura.
 */
export const fuseCompositeRanges = (mergedRanges, fuseGapFrames) => {
  const fused = [];
  let fusedGapFrames = 0;
  for (const r of mergedRanges) {
    const last = fused[fused.length - 1];
    if (last && fuseGapFrames > 0 && r.startFrame - last.endFrame <= fuseGapFrames) {
      fusedGapFrames += Math.max(0, r.startFrame - last.endFrame);
      last.endFrame = Math.max(last.endFrame, r.endFrame);
    } else {
      fused.push({ ...r });
    }
  }
  return { ranges: fused, fusedGapFrames };
};

/**
 * Render selectivo/híbrido: arma la lista ORDENADA de tramos ("chunks")
 * en que hay que partir el render -- cada uno "plain" (copiar/
 * recodificar con FFmpeg desde el video fuente) o "composite"
 * (renderizar con Remotion).
 *
 * Un tramo PLANO nunca cruza un corte: del otro lado de un corte el
 * video fuente salta a otro punto y no se puede extraer con una sola
 * llamada a FFmpeg -- se parte en dos chunks propios aunque ambos sean
 * planos. Un tramo COMPUESTO sí puede cruzar un corte (Remotion
 * renderiza cuadros de SALIDA y aplica los cortes por dentro) -- se
 * fusiona en una sola invocación y queda marcado `spansCut: true`.
 *
 * Los "puntos de quiebre" son la unión de: los límites de cada tramo
 * de la línea de tiempo (cada corte) y los límites de cada rango
 * compuesto ya fusionado -- entre dos puntos de quiebre consecutivos,
 * el tipo (plano/compuesto) y el tramo fuente son constantes por
 * construcción.
 */
export const planChunks = (job, { fps = ENGINE_FPS, fuseGapFrames = 0 } = {}) => {
  const { timeline, totalFrames, compositeFrameRanges: rawCompositeRanges } = analyzeJob(job, fps);
  if (totalFrames <= 0) return { totalFrames: 0, chunks: [], compositeRunsBeforeFusion: 0, compositeRunsAfterFusion: 0, fusedGapFrames: 0 };

  const { ranges: compositeFrameRanges, fusedGapFrames } = fuseCompositeRanges(rawCompositeRanges, fuseGapFrames);

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

  const round3 = (n) => Math.round(n * 1000) / 1000;
  const rawChunks = [];
  for (let i = 0; i < sortedBreakpoints.length - 1; i++) {
    const start = sortedBreakpoints[i];
    const end = sortedBreakpoints[i + 1];
    if (end <= start) continue;
    const segment = segmentBoundaries.find((s) => start >= s.outputStartFrame && start < s.outputEndFrame);
    if (!segment) continue; // no debería pasar -- los puntos de quiebre incluyen todos los límites de tramo
    const isComposite = compositeFrameRanges.some((r) => start >= r.startFrame && start < r.endFrame);
    rawChunks.push({
      type: isComposite ? "composite" : "plain",
      outputStartFrame: start,
      outputEndFrame: end,
      sourceStartSeconds: round3(segment.sourceStart + (start - segment.outputStartFrame) / fps),
      sourceEndSeconds: round3(segment.sourceStart + (end - segment.outputStartFrame) / fps),
      spansCut: false,
    });
  }

  const chunks = [];
  for (const c of rawChunks) {
    const last = chunks[chunks.length - 1];
    const outputContiguous = last && last.type === c.type && last.outputEndFrame === c.outputStartFrame;
    const sourceContiguous = last && Math.abs(last.sourceEndSeconds - c.sourceStartSeconds) < 1e-4;
    if (outputContiguous && (c.type === "composite" || sourceContiguous)) {
      last.outputEndFrame = c.outputEndFrame;
      last.sourceEndSeconds = c.sourceEndSeconds;
      if (!sourceContiguous) last.spansCut = true;
    } else {
      chunks.push({ ...c });
    }
  }
  for (const c of chunks) c.frames = c.outputEndFrame - c.outputStartFrame;

  return { totalFrames, chunks, compositeRunsBeforeFusion: rawCompositeRanges.length, compositeRunsAfterFusion: compositeFrameRanges.length, fusedGapFrames };
};

/** Resumen de un plan de chunks para el log/API -- cuántas invocaciones de Remotion quedan de verdad. Pura. */
export const summarizeChunkPlan = (plan) => {
  const chunks = plan.chunks ?? [];
  const composite = chunks.filter((c) => c.type === "composite");
  const plain = chunks.filter((c) => c.type === "plain");
  return {
    totalFrames: plan.totalFrames,
    chunkCount: chunks.length,
    plainChunks: plain.length,
    compositeChunks: composite.length,
    remotionInvocations: composite.length,
    plainFrames: plain.reduce((s, c) => s + c.frames, 0),
    compositeFrames: composite.reduce((s, c) => s + c.frames, 0),
    compositeRunsBeforeFusion: plan.compositeRunsBeforeFusion ?? composite.length,
    fusedGapFrames: plan.fusedGapFrames ?? 0,
    compositeChunksSpanningCuts: composite.filter((c) => c.spansCut).length,
  };
};

/**
 * Regla de decisión por trabajo (criterio 6, 14-nov-2026): híbrido o
 * render completo. APAGADO por defecto (`configuredMode` distinto de
 * "hybrid" -> siempre completo, el camino de producción de hoy); un
 * reintento puede forzar "full" (`override`) para recuperar un job
 * cuyo híbrido falló sin perder el trabajo. Con el híbrido activado,
 * solo aplica a trabajos de video grabado con video base y con un
 * porcentaje compuesto <= `maxCompositePercent` -- umbral propuesto en
 * el informe de esta tarea a partir de los tiempos medidos (3,47
 * cuadros/s por Chrome) y estimados (FFmpeg), configurable con
 * HYBRID_MAX_COMPOSITE_PERCENT. Pura.
 */
export const decideRenderMode = ({ configuredMode = "full", override = null, job, plan, maxCompositePercent = 70 }) => {
  const requested = override ?? configuredMode;
  if (requested !== "hybrid") {
    return { mode: "full", reason: override ? `modo "full" pedido explícitamente para este reintento` : `RENDER_MODE=${configuredMode} (el híbrido está apagado por defecto)` };
  }
  if (job?.input?.type !== "recorded-video" || !job.input.baseVideo) {
    return { mode: "full", reason: "el híbrido solo aplica a trabajos de video grabado con video base ya resuelto" };
  }
  if (!plan || !(plan.totalFrames > 0)) {
    return { mode: "full", reason: "el job no tiene cuadros de salida que planificar" };
  }
  if (plan.compositePercent > maxCompositePercent) {
    return { mode: "full", reason: `${plan.compositePercent}% de cuadros compuestos supera el umbral HYBRID_MAX_COMPOSITE_PERCENT=${maxCompositePercent}% -- el híbrido ya no ahorra lo suficiente frente a su complejidad` };
  }
  return { mode: "hybrid", reason: `RENDER_MODE=hybrid${override ? " (pedido en el reintento)" : ""}, ${plan.compositePercent}% compuesto <= ${maxCompositePercent}%, ${plan.compositeRuns} corrida(s) compuesta(s)` };
};

/**
 * Ventana de medición (criterio 7): los primeros `minWindowFrames`
 * cuadros de SALIDA, extendidos hasta cubrir COMPLETO el primer tramo
 * compuesto (más un segundo de margen) si hace falta -- así la ventana
 * siempre ejercita las dos rutas (FFmpeg y Remotion). Pura.
 */
export const chooseMeasurementWindowFrames = (plan, { minWindowFrames, fps = ENGINE_FPS }) => {
  if (!(plan.totalFrames > 0)) return 0;
  let windowFrames = Math.min(minWindowFrames, plan.totalFrames);
  const firstComposite = plan.chunks.find((c) => c.type === "composite");
  if (firstComposite) windowFrames = Math.max(windowFrames, Math.min(plan.totalFrames, firstComposite.outputEndFrame + fps));
  return windowFrames;
};

/** Recorta un plan a sus primeros `windowFrames` cuadros de salida -- el último chunk que cruza el límite se acorta (su fuente también, si es plano). Pura. */
export const clipChunksToWindow = (plan, windowFrames, { fps = ENGINE_FPS } = {}) => {
  const round3 = (n) => Math.round(n * 1000) / 1000;
  const chunks = [];
  for (const c of plan.chunks) {
    if (c.outputStartFrame >= windowFrames) break;
    const outputEndFrame = Math.min(c.outputEndFrame, windowFrames);
    const frames = outputEndFrame - c.outputStartFrame;
    chunks.push({
      ...c,
      outputEndFrame,
      frames,
      sourceEndSeconds: c.type === "plain" ? round3(c.sourceStartSeconds + frames / fps) : c.sourceEndSeconds,
    });
  }
  return { ...plan, totalFrames: Math.min(plan.totalFrames, windowFrames), chunks };
};

/** Recorta una línea de tiempo (buildTimeline) a sus primeros `outputSeconds` segundos de SALIDA -- para construir el audio de una ventana con los mismos cortes. Pura. */
export const clipTimelineToOutputSeconds = (timeline, outputSeconds) => {
  const segments = [];
  for (const seg of timeline.segments) {
    if (seg.outputStart >= outputSeconds) break;
    const outputEnd = Math.min(seg.outputEnd, outputSeconds);
    segments.push({ ...seg, outputEnd, sourceEnd: seg.sourceStart + (outputEnd - seg.outputStart) });
  }
  return { segments, outputDurationInSeconds: Math.min(timeline.outputDurationInSeconds, outputSeconds) };
};
