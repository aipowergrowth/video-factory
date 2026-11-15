// Medición en el VPS del render híbrido de punta a punta (Fase 0,
// 14-nov-2026, autorizado por Alex; adenda del auditor, criterio 7/E:
// "cubre el rendimiento COMPLETO del prototipo... con CPU y RAM, no
// solo Remotion"; ampliado 14-nov-2026 por una segunda adenda tras la
// primera medición real en el VPS, criterios 7/7b; ampliado de nuevo
// 15-nov-2026 por una tercera adenda: la primera medición real con una
// ventana representativa (2-3min) hubiera fallado por timeout -- ver
// el comentario grande de `planHybridDiagnosticWindow`/`estimateHybridDiagnosticMs`
// más abajo). Corre sobre una VENTANA REPRESENTATIVA de un job real YA
// persistido (2-3 min, con menos de 15% de cuadros compuestos, centrada
// en un tramo compuesto real -- ver
// `segment-planner.mjs#chooseRepresentativeWindow`) -- nunca el video
// completo, nunca toca el estado del job ni `OUTPUTS_DIR`, nunca llama
// a una API de pago.
//
// Mide, por separado: construcción/reutilización del bundle,
// tramo-por-tramo (FFmpeg para los planos, Remotion para los
// compuestos -- cada uno con su propio tiempo y, si es plano, qué
// fracción se copió sin recodificar), ensamblado (unión sin
// recodificar + audio + mezcla), Y memoria/CPU del CONTENEDOR durante
// TODO ese tramo (container-metrics.mjs, el mismo mecanismo que ya usa
// el render real de producción) -- no solo durante Remotion, con el
// desglose anon/caché (criterio 3).
//
// EQUIVALENCIA (criterio 2, rediseñada 15-nov-2026 -- ver la adenda de
// arriba): comparar la ventana COMPLETA contra un render completo de
// la MISMA ventana significa un segundo render de Remotion de varios
// minutos -- el motivo real del timeout que esta adenda corrige. En
// vez de eso:
// - Tramos PLANOS: se comparan contra la fuente ORIGINAL redecodificada
//   (misma selección de cuadros, mismo escalado) -- nunca contra un
//   render de Remotion, porque un tramo plano NUNCA pasa por Remotion
//   en el camino híbrido (es video fuente, con o sin recodificar); un
//   tramo COPIADO sin recodificar (`copiedFraction===1`) es bit-a-bit
//   idéntico a la fuente por construcción, así que se omite la
//   comparación (no hay nada que medir -- se dice explícitamente, no
//   se esconde).
// - Tramos COMPUESTOS: se comparan contra un render REAL de Remotion,
//   pero SOLO del tramo compuesto + un margen chico hacia cada lado
//   (`buildBaselineRegions`) -- acotado por el tamaño del tramo
//   compuesto, NUNCA por el tamaño de la ventana completa. El margen
//   cae dentro de los tramos planos vecinos, así que el empalme
//   plano/compuesto SÍ queda cubierto por una comparación real contra
//   Remotion en ambos lados.
// Qué cuadros se compararon contra qué queda explícito en
// `equivalence.bySegment[].comparedAgainst` ("source" / "full-render" /
// "none-bit-identical-copy").
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runRemotionRender } from "./render-worker.mjs";
import { planChunks, decideRenderMode, chooseRepresentativeWindow, clipChunksToRange, clipTimelineToOutputRange } from "./segment-planner.mjs";
import { renderAllChunks, buildPlainPieceFfmpegArgs } from "./segment-render.mjs";
import { assembleFromChunks } from "./segment-assemble.mjs";
import { compareVideosPsnr, countVideoPackets, probeStreamDuration, extractFrameRangeToFile } from "./video-compare.mjs";
import { ensureRenderBundle } from "./render-bundle.mjs";
import { buildTimeline } from "./timeline.mjs";
import { startContainerMetricsSampling } from "./container-metrics.mjs";

const execFileAsync = promisify(execFile);

