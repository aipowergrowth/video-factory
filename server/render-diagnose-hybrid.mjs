// Medición en el VPS del render híbrido de punta a punta (Fase 0,
// 14-nov-2026, autorizado por Alex; adenda del auditor, criterio 7/E:
// "cubre el rendimiento COMPLETO del prototipo... con CPU y RAM, no
// solo Remotion"; ampliado 14-nov-2026 por una segunda adenda tras la
// primera medición real en el VPS, criterios 7/7b). Corre sobre una
// VENTANA REPRESENTATIVA de un job real YA persistido (2-3 min, con
// menos de 15% de cuadros compuestos, centrada en un tramo compuesto
// real -- ver `segment-planner.mjs#chooseRepresentativeWindow`; la
// primera versión de esto, con una ventana forzada a cubrir el primer
// compuesto sin control de proporción, dio 63% compuesto en un job que
// en total es 5,4% compuesto, nada representativo) -- nunca el video
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
// desglose anon/caché (criterio 3). Compara contra un render COMPLETO
// (Remotion solo) de la MISMA ventana: duración exacta en cuadros,
// sincronía de audio, y PSNR por tramo y por empalme (criterio 2) --
// nunca un único número global que pueda esconder un defecto
// localizado.
import fs from "node:fs/promises";
import path from "node:path";
import { runRemotionRender } from "./render-worker.mjs";
import { planChunks, decideRenderMode, chooseRepresentativeWindow, clipChunksToRange, clipTimelineToOutputRange } from "./segment-planner.mjs";
import { renderAllChunks } from "./segment-render.mjs";
import { assembleFromChunks } from "./segment-assemble.mjs";
import { compareVideosPsnr, countVideoPackets, probeStreamDuration } from "./video-compare.mjs";
import { ensureRenderBundle } from "./render-bundle.mjs";
import { buildTimeline } from "./timeline.mjs";
import { startContainerMetricsSampling } from "./container-metrics.mjs";

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
  timeoutMs = 180_000,
  onLog = () => {},
}) => {
  const workDir = path.join(diagnosticsDir, `hybrid-${Date.now()}`);
  await fs.mkdir(workDir, { recursive: true });
  const metrics = startContainerMetricsSampling({ intervalMs: 2000 });
  const timings = {};
  const t = async (label, fn) => {
    const startedAt = Date.now();
    const result = await fn();
    timings[label] = Date.now() - startedAt;
    return result;
  };

  try {
    const fullPlan = planChunks(job, { fuseGapFrames });
    const decision = decideRenderMode({ configuredMode: "hybrid", job, plan: { ...fullPlan, compositePercent: (fullPlan.chunks.filter((c) => c.type === "composite").reduce((s, c) => s + c.frames, 0) / Math.max(1, fullPlan.totalFrames)) * 100 }, maxCompositePercent });
    const { windowStartFrame, windowFrames, achievedCompositeFraction } = chooseRepresentativeWindow(fullPlan, { targetCompositeFraction, minWindowFrames, maxWindowFrames, fps });
    const windowEndFrame = windowStartFrame + windowFrames;
    const plan = clipChunksToRange(fullPlan, windowStartFrame, windowEndFrame, { fps });
    const timeline = clipTimelineToOutputRange(buildTimeline(job.input.durationInSeconds ?? 0, job.cuts ?? []), windowStartFrame / fps, windowEndFrame / fps);
    onLog(
      `ventana REPRESENTATIVA: cuadros ${windowStartFrame}-${windowEndFrame - 1} (${(windowFrames / fps).toFixed(2)}s de salida, ${(achievedCompositeFraction * 100).toFixed(1)}% compuesto${achievedCompositeFraction > targetCompositeFraction ? ` -- POR ENCIMA del objetivo de ${targetCompositeFraction * 100}%, el video no tiene margen plano suficiente alrededor de este tramo compuesto para bajarlo más dentro de maxWindowFrames` : ""}) -- ${plan.chunks.length} chunks (${plan.chunks.filter((c) => c.type === "composite").length} compuesto(s)).`,
    );

    const bundleResult = await t("bundleMs", () => ensureRenderBundle({ projectRoot: cwd, bundleDir, versionTag: bundleVersionTag, env, onLog }));

    const segments = [];
    const chunkDir = path.join(workDir, "chunks");
    await fs.mkdir(chunkDir, { recursive: true });
    await t("chunksMs", () =>
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
        timeoutMs,
        parallelPlainWithComposite,
        onLog,
        onSegment: (s) => segments.push(s),
      }),
    );

    const hybridOutputPath = path.join(workDir, "hybrid-window.mp4");
    const assembleResult = await t("assembleMs", () =>
      assembleFromChunks({
        ffmpegPath,
        ffprobePath,
        env,
        sourceVideoPath: sourceVideoAbsolutePath,
        chunks: segments.map((s) => ({ path: s.path })),
        timeline,
        workDir: path.join(workDir, "assemble"),
        outputPath: hybridOutputPath,
        sampleRate: 48000,
        onLog,
      }),
    );

    const baselineOutputPath = path.join(workDir, "baseline-window.mp4");
    await t("baselineFullRenderMs", () =>
      runRemotionRender({
        cwd,
        env,
        outputPath: baselineOutputPath,
        propsJobFile: jobRelPath,
        concurrency,
        enableMultiprocessOnLinux,
        browserExecutable,
        binariesDirectory,
        // Rango ABSOLUTO (la ventana casi nunca arranca en 0) -- la
        // línea base debe cubrir EXACTAMENTE los mismos cuadros de la
        // composición completa que cubrió el híbrido, para que la
        // comparación sea de la misma porción real del video.
        frames: `${windowStartFrame}-${windowEndFrame - 1}`,
        timeoutMs,
        onLog,
      }),
    );

    // Equivalencia (criterio 7b): duración exacta en CUADROS (conteo
    // real de paquetes, no el campo `duration` del contenedor -- ver
    // la causa raíz ya documentada en test-hybrid-render.mjs) y
    // sincronía de audio, además del PSNR por tramo/empalme de abajo.
    const [hybridVideoFrames, baselineVideoFrames, hybridAudioSeconds, baselineAudioSeconds] = await Promise.all([
      countVideoPackets(ffprobePath, env, hybridOutputPath),
      countVideoPackets(ffprobePath, env, baselineOutputPath),
      probeStreamDuration(ffprobePath, env, hybridOutputPath, "a:0"),
      probeStreamDuration(ffprobePath, env, baselineOutputPath, "a:0"),
    ]);
    const audioSyncDiffSeconds = hybridAudioSeconds !== null && baselineAudioSeconds !== null ? Math.round(Math.abs(hybridAudioSeconds - baselineAudioSeconds) * 1000) / 1000 : null;

    // PSNR por tramo y por empalme (criterio 2) -- `chunks` reindexado
    // a la ventana (el archivo de 2-3min empieza en su propio cuadro 0,
    // pero `plan.chunks` sigue con los números ABSOLUTOS de la
    // composición completa, necesarios para Remotion más arriba).
    const chunksRelativeToWindow = plan.chunks.map((c) => ({ ...c, outputStartFrame: c.outputStartFrame - windowStartFrame, outputEndFrame: c.outputEndFrame - windowStartFrame }));
    const psnr = await compareVideosPsnr({ ffmpegPath, env, pathA: baselineOutputPath, pathB: hybridOutputPath, fps, chunks: chunksRelativeToWindow });

    const summary = await metrics.stop();
    const renderMs = timings.chunksMs + timings.assembleMs + timings.bundleMs;
    return {
      ok: true,
      decision,
      windowStartFrame,
      windowFrames,
      windowSeconds: Math.round((windowFrames / fps) * 100) / 100,
      achievedCompositeFraction,
      bundle: { reused: bundleResult.reused, ms: timings.bundleMs },
      segments,
      assemble: { stages: assembleResult.stages, totalMs: timings.assembleMs },
      chunksMs: timings.chunksMs,
      // `renderMs` (criterio 7b: "con el ensamblado completo dentro
      // del tiempo medido") -- bundle + tramos + ensamblado, el tiempo
      // TOTAL real de producir el .mp4 final, no solo los tramos.
      renderMs,
      baselineFullRenderMs: timings.baselineFullRenderMs,
      speedupRatio: timings.baselineFullRenderMs > 0 ? Math.round((timings.baselineFullRenderMs / renderMs) * 100) / 100 : null,
      equivalence: {
        hybridVideoFrames,
        baselineVideoFrames,
        frameCountExact: hybridVideoFrames === baselineVideoFrames,
        hybridAudioSeconds,
        baselineAudioSeconds,
        audioSyncDiffSeconds,
        audioSyncOk: audioSyncDiffSeconds !== null && audioSyncDiffSeconds < 1 / fps + 0.01,
        averagePsnr: psnr.averagePsnr,
        minPsnr: psnr.minPsnr,
        frameCountMismatch: psnr.frameCountMismatch,
        framesCompared: psnr.framesCompared,
        bySegment: psnr.bySegment,
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
