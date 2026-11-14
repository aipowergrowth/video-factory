// Medición en el VPS del render híbrido de punta a punta (Fase 0,
// 14-nov-2026, autorizado por Alex; adenda del auditor, criterio 7/E:
// "cubre el rendimiento COMPLETO del prototipo... con CPU y RAM, no
// solo Remotion"). Corre sobre una VENTANA corta de un job real YA
// persistido (los primeros segundos de salida, extendidos para cubrir
// el primer tramo compuesto completo -- ver
// segment-planner.mjs#chooseMeasurementWindowFrames) -- nunca el video
// completo, nunca toca el estado del job ni `OUTPUTS_DIR`, nunca llama
// a una API de pago.
//
// Mide, por separado: construcción/reutilización del bundle,
// tramo-por-tramo (FFmpeg para los planos, Remotion para los
// compuestos -- cada uno con su propio tiempo y, si es plano, qué
// fracción se copió sin recodificar), ensamblado (unión sin
// recodificar + audio + mezcla), Y memoria/CPU del CONTENEDOR durante
// TODO ese tramo (container-metrics.mjs, el mismo mecanismo que ya usa
// el render real de producción) -- no solo durante Remotion. Compara
// contra un render COMPLETO (Remotion solo) de la MISMA ventana, con
// PSNR real.
//
// Pura orquestación (como render-diagnose.mjs) -- no toca
// `jobs`/`writeStatus`; eso es responsabilidad del endpoint en
// index.mjs.
import fs from "node:fs/promises";
import path from "node:path";
import { runRemotionRender } from "./render-worker.mjs";
import { planChunks, decideRenderMode, chooseMeasurementWindowFrames, clipChunksToWindow, clipTimelineToOutputSeconds } from "./segment-planner.mjs";
import { renderAllChunks } from "./segment-render.mjs";
import { assembleFromChunks } from "./segment-assemble.mjs";
import { compareVideosPsnr } from "./video-compare.mjs";
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
  minWindowFrames = 150,
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
    const windowFrames = chooseMeasurementWindowFrames(fullPlan, { minWindowFrames, fps });
    const plan = clipChunksToWindow(fullPlan, windowFrames);
    const timeline = clipTimelineToOutputSeconds(buildTimeline(job.input.durationInSeconds ?? 0, job.cuts ?? []), windowFrames / fps);
    onLog(`ventana de medición: ${windowFrames} cuadros (${(windowFrames / fps).toFixed(2)}s) de salida -- ${plan.chunks.length} chunks (${plan.chunks.filter((c) => c.type === "composite").length} compuesto(s)).`);

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
        frames: `0-${windowFrames - 1}`,
        timeoutMs,
        onLog,
      }),
    );

    const psnr = await compareVideosPsnr({ ffmpegPath, env, pathA: baselineOutputPath, pathB: hybridOutputPath });

    const summary = await metrics.stop();
    return {
      ok: true,
      decision,
      windowFrames,
      windowSeconds: Math.round((windowFrames / fps) * 100) / 100,
      bundle: { reused: bundleResult.reused, ms: timings.bundleMs },
      segments,
      assemble: { stages: assembleResult.stages, totalMs: timings.assembleMs },
      chunksMs: timings.chunksMs,
      baselineFullRenderMs: timings.baselineFullRenderMs,
      speedupRatio: timings.baselineFullRenderMs > 0 ? Math.round(((timings.baselineFullRenderMs / (timings.chunksMs + timings.assembleMs + timings.bundleMs)) * 100)) / 100 : null,
      equivalence: { averagePsnr: psnr.averagePsnr, minPsnr: psnr.minPsnr, frameCountMismatch: psnr.frameCountMismatch, framesCompared: psnr.framesCompared },
      containerMetrics: summary,
    };
  } catch (err) {
    const summary = await metrics.stop();
    return { ok: false, error: String(err.message ?? err), containerMetrics: summary };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
};