// Velocidades MEDIDAS reales en el VPS, job 1fd239de-8f9e-4642-8e42-d848b17d8481,
// 14-nov-2026 (ver reports/fase0-correccion-medicion-vps-14-nov-2026.md):
// tramo plano reencodificado 14,0fps y 11,3fps (se usa el más LENTO de
// los dos, conservador -- no hay todavía una medición real de la
// velocidad de COPIA de flujo, que debería ser más rápida); tramo
// compuesto (Remotion) 3,1fps -- la misma magnitud que un render
// completo (3,2fps medido), consistente porque ambos pasan por
// Remotion/Chrome igual.
export const MEASURED_PLAIN_REENCODE_FPS = 11;
export const MEASURED_COMPOSITE_FPS = 3.1;
// Margen de seguridad para CUALQUIER timeout calculado a partir de una
// velocidad medida -- cubre variación real del VPS (otro proceso
// compitiendo por CPU, I/O más lento de lo medido ese día), nunca un
// valor fijo sin relación al tamaño de lo que se va a ejecutar
// (criterio 2, adenda 15-nov-2026).
export const DEFAULT_TIMEOUT_MARGIN_MULTIPLIER = 3;
// Medio segundo a 30fps hacia cada lado de un tramo compuesto -- cae
// dentro del tramo plano vecino, suficiente para que el PSNR por
// empalme (`summarizePsnrByChunks`, margen de reporte más chico, 5
// cuadros por defecto) tenga cuadros de sobra de cada lado.
export const BASELINE_REGION_MARGIN_FRAMES = 15;

/** `ms` esperados para renderizar `frameCount` cuadros a `measuredFps` -- pura, sin margen (el margen se aplica en el llamador según si es una ESTIMACIÓN para Alex o un TIMEOUT real). */
export const estimateRenderMs = (frameCount, measuredFps) => {
  if (!(frameCount > 0) || !(measuredFps > 0)) return 0;
  return Math.ceil((frameCount / measuredFps) * 1000);
};

/**
 * Regiones a cubrir con un render COMPLETO real de Remotion -- cada
 * tramo compuesto del plan, extendido `marginFrames` hacia cada lado
 * (para que el empalme con el tramo plano vecino quede cubierto),
 * recortado a los límites de la ventana, y FUSIONADO si dos regiones
 * quedan solapadas o adyacentes (nunca dos renders de Remotion sobre
 * el mismo cuadro). Pura. `[]` si el plan no tiene ningún tramo
 * compuesto (ventana 100% plana -- no hace falta ninguna línea base).
 */
export const buildBaselineRegions = (chunks, { marginFrames = BASELINE_REGION_MARGIN_FRAMES, windowStartFrame, windowEndFrame } = {}) => {
  const composite = (chunks ?? []).filter((c) => c.type === "composite");
  if (composite.length === 0) return [];
  const raw = composite
    .map((c) => ({ start: Math.max(windowStartFrame, c.outputStartFrame - marginFrames), end: Math.min(windowEndFrame, c.outputEndFrame + marginFrames) }))
    .sort((a, b) => a.start - b.start);
  const merged = [{ ...raw[0] }];
  for (let i = 1; i < raw.length; i++) {
    const last = merged[merged.length - 1];
    if (raw[i].start <= last.end) {
      last.end = Math.max(last.end, raw[i].end);
    } else {
      merged.push({ ...raw[i] });
    }
  }
  return merged;
};

/**
 * Ventana representativa + plan recortado -- pura (composición de
 * funciones puras ya existentes de `segment-planner.mjs`). Separada de
 * `runHybridDiagnostic` para que el endpoint pueda calcular la
 * ESTIMACIÓN de tiempo (criterio 4, adenda 15-nov-2026) ANTES de lanzar
 * el diagnóstico de verdad, sin duplicar esta lógica.
 */
export const planHybridDiagnosticWindow = (job, { fuseGapFrames = 0, minWindowFrames, maxWindowFrames, targetCompositeFraction, maxCompositePercent, fps }) => {
  const fullPlan = planChunks(job, { fuseGapFrames });
  const decision = decideRenderMode({
    configuredMode: "hybrid",
    job,
    plan: { ...fullPlan, compositePercent: (fullPlan.chunks.filter((c) => c.type === "composite").reduce((s, c) => s + c.frames, 0) / Math.max(1, fullPlan.totalFrames)) * 100 },
    maxCompositePercent,
  });
  const { windowStartFrame, windowFrames, achievedCompositeFraction } = chooseRepresentativeWindow(fullPlan, { targetCompositeFraction, minWindowFrames, maxWindowFrames, fps });
  const windowEndFrame = windowStartFrame + windowFrames;
  const plan = clipChunksToRange(fullPlan, windowStartFrame, windowEndFrame, { fps });
  const timeline = clipTimelineToOutputRange(buildTimeline(job.input.durationInSeconds ?? 0, job.cuts ?? []), windowStartFrame / fps, windowEndFrame / fps);
  return { fullPlan, decision, windowStartFrame, windowFrames, windowEndFrame, achievedCompositeFraction, plan, timeline };
};

