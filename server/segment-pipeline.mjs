// Render híbrido -- camino de PRODUCCIÓN, detrás de la bandera
// `RENDER_MODE=hybrid` (adenda del auditor, 14-nov-2026, criterio F:
// "el render actual se mantiene como respaldo y la ruta nueva queda
// desactivada hasta su validación" -- `RENDER_MODE` por defecto es
// `"full"` en server/index.mjs, así que esto NUNCA corre sin que Alex
// cambie esa variable explícitamente).
//
// A diferencia de render-diagnose-hybrid.mjs (una VENTANA corta, nunca
// toca el job real), esto renderiza el job COMPLETO al `outputPath`
// real -- el resto del pipeline (finalizeJobOutput, subida a Drive,
// generación de .srt) sigue funcionando exactamente igual después,
// sin importar qué camino produjo el MP4.
//
// Si cualquier etapa falla, esto LANZA (nunca cae en silencio al
// render completo) -- el job queda en estado "error" con la evidencia
// de qué tramo falló (igual que un render completo que falla hoy); un
// reintento puede forzar el modo "full" explícitamente (criterio 6:
// "se puede reintentar en modo completo sin perder el trabajo").
import path from "node:path";
import fs from "node:fs/promises";
import { planChunks } from "./segment-planner.mjs";
import { renderAllChunks } from "./segment-render.mjs";
import { assembleFromChunks } from "./segment-assemble.mjs";
import { ensureRenderBundle } from "./render-bundle.mjs";
import { buildTimeline } from "./timeline.mjs";

export const runHybridRenderForJob = async ({
  jobId,
  job,
  outputPath,
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
  chunkWorkDir,
  concurrency,
  enableMultiprocessOnLinux,
  browserExecutable,
  binariesDirectory,
  fuseGapFrames,
  crf,
  preset,
  gopSize,
  timeoutMs,
  onLog = () => {},
  onSegments = () => {},
}) => {
  const plan = planChunks(job, { fuseGapFrames });
  onLog(`render híbrido: ${plan.chunks.length} tramo(s) -- ${plan.chunks.filter((c) => c.type === "plain").length} plano(s), ${plan.chunks.filter((c) => c.type === "composite").length} compuesto(s).`);

  await ensureRenderBundle({ projectRoot: cwd, bundleDir, versionTag: bundleVersionTag, env, onLog });

  await fs.mkdir(chunkWorkDir, { recursive: true });
  const segments = [];
  const chunkResults = await renderAllChunks({
    plan,
    chunkOutputDir: chunkWorkDir,
    sourceVideoPath: path.join(cwd, "public", job.input.baseVideo),
    propsJobFile: `uploads/jobs/${jobId}.json`,
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
    onSegment: (s) => {
      segments.push(s);
      onSegments([...segments]);
    },
  });

  const timeline = buildTimeline(job.input.durationInSeconds ?? 0, job.cuts ?? []);
  const assembleWorkDir = path.join(chunkWorkDir, "assemble");
  const assembleResult = await assembleFromChunks({
    ffmpegPath,
    ffprobePath,
    env,
    sourceVideoPath: path.join(cwd, "public", job.input.baseVideo),
    chunks: chunkResults.map((r) => ({ path: r.path })),
    timeline,
    workDir: assembleWorkDir,
    outputPath,
    sampleRate: 48000,
    onLog,
  });

  await fs.rm(chunkWorkDir, { recursive: true, force: true }).catch(() => {});
  return { plan, segments, assembleResult };
};