/**
 * Estimación [CALCULADA] (criterio 4, adenda 15-nov-2026) de cuánto va
 * a tardar el diagnóstico completo, con las velocidades REALES medidas
 * en el VPS -- SIN margen de seguridad (el margen se aplica aparte, al
 * calcular los timeouts reales de ejecución). Pura, dado un plan ya
 * recortado a su ventana. `totalConservativeMs` asume que el
 * paralelismo tramos-planos/compuestos NO ayuda nada (suma los dos
 * tiempos) -- la cota SEGURA para verificar timeouts contra ella;
 * `totalOptimisticMs` asume superposición total (el máximo de los
 * dos) -- lo que debería pasar en la práctica con el paralelismo real.
 */
export const estimateHybridDiagnosticMs = (plan, { windowStartFrame, windowEndFrame, plainFps = MEASURED_PLAIN_REENCODE_FPS, compositeFps = MEASURED_COMPOSITE_FPS, marginFrames = BASELINE_REGION_MARGIN_FRAMES, miscOverheadMs = 20_000 } = {}) => {
  const plainFrames = plan.chunks.filter((c) => c.type === "plain").reduce((s, c) => s + (c.frames ?? c.outputEndFrame - c.outputStartFrame), 0);
  const compositeFrames = plan.chunks.filter((c) => c.type === "composite").reduce((s, c) => s + (c.frames ?? c.outputEndFrame - c.outputStartFrame), 0);
  const plainChunksMs = estimateRenderMs(plainFrames, plainFps);
  const compositeChunksMs = estimateRenderMs(compositeFrames, compositeFps);
  const baselineRegions = buildBaselineRegions(plan.chunks, { marginFrames, windowStartFrame, windowEndFrame });
  const baselineFrames = baselineRegions.reduce((s, r) => s + (r.end - r.start), 0);
  const baselineMs = estimateRenderMs(baselineFrames, compositeFps);
  // La comparación de un tramo plano contra la fuente es solo
  // DECODIFICACIÓN (sin Remotion/Chrome) -- debería ser más rápida que
  // un reencode real, pero no hay una velocidad de decode-only medida
  // todavía; se usa la misma velocidad de reencode (más lenta) como
  // cota conservadora, nunca optimista.
  const plainCompareMs = estimateRenderMs(plainFrames, plainFps);
  const hybridChunksMsConservative = plainChunksMs + compositeChunksMs;
  const hybridChunksMsOptimistic = Math.max(plainChunksMs, compositeChunksMs);
  return {
    plainFrames,
    compositeFrames,
    baselineFrames,
    hybridChunksMsConservative,
    hybridChunksMsOptimistic,
    baselineMs,
    plainCompareMs,
    miscOverheadMs,
    totalConservativeMs: hybridChunksMsConservative + baselineMs + plainCompareMs + miscOverheadMs,
    totalOptimisticMs: hybridChunksMsOptimistic + baselineMs + plainCompareMs + miscOverheadMs,
  };
};

export const runHybridDiagnostic = async ({
  job,
  jobRelPath,
  sourceVideoAbsolutePath,
  destWidth,
  destHeight,
  srcWidth,
  srcHeight,
  fps,
  ffmpegPath,
  ffprobePath,
  env,
  cwd,
  bundleDir,
  bundleVersionTag,
  diagnosticsDir,
  concurrency = "1",
  enableMultiprocessOnLinux,
  browserExecutable,
  binariesDirectory,
  fuseGapFrames = 0,
  maxCompositePercent,
  // 2-3 min a 30fps = 3600-5400 cuadros -- por defecto apunta al medio de ese rango (4500 = 2,5min).
  minWindowFrames = 3600,
  maxWindowFrames = 5400,
  targetCompositeFraction = 0.15,
  parallelPlainWithComposite = true,
  crf,
  preset,
  gopSize,
  timeoutMarginMultiplier = DEFAULT_TIMEOUT_MARGIN_MULTIPLIER,
  onLog = () => {},
}) => {
  const workDir = path.join(diagnosticsDir, `hybrid-${Date.now()}`);
  await fs.mkdir(workDir, { recursive: true });
  const metrics = startContainerMetricsSampling({ intervalMs: 2000 });
  const timings = {};
  const t = async (label, fn) => {
    const startedAt = Date.now();
    const result = await fn();
    timings[label] = (timings[label] ?? 0) + (Date.now() - startedAt);
    return result;
  };

  try {
    const { decision, windowStartFrame, windowFrames, windowEndFrame, achievedCompositeFraction, plan, timeline } = planHybridDiagnosticWindow(job, {
      fuseGapFrames,
      minWindowFrames,
      maxWindowFrames,
      targetCompositeFraction,
      maxCompositePercent,
      fps,
    });
    const estimate = estimateHybridDiagnosticMs(plan, { windowStartFrame, windowEndFrame });
    onLog(
      `ventana REPRESENTATIVA: cuadros ${windowStartFrame}-${windowEndFrame - 1} (${(windowFrames / fps).toFixed(2)}s de salida, ${(achievedCompositeFraction * 100).toFixed(1)}% compuesto${achievedCompositeFraction > targetCompositeFraction ? ` -- POR ENCIMA del objetivo de ${targetCompositeFraction * 100}%, el video no tiene margen plano suficiente alrededor de este tramo compuesto para bajarlo más dentro de maxWindowFrames` : ""}) -- ${plan.chunks.length} chunks (${plan.chunks.filter((c) => c.type === "composite").length} compuesto(s)).`,
    );
    onLog(
      `estimación [CALCULADA] de duración total: ${Math.round(estimate.totalOptimisticMs / 1000)}s si el paralelismo ayuda al máximo, hasta ${Math.round(estimate.totalConservativeMs / 1000)}s si no ayuda nada (plano=${estimate.plainFrames}cuadros, compuesto=${estimate.compositeFrames}cuadros, línea base acotada=${estimate.baselineFrames}cuadros -- nunca los ${windowFrames} cuadros de la ventana completa).`,
    );

    const bundleResult = await t("bundleMs", () => ensureRenderBundle({ projectRoot: cwd, bundleDir, versionTag: bundleVersionTag, env, onLog }));

    // Timeout por tramo (adenda 15-nov-2026, criterio 2): proporcional
    // al tramo MÁS GRANDE que de verdad se va a renderizar en este
    // plan, no un valor fijo pensado para la ventana chica original.
    // Se usa la velocidad COMPUESTA (más lenta) como cota segura para
    // cualquier tramo, sea plano o compuesto.
    const largestChunkFrames = Math.max(1, ...plan.chunks.map((c) => c.frames ?? c.outputEndFrame - c.outputStartFrame));
    const chunkTimeoutMs = estimateRenderMs(largestChunkFrames, MEASURED_COMPOSITE_FPS) * timeoutMarginMultiplier;

    const chunkDir = path.join(workDir, "chunks");
    await fs.mkdir(chunkDir, { recursive: true });
    // Causa raíz real con evidencia de código, 15-nov-2026: antes, este
    // mismo archivo armaba `segments` SOLO con lo que llegaba por
    // `onSegment` (orden de FINALIZACIÓN) y usaba ESE arreglo para
    // ensamblar -- con `parallelPlainWithComposite=true` (el valor por
    // defecto), los tramos planos y compuestos terminan en orden
    // INTERCALADO, no en el orden real del video, lo que habría armado
    // un .mp4 con el contenido en el orden equivocado. `renderAllChunks`
    // ya devuelve `results` indexado por posición real (criterio 4 de
    // la tarea anterior) -- se usa ESE valor de retorno para ensamblar,
    // siempre en el orden correcto sin importar en qué orden terminó
    // cada tramo.
    const chunkResults = await t("chunksMs", () =>
      renderAllChunks({
        plan,
        chunkOutputDir: chunkDir,
        sourceVideoPath: sourceVideoAbsolutePath,
        propsJobFile: jobRelPath,
        ffmpegPath,
        ffprobePath,
        env,
        cwd,
        destWidth,
        destHeight,
        srcWidth,
        srcHeight,
        fps,
        concurrency,
        enableMultiprocessOnLinux,
        browserExecutable,
        binariesDirectory,
        entryPoint: bundleDir,
        crf,
        preset,
        gopSize,
        timeoutMs: chunkTimeoutMs,
        parallelPlainWithComposite,
        onLog,
        onSegment: () => {},
      }),
    );

    const hybridOutputPath = path.join(workDir, "hybrid-window.mp4");
    const assembleResult = await t("assembleMs", () =>
      assembleFromChunks({
        ffmpegPath,
        ffprobePath,
        env,
        sourceVideoPath: sourceVideoAbsolutePath,
        chunks: chunkResults.map((r) => ({ path: r.path })),
        timeline,
        workDir: path.join(workDir, "assemble"),
        outputPath: hybridOutputPath,
        sampleRate: 48000,
        onLog,
      }),
    );

    // Equivalencia (criterios 2/7b, rediseñada 15-nov-2026 -- ver el
    // comentario grande al inicio del archivo): tramos planos contra
    // la FUENTE, tramos compuestos (+ margen) contra una línea base
    // chica de Remotion, nunca un render completo de toda la ventana.
    const equivalenceWorkDir = path.join(workDir, "equivalence");
    await fs.mkdir(equivalenceWorkDir, { recursive: true });
    const bySegment = [];

    await t("equivalenceMs", async () => {
      for (let i = 0; i < plan.chunks.length; i++) {
        const chunk = plan.chunks[i];
        const result = chunkResults[i];
        if (chunk.type !== "plain") continue;
        const relStart = chunk.outputStartFrame - windowStartFrame;
        const relEnd = chunk.outputEndFrame - windowStartFrame;
        if (result.copiedFraction === 1) {
          bySegment.push({ type: "plain", outputStartFrame: relStart, outputEndFrame: relEnd, comparedAgainst: "none-bit-identical-copy", averagePsnr: null, minPsnr: null, framesCompared: relEnd - relStart });
          continue;
        }
        const groundTruthPath = path.join(equivalenceWorkDir, `source-${i}.ts`);
        const chunkFrames = chunk.frames ?? chunk.outputEndFrame - chunk.outputStartFrame;
        const compareTimeoutMs = estimateRenderMs(chunkFrames, MEASURED_PLAIN_REENCODE_FPS) * timeoutMarginMultiplier;
        const args = buildPlainPieceFfmpegArgs({ sourceVideoPath: sourceVideoAbsolutePath, piece: { kind: "reencode", startSeconds: chunk.sourceStartSeconds, endSeconds: chunk.sourceEndSeconds, frameCount: chunkFrames }, outputPath: groundTruthPath, destWidth, destHeight, srcWidth, srcHeight, fps, crf, preset, gopSize });
        await execFileAsync(ffmpegPath, args, { env, maxBuffer: 16 * 1024 * 1024, timeout: compareTimeoutMs });
        const psnrResult = await compareVideosPsnr({ ffmpegPath, env, pathA: groundTruthPath, pathB: result.path, fps });
        bySegment.push({ type: "plain", outputStartFrame: relStart, outputEndFrame: relEnd, comparedAgainst: "source", averagePsnr: psnrResult.averagePsnr, minPsnr: psnrResult.minPsnr, framesCompared: psnrResult.framesCompared });
        await fs.rm(groundTruthPath, { force: true }).catch(() => {});
      }

      const baselineRegions = buildBaselineRegions(plan.chunks, { windowStartFrame, windowEndFrame });
      for (const region of baselineRegions) {
        const regionFrames = region.end - region.start;
        const regionTimeoutMs = estimateRenderMs(regionFrames, MEASURED_COMPOSITE_FPS) * timeoutMarginMultiplier;
        const baselineRegionPath = path.join(equivalenceWorkDir, `baseline-${region.start}-${region.end}.mp4`);
        await runRemotionRender({ cwd, env, outputPath: baselineRegionPath, propsJobFile: jobRelPath, concurrency, enableMultiprocessOnLinux, browserExecutable, binariesDirectory, frames: `${region.start}-${region.end - 1}`, timeoutMs: regionTimeoutMs, onLog });

        const hybridSlicePath = path.join(equivalenceWorkDir, `hybrid-slice-${region.start}-${region.end}.mp4`);
        await extractFrameRangeToFile(ffmpegPath, env, { inputPath: hybridOutputPath, startFrame: region.start - windowStartFrame, frameCount: regionFrames, fps, outputPath: hybridSlicePath, timeoutMs: regionTimeoutMs });

        const chunksInRegion = plan.chunks
          .filter((c) => c.outputStartFrame < region.end && c.outputEndFrame > region.start)
          .map((c) => ({ ...c, outputStartFrame: Math.max(c.outputStartFrame, region.start) - region.start, outputEndFrame: Math.min(c.outputEndFrame, region.end) - region.start }));
        const psnrResult = await compareVideosPsnr({ ffmpegPath, env, pathA: baselineRegionPath, pathB: hybridSlicePath, fps, chunks: chunksInRegion });
        bySegment.push({
          type: "composite-region",
          outputStartFrame: region.start - windowStartFrame,
          outputEndFrame: region.end - windowStartFrame,
          comparedAgainst: "full-render",
          averagePsnr: psnrResult.averagePsnr,
          minPsnr: psnrResult.minPsnr,
          framesCompared: psnrResult.framesCompared,
          byChunk: psnrResult.bySegment?.byChunk ?? [],
          byBoundary: psnrResult.bySegment?.byBoundary ?? [],
        });
        await fs.rm(baselineRegionPath, { force: true }).catch(() => {});
        await fs.rm(hybridSlicePath, { force: true }).catch(() => {});
      }
    });

    bySegment.sort((a, b) => a.outputStartFrame - b.outputStartFrame);
    const withPsnr = bySegment.filter((s) => s.averagePsnr !== null);
    const finitePsnr = withPsnr.filter((s) => Number.isFinite(s.averagePsnr));
    const totalFiniteFrames = finitePsnr.reduce((s, c) => s + c.framesCompared, 0);
    const averagePsnr = totalFiniteFrames > 0 ? finitePsnr.reduce((s, c) => s + c.averagePsnr * c.framesCompared, 0) / totalFiniteFrames : withPsnr.length > 0 ? Infinity : null;
    const minPsnr = withPsnr.length > 0 ? Math.min(...withPsnr.map((c) => c.minPsnr)) : null;
    const comparedAgainstSourceFrames = bySegment.filter((s) => s.comparedAgainst === "source").reduce((s, c) => s + c.framesCompared, 0);
    const comparedAgainstFullRenderFrames = bySegment.filter((s) => s.comparedAgainst === "full-render").reduce((s, c) => s + c.framesCompared, 0);
    const skippedBitIdenticalCopyFrames = bySegment.filter((s) => s.comparedAgainst === "none-bit-identical-copy").reduce((s, c) => s + c.framesCompared, 0);

    // Duración exacta en cuadros (criterio 7b) contra el valor
    // ESPERADO conocido por el plan (ya no contra un render completo
    // paralelo de la ventana -- ver el comentario grande de arriba).
    // Sincronía de audio contra la duración NOMINAL de la ventana
    // (windowFrames/fps) -- el audio se construye siempre desde la
    // fuente directamente (`assembleFromChunks`), nunca pasa por
    // Remotion, así que comparar contra una línea base de Remotion
    // nunca aportó información distinta de comparar contra la duración
    // nominal esperada.
    const hybridVideoFrames = await countVideoPackets(ffprobePath, env, hybridOutputPath);
    const hybridAudioSeconds = await probeStreamDuration(ffprobePath, env, hybridOutputPath, "a:0");
    const expectedAudioSeconds = Math.round((windowFrames / fps) * 1000) / 1000;
    const audioSyncDiffSeconds = hybridAudioSeconds !== null ? Math.round(Math.abs(hybridAudioSeconds - expectedAudioSeconds) * 1000) / 1000 : null;

    const summary = await metrics.stop();
    const renderMs = timings.chunksMs + timings.assembleMs + timings.bundleMs;
    return {
      ok: true,
      decision,
      windowStartFrame,
      windowFrames,
      windowSeconds: Math.round((windowFrames / fps) * 100) / 100,
      achievedCompositeFraction,
      estimate,
      bundle: { reused: bundleResult.reused, ms: timings.bundleMs },
      segments: chunkResults,
      assemble: { stages: assembleResult.stages, totalMs: timings.assembleMs },
      chunksMs: timings.chunksMs,
      // `renderMs` (criterio 7b: "con el ensamblado completo dentro
      // del tiempo medido") -- bundle + tramos + ensamblado, el tiempo
      // TOTAL real de producir el .mp4 final, no solo los tramos.
      renderMs,
      equivalenceMs: timings.equivalenceMs,
      equivalence: {
        expectedVideoFrames: windowFrames,
        hybridVideoFrames,
        frameCountExact: hybridVideoFrames === windowFrames,
        expectedAudioSeconds,
        hybridAudioSeconds,
        audioSyncDiffSeconds,
        audioSyncOk: audioSyncDiffSeconds !== null && audioSyncDiffSeconds < 1 / fps + 0.01,
        averagePsnr,
        minPsnr,
        comparedAgainstSourceFrames,
        comparedAgainstFullRenderFrames,
        skippedBitIdenticalCopyFrames,
        bySegment,
      },
      containerMetrics: summary,
    };
  } catch (err) {
    const summary = await metrics.stop();
    return { ok: false, error: String(err.message ?? err), containerMetrics: summary };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
};
