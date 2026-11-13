import express from "express";
import multer from "multer";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { downloadFileWithRetry, uploadFile } from "./drive.mjs";
import { transcribeVideo } from "./transcribe.mjs";
import { planEdit, mergeNearbyGaplessCuts, snapCutsToWordBoundaries, buildSnapCutsDiagnostic } from "./editorial.mjs";
import { buildTimeline } from "./timeline.mjs";
import { relocateToNearestSurvivingInterval, remapResourcesWithCtaGuarantee, computePendingResources } from "./cta-guarantee.mjs";
import {
  refineCutsWithRealSilence,
  rankPauseCandidates,
  SILENCE_WIDE_REPORT_RADIUS_SECONDS,
  SILENCE_SEARCH_RADIUS_SECONDS,
} from "./audio-analysis.mjs";
import { runQualityGateWithRemediation } from "./quality-gate.mjs";
import { resolveCompositorFfprobe, resolveCompositorFfmpeg, binaryEnv } from "./compositor.mjs";
import { shouldBurnCaptions, buildSrt } from "./subtitles.mjs";
import { acquireResourcesForJob, readPixabayApiKey } from "./resource-acquisition.mjs";
import { readGeminiApiKey } from "./image-generation.mjs";
import { createAtomicJsonWriter } from "./atomic-json-store.mjs";
import { isAutoConvertibleCodec, probeBasicVideoInfo, normalizeVideoInputCodec } from "./video-normalization.mjs";
import { loadChannelEditorialContext } from "./channel-editorial-loader.mjs";
import { runRemotionRender, DESTINATION_DIMENSIONS, ENGINE_FPS } from "./render-worker.mjs";
import { killProcessGroup } from "./process-tree.mjs";
import { startContainerMetricsSampling, readContainerMemoryBytes, readContainerCpuUsageMicros } from "./container-metrics.mjs";
import { probeSourceVideoDiagnostics, formatSourceVideoDiagnosticsLine } from "./source-video-diagnostics.mjs";
import { canRetryJob, describeRetryPlan, readJobFileForRetry, checkBaseVideoExists, appendAttemptHistory } from "./job-retry.mjs";
import { runDiagnosticRender, buildDiagnosticWindows } from "./render-diagnose.mjs";
import { planSegments } from "./segment-planner.mjs";

const PORT = Number(process.env.PORT ?? 3001);
const PROJECT_ROOT = process.env.PROJECT_ROOT ?? process.cwd();
const UPLOADS_JOBS_DIR =
  process.env.UPLOADS_JOBS_DIR ?? path.join(PROJECT_ROOT, "public/uploads/jobs");
const UPLOADS_VIDEOS_DIR =
  process.env.UPLOADS_VIDEOS_DIR ??
  path.join(PROJECT_ROOT, "public/uploads/videos");
const OUTPUTS_DIR = process.env.OUTPUTS_DIR ?? "/data/outputs";
// Fase 3B (31-oct-2026): adquisición de broll/image contra Pixabay.
// Ambos dentro de public/uploads (mismo volumen persistente que ya
// existe -- fabrica_videos_inputs en docker-stack.yml -- sin volumen
// nuevo). RESOURCE_CACHE_DIR guarda resultados de búsqueda por 24h
// (exigencia de los términos de Pixabay); RESOURCE_ASSETS_DIR guarda el
// archivo YA descargado de cada recurso resuelto.
const RESOURCE_CACHE_DIR =
  process.env.RESOURCE_CACHE_DIR ?? path.join(PROJECT_ROOT, "public/uploads/resource-cache");
const RESOURCE_ASSETS_DIR =
  process.env.RESOURCE_ASSETS_DIR ?? path.join(PROJECT_ROOT, "public/uploads/resources");
const RENDER_CONCURRENCY = Number(process.env.RENDER_CONCURRENCY ?? 1);
// Medido con el video real de 12 min (dopamina): con concurrencia por
// defecto (varias pestañas de Chrome decodificando el MISMO video base en
// paralelo), el 86% del tiempo de render se iba en "seeks" caros porque las
// pestañas saltan constantemente entre posiciones distintas del archivo.
// Con concurrency=1 los seeks bajaron de 730 a 17 (en el mismo tramo de 60s)
// y el render total bajó un 35%. Para trabajos dominados por un solo video
// base (el caso actual) 1 es más rápido que el paralelismo; si en el futuro
// hay trabajos con mucho overlay/gráficos pesados en CPU, puede valer la
// pena subir esto vía la variable de entorno.
const REMOTION_CONCURRENCY = process.env.REMOTION_CONCURRENCY ?? "1";
const ENABLE_MULTIPROCESS_ON_LINUX =
  (process.env.ENABLE_MULTIPROCESS_ON_LINUX ?? "true") === "true";
// Solo necesarios fuera de Linux (p.ej. probando esto en macOS). En el
// contenedor Linux de producción se dejan sin definir.
const REMOTION_BROWSER_EXECUTABLE = process.env.REMOTION_BROWSER_EXECUTABLE;
const REMOTION_BINARIES_DIRECTORY = process.env.REMOTION_BINARIES_DIRECTORY;

// Videos de 1-3 GB deben caber (subida directa). 5 GB de margen por defecto.
const MAX_UPLOAD_BYTES = Number(
  process.env.MAX_UPLOAD_BYTES ?? 5 * 1024 * 1024 * 1024,
);
// Un render que se cuelga no debe bloquear la cola para siempre. 3 horas
// de margen por defecto para videos largos (40+ min).
const RENDER_TIMEOUT_MINUTES = Number(
  process.env.RENDER_TIMEOUT_MINUTES ?? 180,
);
// Observabilidad del render (Fase 0, 08-nov-2026): cada cuánto se
// vuelve a loguear/guardar el progreso -- lo que pase primero
// (cambio de porcentaje o tiempo transcurrido). Pensado para no
// inundar el log en un render de 60 min real (criterio explícito del
// dictamen) sin dejar de ver avance en uno corto.
const RENDER_PROGRESS_LOG_PERCENT_STEP = Number(
  process.env.RENDER_PROGRESS_LOG_PERCENT_STEP ?? 5,
);
const RENDER_PROGRESS_LOG_INTERVAL_MS = Number(
  process.env.RENDER_PROGRESS_LOG_INTERVAL_MS ?? 30_000,
);
// Cada cuánto se muestrea CPU/memoria del contenedor mientras dura el
// render (ver server/container-metrics.mjs) -- no se necesita más
// fino que esto para un pico/promedio útil.
const RENDER_METRICS_SAMPLE_INTERVAL_MS = Number(
  process.env.RENDER_METRICS_SAMPLE_INTERVAL_MS ?? 10_000,
);
// Vigilante de render trabado (render trabado, 08-nov-2026, criterio
// 3): si pasan estos minutos SIN NINGÚN cuadro nuevo (ni rendering ni
// encoding), se corta el render con un error claro en vez de ocupar
// el servidor sin límite -- confirmado como un modo de falla real de
// Remotion sin recuperación propia (issue público del proyecto: "sat
// for 70 minutes until we killed it", "every process at 0% CPU"). 10
// min es generoso frente a un render normal (donde el progreso avanza
// cada pocos segundos) pero corta mucho antes que las 3h de
// RENDER_TIMEOUT_MINUTES -- valor propio, no viene de ninguna
// documentación de Remotion/FFmpeg, ajustable sin tocar código.
const RENDER_STUCK_TIMEOUT_MINUTES = Number(
  process.env.RENDER_STUCK_TIMEOUT_MINUTES ?? 10,
);
// Render de diagnóstico (causa raíz con evidencia del VPS, 09-nov-2026,
// criterio 3) -- acotado a unos pocos minutos a propósito: si no
// completa en este tiempo, ESO ya es la evidencia (dónde se detiene),
// no un error que haya que corregir subiendo el valor.
const RENDER_DIAGNOSE_TIMEOUT_MINUTES = Number(
  process.env.RENDER_DIAGNOSE_TIMEOUT_MINUTES ?? 3,
);
// Limpieza automática: entradas/salidas terminadas más viejas que esto se
// borran, para no llenar el disco con el uso semanal.
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS ?? 7);
const CLEANUP_INTERVAL_HOURS = Number(
  process.env.CLEANUP_INTERVAL_HOURS ?? 6,
);
// Conversión automática HEVC/H.265 -> H.264 (autorizado por Alex,
// 03-nov-2026 -- ver server/video-normalization.mjs para la causa raíz
// y el diseño completo). Un video de iPhone en 4K puede tardar bastante
// en convertirse con 4 CPUs (ver docker-stack.yml); el margen por
// defecto es generoso pero independiente del timeout de render (180
// min), porque pasa ANTES del render, no durante.
const VIDEO_CONVERSION_TIMEOUT_MINUTES = Number(
  process.env.VIDEO_CONVERSION_TIMEOUT_MINUTES ?? 120,
);
const VIDEO_CONVERSION_PRESET = process.env.VIDEO_CONVERSION_PRESET ?? "veryfast";
const VIDEO_CONVERSION_CRF = Number(process.env.VIDEO_CONVERSION_CRF ?? 20);
// Mismo límite que "cpus: 4" en docker-stack.yml -- no dejar que ffmpeg
// use más hilos de los que el contenedor en realidad tiene.
const VIDEO_CONVERSION_THREADS = Number(process.env.VIDEO_CONVERSION_THREADS ?? 4);

// Reintentos para la descarga desde Google Drive.
const DRIVE_DOWNLOAD_MAX_ATTEMPTS = Number(
  process.env.DRIVE_DOWNLOAD_MAX_ATTEMPTS ?? 3,
);
const DRIVE_DOWNLOAD_WAIT_MS = Number(
  process.env.DRIVE_DOWNLOAD_WAIT_MS ?? 5000,
);
// Si se configura, el MP4 final se sube a esta carpeta de Drive al
// terminar cada job (para poder verlo/aprobarlo sin acceso al VPS). La
// carpeta debe compartirse de antemano con el email de la cuenta de
// servicio con permiso de Editor (la de origen solo necesita Viewer).
// Sin esto configurado, el motor sigue funcionando igual, simplemente
// sin subir nada -- no es un requisito para que un job termine bien.
const DRIVE_OUTPUT_FOLDER_ID = process.env.DRIVE_OUTPUT_FOLDER_ID;
// Transcripción automática (Etapa 1). whisper.cpp ya viene compilado en la
// imagen (ver Dockerfile); aquí solo se usa.
const WHISPER_DIR = path.join(PROJECT_ROOT, "whisper.cpp");
const WHISPER_MODEL = process.env.WHISPER_MODEL ?? "small";

// Códecs de video que el Chromium que usa Remotion decodifica de forma
// fiable. HEVC/H.265 (típico de grabaciones de iPhone) NO funciona — hay
// que convertirlo antes (ver scripts/trim_video.swift o un paso de ffmpeg
// equivalente). Lección aprendida renderizando el primer video real.
const ALLOWED_VIDEO_CODECS = new Set(["h264", "vp8", "vp9", "av1"]);

for (const dir of [UPLOADS_JOBS_DIR, UPLOADS_VIDEOS_DIR, OUTPUTS_DIR, RESOURCE_CACHE_DIR, RESOURCE_ASSETS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Mueve un archivo incluso cuando origen y destino están en volúmenes
 * Docker distintos (p.ej. el directorio temporal de multer vs. un volumen
 * montado): ahí `fs.rename` falla con EXDEV porque no es un simple rename
 * de inodo, así que en ese caso se copia y se borra el original.
 */
const safeRename = async (src, dest) => {
  try {
    await fsp.rename(src, dest);
  } catch (err) {
    if (err.code !== "EXDEV") {
      throw err;
    }
    await fsp.copyFile(src, dest);
    await fsp.unlink(src);
  }
};

// resolveCompositorFfprobe/resolveCompositorFfmpeg/binaryEnv viven en
// ./compositor.mjs (extraídas para que test-audio-regression.mjs, que
// corre en GitHub Actions, resuelva el binario de FFmpeg con la MISMA
// lógica que producción, en vez de reimplementarla aparte). Este
// wrapper solo aplica REMOTION_BINARIES_DIRECTORY, que index.mjs ya
// traía como variable de entorno propia.
const resolveFfprobe = () => resolveCompositorFfprobe({ binariesDirectory: REMOTION_BINARIES_DIRECTORY });
const resolveFfmpeg = () => resolveCompositorFfmpeg({ binariesDirectory: REMOTION_BINARIES_DIRECTORY });

/**
 * Códec del video y su duración real, en una sola pasada de ffprobe. La
 * duración la calcula siempre el servidor (nunca se confía en lo que
 * mande el cliente) — necesario para el flujo de Drive, donde nadie la
 * escribe a mano, y más fiable también para la subida directa.
 */
const probeVideoInfo = async (filePath) => {
  const ffprobePath = resolveFfprobe();
  return probeBasicVideoInfo(filePath, { ffprobePath, env: binaryEnv(ffprobePath) });
};

/**
 * Cola simple de renders: como mucho RENDER_CONCURRENCY trabajos de
 * render a la vez (pensado para los recursos del VPS — ver docker-stack.yml).
 *
 * El estado de cada job se guarda también en disco (en el volumen
 * persistente), no solo en memoria: si el contenedor se reinicia a mitad
 * de un render, ese trabajo se pierde igual (no hay checkpoint/resume),
 * pero al menos el estado no desaparece en silencio — queda marcado como
 * error explicando qué pasó, en vez de un 404 fantasma.
 */
const jobs = new Map(); // jobId -> { status, error, createdAt, updatedAt }
const queue = [];
let active = 0;
// Para cancelar: el proceso hijo de render en curso (si lo hay) por job,
// y el set de jobs cuya cancelación se pidió mientras no hay un proceso
// que matar (descargando/transcribiendo/planeando) -- esas etapas
// chequean este set en sus puntos naturales y abortan solas.
const runningChildren = new Map(); // jobId -> ChildProcess
const cancelledJobIds = new Set();

class CancelledError extends Error {
  constructor(jobId) {
    super(`El trabajo ${jobId} fue cancelado.`);
    this.name = "CancelledError";
  }
}

const throwIfCancelled = (jobId) => {
  if (cancelledJobIds.has(jobId)) {
    throw new CancelledError(jobId);
  }
};

const jobFilePath = (jobId) => path.join(UPLOADS_JOBS_DIR, `${jobId}.json`);
const statusFilePath = (jobId) =>
  path.join(UPLOADS_JOBS_DIR, `${jobId}.status.json`);

/**
 * Causa raíz verificada de 7 archivos `.status.json` reales con un
 * JSON válido seguido de caracteres sobrantes (02-nov-2026): la
 * versión anterior de `writeStatus` llamaba `fs.writeFile` (no
 * atómico) sin esperar su propia finalización -- cualquier dos
 * llamadas para el MISMO job podían tener sus escrituras en disco
 * corriendo a la vez, sin ninguna relación de orden entre ellas.
 * Ejemplo real y concreto en este mismo archivo, no hipotético:
 * `enqueue()` escribe "queued" y, en el mismo tick (sin ningún await
 * de por medio más que una lectura de archivo), `processQueue()` ya
 * está corriendo `resolveJobInput()`, que escribe "downloading" --
 * dos `fs.writeFile` al mismo path, despachados al threadpool de
 * libuv sin ninguna sincronización. El mecanismo exacto de la
 * corrupción, y la corrección (archivo temporal + rename atómico,
 * serializado por job), viven en `./atomic-json-store.mjs` -- separado
 * para poder probarlo sin levantar este servidor (igual que
 * resource-acquisition.mjs/editorial.mjs/etc.). El callback de error
 * vacío de la versión anterior (`() => {}`) hacía que cualquier fallo
 * de escritura, incluida esta corrupción, nunca apareciera en ningún
 * lado -- ahora se reporta en el log.
 *
 * La firma y el valor de retorno de `writeStatus` quedan IGUAL --
 * sigue siendo síncrona desde afuera, actualiza `jobs` de inmediato;
 * ningún llamador existente cambia.
 */
const statusWriter = createAtomicJsonWriter({
  onError: (jobId, err) => {
    console.log(
      `[job ${jobId}] no se pudo persistir el estado en disco (${err.message ?? err}) -- el estado en memoria sigue correcto, pero no sobrevive un reinicio del servicio.`,
    );
  },
});

const writeStatus = (jobId, patch) => {
  const current = jobs.get(jobId) ?? {};
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  jobs.set(jobId, next);
  statusWriter.write(jobId, statusFilePath(jobId), next);
  return next;
};

/**
 * Normaliza el códec de un video de entrada (Drive o subida directa, ya
 * unificados en un solo `sourcePath` local por quien llama) -- wrapper
 * fino sobre `normalizeVideoInputCodec` de video-normalization.mjs,
 * donde vive toda la lógica real (así se puede probar con FFmpeg real
 * en CI sin levantar este servidor, ver test-video-conversion-regression.mjs).
 * Acá solo se conectan las piezas propias de este servidor: estado del
 * job, log con prefijo `[job <id>]`, y el mecanismo de cancelación ya
 * existente (`runningChildren`/`cancelledJobIds`/`CancelledError`).
 */
const normalizeVideoCodec = (jobId, sourcePath, destPath) => {
  const ffmpegPath = resolveFfmpeg();
  const ffprobePath = resolveFfprobe();
  return normalizeVideoInputCodec({
    jobId,
    sourcePath,
    destPath,
    allowedCodecs: ALLOWED_VIDEO_CODECS,
    ffmpegPath,
    ffprobePath,
    env: binaryEnv(ffmpegPath),
    threads: VIDEO_CONVERSION_THREADS,
    preset: VIDEO_CONVERSION_PRESET,
    crf: VIDEO_CONVERSION_CRF,
    timeoutMs: VIDEO_CONVERSION_TIMEOUT_MINUTES * 60 * 1000,
    onStatus: (patch) => writeStatus(jobId, patch),
    onLog: (message) => console.log(`[job ${jobId}] ${message}`),
    registerChild: (child) => runningChildren.set(jobId, child),
    unregisterChild: () => runningChildren.delete(jobId),
    isCancelled: () => cancelledJobIds.has(jobId),
    makeCancelledError: () => new CancelledError(jobId),
  });
};

const recoverJobsFromDisk = () => {
  let recovered = 0;
  let markedAsInterrupted = 0;
  for (const file of fs.readdirSync(UPLOADS_JOBS_DIR)) {
    if (!file.endsWith(".status.json")) continue;
    const jobId = file.replace(/\.status\.json$/, "");
    try {
      const raw = fs.readFileSync(path.join(UPLOADS_JOBS_DIR, file), "utf8");
      const status = JSON.parse(raw);
      if (
        status.status === "queued" ||
        status.status === "downloading" ||
        status.status === "converting" ||
        status.status === "transcribing" ||
        status.status === "planning" ||
        status.status === "cancelling" ||
        status.status === "rendering"
      ) {
        status.status = "error";
        status.error =
          "El servicio se reinició mientras este trabajo estaba en curso. Vuelve a enviarlo.";
        status.updatedAt = new Date().toISOString();
        fs.writeFileSync(statusFilePath(jobId), JSON.stringify(status, null, 2));
        markedAsInterrupted += 1;
      }
      jobs.set(jobId, status);
      recovered += 1;
    } catch (err) {
      console.log(`No se pudo recuperar el estado de ${jobId}:`, err.message ?? err);
    }
  }
  if (recovered > 0) {
    console.log(
      `Recuperados ${recovered} trabajo(s) previos del disco (${markedAsInterrupted} marcados como interrumpidos por reinicio).`,
    );
  }
};

/**
 * Observabilidad del render (Fase 0, 08-nov-2026 -- ver
 * server/render-worker.mjs para la causa raíz y la evidencia real de
 * qué imprime `remotion render`). Wrapper fino: toda la ejecución real
 * (spawn, parseo de progreso, timeout, cancelación) vive en
 * `runRemotionRender`, probado con FFmpeg/Chrome reales en CI sin
 * levantar este servidor. Acá solo se conecta con las piezas propias
 * de este servidor: log con línea de inicio, throttling de
 * log/estado, y muestreo de CPU/memoria del contenedor durante el
 * render (server/container-metrics.mjs).
 */
const runRender = async (jobId, job) => {
  const outputPath = path.join(OUTPUTS_DIR, `${jobId}.mp4`);
  const dims = DESTINATION_DIMENSIONS[job.destination];
  const startedAt = Date.now();
  console.log(
    `[render ${jobId}] iniciando -- destino=${job.destination} (${dims ? `${dims.width}x${dims.height}` : "resolución desconocida"}@${ENGINE_FPS}fps), ` +
      `concurrencia de Remotion=${REMOTION_CONCURRENCY}, hora=${new Date().toISOString()}`,
  );

  // Diagnóstico del video FUENTE (render trabado, 08-nov-2026, criterio
  // 2) -- antes de este cambio, nunca se sabía nada del video de
  // entrada (códec/fps/bitrate/keyframes) cuando un render se quedaba
  // sin avanzar. Nunca bloquea el render si el probe falla -- es un
  // dato de diagnóstico, no un requisito para renderizar. Se guarda en
  // `sourceVideoDiagnosticsLine` (criterio 1, 09-nov-2026) para que
  // viaje con la evidencia hacia `GET /jobs/:id` si el render termina
  // en error -- antes solo existía en este console.log, invisible para
  // Alex si el visor de Portainer se queda sin mostrar líneas.
  let sourceVideoDiagnosticsLine = null;
  if (job.input?.type === "recorded-video" && job.input.baseVideo) {
    try {
      const ffprobePath = resolveFfprobe();
      const diag = await probeSourceVideoDiagnostics(path.join(PROJECT_ROOT, "public", job.input.baseVideo), {
        ffprobePath,
        env: binaryEnv(ffprobePath),
      });
      sourceVideoDiagnosticsLine = formatSourceVideoDiagnosticsLine(diag);
      console.log(`[render ${jobId}] video fuente -- ${sourceVideoDiagnosticsLine}`);
    } catch (err) {
      sourceVideoDiagnosticsLine = `no se pudo diagnosticar (${err.message ?? err})`;
      console.log(`[render ${jobId}] no se pudo diagnosticar el video fuente (se continúa igual): ${err.message ?? err}`);
    }
  }

  const metrics = startContainerMetricsSampling({ intervalMs: RENDER_METRICS_SAMPLE_INTERVAL_MS });
  let lastLoggedPercent = -1000;
  let lastLoggedAt = 0;
  let totalFramesSeen = null;

  const maybeLogAndStoreProgress = (event) => {
    const now = Date.now();
    // "rendering" nunca reporta el tick exacto N=total (confirmado real
    // en CI, 08-nov-2026: se queda en total-1, el índice del último
    // cuadro, y pasa directo a "encoding") -- por eso la tolerancia de
    // 1 acá; "encoding" sí llega exacto.
    const isDone =
      (event.stage === "rendering" && event.renderedFrames >= event.totalFrames - 1) ||
      (event.stage === "encoding" && event.encodedFrames === event.totalFrames);
    const shouldLog =
      event.percent - lastLoggedPercent >= RENDER_PROGRESS_LOG_PERCENT_STEP ||
      now - lastLoggedAt >= RENDER_PROGRESS_LOG_INTERVAL_MS ||
      isDone;
    if (!shouldLog) return;
    lastLoggedPercent = event.percent;
    lastLoggedAt = now;
    const elapsedSeconds = Math.round((now - startedAt) / 1000);

    if (event.stage === "rendering") {
      totalFramesSeen = event.totalFrames;
      console.log(
        `[render ${jobId}] renderizando: ${event.renderedFrames}/${event.totalFrames} cuadros (${event.percent}%), ` +
          `transcurrido=${elapsedSeconds}s` + (event.etaSeconds !== null ? `, restante_estimado=${event.etaSeconds}s` : ""),
      );
    } else {
      console.log(
        `[render ${jobId}] codificando: ${event.encodedFrames}/${event.totalFrames} cuadros (${event.percent}%), transcurrido=${elapsedSeconds}s`,
      );
    }
    writeStatus(jobId, {
      status: "rendering",
      renderProgress: {
        stage: event.stage,
        percent: event.percent,
        renderedFrames: event.stage === "rendering" ? event.renderedFrames : undefined,
        encodedFrames: event.stage === "encoding" ? event.encodedFrames : undefined,
        totalFrames: event.totalFrames,
        etaSeconds: event.stage === "rendering" ? event.etaSeconds : undefined,
        elapsedSeconds,
      },
    });
  };

  const renderPromise = runRemotionRender({
    cwd: PROJECT_ROOT,
    env: process.env,
    outputPath,
    propsJobFile: `uploads/jobs/${jobId}.json`,
    concurrency: REMOTION_CONCURRENCY,
    enableMultiprocessOnLinux: ENABLE_MULTIPROCESS_ON_LINUX,
    browserExecutable: REMOTION_BROWSER_EXECUTABLE,
    binariesDirectory: REMOTION_BINARIES_DIRECTORY,
    timeoutMs: RENDER_TIMEOUT_MINUTES * 60 * 1000,
    stuckAfterMs: RENDER_STUCK_TIMEOUT_MINUTES * 60 * 1000,
    onStuck: async ({ lastProgressEvent, msSinceLastProgress }) => {
      // Diagnóstico de CPU en el momento del atasco -- distingue las
      // dos hipótesis reales conocidas de Remotion (ver
      // render-worker.mjs#RenderStuckError): si el proceso está
      // realmente en 0% de CPU (coincide con el issue público citado
      // ahí) o si está ocupado decodificando algo muy lento (keyframes
      // dispersos) sin avanzar en cuadros todavía. Dos muestras con
      // una pausa corta -- una sola lectura de cpu.stat es acumulada
      // desde el inicio del contenedor, no sirve sola para esto.
      // Devuelve el diagnóstico (en vez de solo loguearlo, como antes
      // de la causa raíz con evidencia del 09-nov-2026): render-worker
      // lo adjunta al error final para que llegue a `GET /jobs/:id`.
      const memBytes = await readContainerMemoryBytes();
      const usageBefore = await readContainerCpuUsageMicros();
      const sampleWindowMs = 3000;
      await new Promise((r) => setTimeout(r, sampleWindowMs));
      const usageAfter = await readContainerCpuUsageMicros();
      const cpuCoresInWindow =
        usageBefore !== null && usageAfter !== null ? (usageAfter - usageBefore) / (sampleWindowMs * 1000) : null;
      const diagnosis = {
        memoryMB: memBytes !== null ? Math.round(memBytes / 1024 / 1024) : null,
        cpuCoresInWindow: cpuCoresInWindow !== null ? Math.round(cpuCoresInWindow * 100) / 100 : null,
        sampleWindowSeconds: sampleWindowMs / 1000,
        measuredBeforeKill: true,
      };
      console.log(
        `[render ${jobId}] DIAGNÓSTICO DE ATASCO -- sin cuadros nuevos en ${Math.round(msSinceLastProgress / 60000)} min. ` +
          `Último evento: ${lastProgressEvent ? JSON.stringify(lastProgressEvent) : "ninguno (nunca llegó a reportar progreso)"}. ` +
          `Memoria actual=${diagnosis.memoryMB !== null ? `${diagnosis.memoryMB}MB` : "desconocida"}. ` +
          `CPU en los últimos ${sampleWindowMs / 1000}s=${diagnosis.cpuCoresInWindow !== null ? `${diagnosis.cpuCoresInWindow} núcleos` : "desconocida"} ` +
          `(cerca de 0 = proceso realmente colgado/sin actividad; alto = ocupado pero sin terminar un cuadro, posible decodificación muy lenta).`,
      );
      return diagnosis;
    },
    onProgress: (event) => {
      if (event.stage === "rendering" || event.stage === "encoding") {
        maybeLogAndStoreProgress(event);
      } else if (event.stage === "stitched") {
        console.log(`[render ${jobId}] unión final de cuadros: ${event.durationMs}ms`);
      }
    },
    onLog: (msg) => console.log(`[render ${jobId}] ${msg}`),
    registerChild: (child) => runningChildren.set(jobId, child),
    unregisterChild: () => runningChildren.delete(jobId),
    isCancelled: () => cancelledJobIds.has(jobId),
    makeCancelledError: () => new CancelledError(jobId),
  }).catch((err) => {
    // Criterio 1: la línea del video fuente se mide ACÁ (arriba, antes
    // de llamar a runRemotionRender), no dentro de render-worker.mjs
    // -- se adjunta a la misma evidencia del error en vez de quedar
    // separada.
    if (err && typeof err === "object") {
      err.evidence = { ...(err.evidence ?? {}), sourceVideoDiagnosticsLine };
    }
    throw err;
  });

  return renderPromise.finally(async () => {
    const summary = await metrics.stop();
    if (!summary.available) {
      console.log(`[render ${jobId}] métricas de contenedor no disponibles en este entorno (sin cgroup -- normal fuera de Linux).`);
      return;
    }
    console.log(
      `[render ${jobId}] contenedor durante el render -- memoria: pico=${summary.peakMemoryMB}MB promedio=${summary.avgMemoryMB}MB; ` +
        `CPU: pico=${summary.peakCpuCores ?? "?"} núcleos (${summary.peakCpuPercentOfLimit ?? "?"}% del límite), promedio=${summary.avgCpuCores ?? "?"} núcleos (${summary.avgCpuPercentOfLimit ?? "?"}% del límite), ` +
        `límite del contenedor=${summary.cpuLimitCores ?? "desconocido"} núcleos.`,
    );
    if (totalFramesSeen) {
      const elapsedSeconds = (Date.now() - startedAt) / 1000;
      const outputDurationSeconds = totalFramesSeen / ENGINE_FPS;
      const fps = totalFramesSeen / elapsedSeconds;
      console.log(
        `[render ${jobId}] rendimiento medido -- ${fps.toFixed(2)} cuadros/s, ` +
          `${(elapsedSeconds / outputDurationSeconds).toFixed(2)} min de render por min de video de SALIDA (ya editado), ` +
          `concurrencia de Remotion=${REMOTION_CONCURRENCY}.`,
      );
    }
  });
};

/**
 * Si el trabajo vino con una referencia de Drive, lo descarga ahora:
 * streaming a disco, con reintentos y verificación de tamaño/MD5. Si
 * vino por subida directa pero necesitaba conversión de códec (HEVC),
 * el archivo ya está en disco (`pendingVideoFile`, dejado por
 * `POST /jobs`) y solo falta normalizarlo. Si ya tiene `baseVideo`
 * (subida directa sin conversión necesaria), no hace nada. En ambos
 * casos de descarga/subida pendiente, el códec se normaliza acá mismo
 * (ver `normalizeVideoCodec`) antes de continuar el resto del pipeline.
 */
const resolveJobInput = async (jobId, job) => {
  throwIfCancelled(jobId);
  if (job.input.type !== "recorded-video" || job.input.baseVideo) {
    return job;
  }
  if (!job.input.driveFileId && !job.input.pendingVideoFile) {
    throw new Error(
      'input.type es "recorded-video": falta "baseVideo" (subida directa) o "driveFileId" (Drive).',
    );
  }

  const destPath = path.join(UPLOADS_VIDEOS_DIR, `${jobId}.mp4`);
  let sourcePath;

  if (job.input.driveFileId) {
    writeStatus(jobId, { status: "downloading" });
    console.log(`[job ${jobId}] descargando de Drive: ${job.input.driveFileId}`);
    sourcePath = `${destPath}.part`;
    await downloadFileWithRetry(job.input.driveFileId, sourcePath, {
      maxAttempts: DRIVE_DOWNLOAD_MAX_ATTEMPTS,
      waitMs: DRIVE_DOWNLOAD_WAIT_MS,
    });
  } else {
    sourcePath = path.join(UPLOADS_VIDEOS_DIR, job.input.pendingVideoFile);
  }

  const info = await normalizeVideoCodec(jobId, sourcePath, destPath);

  job.input.baseVideo = `uploads/videos/${jobId}.mp4`;
  job.input.durationInSeconds = info.durationSeconds;
  delete job.input.driveFileId;
  delete job.input.pendingVideoFile;
  await fsp.writeFile(jobFilePath(jobId), JSON.stringify(job, null, 2));

  return job;
};

/**
 * Transcribe automáticamente (Etapa 1) si el job no trae ya subtítulos
 * propios y no pidió saltarse este paso (`job.skipTranscription`). Mide
 * tiempo y memoria del contenedor — se registra en el log del servidor.
 */
const transcribeJobIfNeeded = async (jobId, job) => {
  throwIfCancelled(jobId);
  if (job.input.type !== "recorded-video") return job;
  if (job.skipTranscription) return job;
  if (Array.isArray(job.captions) && job.captions.length > 0) return job;

  writeStatus(jobId, { status: "transcribing" });
  console.log(`[job ${jobId}] transcribiendo...`);

  const correctionsPath = path.join(
    PROJECT_ROOT,
    "public/channels",
    job.channel,
    "corrections.json",
  );
  const corrections = await fsp
    .readFile(correctionsPath, "utf8")
    .then(JSON.parse)
    .catch(() => []);

  const ffmpegPath = resolveFfmpeg();
  const result = await transcribeVideo({
    videoPath: path.join(PROJECT_ROOT, "public", job.input.baseVideo),
    corrections,
    ffmpegPath,
    ffmpegEnv: binaryEnv(ffmpegPath),
    whisperDir: WHISPER_DIR,
    model: WHISPER_MODEL,
    onLog: (msg) => console.log(`[job ${jobId}] ${msg}`),
  });

  console.log(
    `[job ${jobId}] transcripción lista: idioma=${result.detectedLanguage} ${result.metrics.lineCount} líneas en ${(result.metrics.elapsedMs / 1000).toFixed(1)}s` +
      (result.metrics.containerMemoryBytes.duringOrAfter
        ? ` memoria_contenedor=${(result.metrics.containerMemoryBytes.duringOrAfter / 1024 / 1024).toFixed(0)}MB`
        : ""),
  );

  job.captions = result.captions;
  // Palabra por palabra -- la usa planEditIfNeeded para cortar con
  // precisión; no la usa el motor de render (eso sigue con `captions`).
  job.transcriptWords = result.words;
  await fsp.writeFile(jobFilePath(jobId), JSON.stringify(job, null, 2));
  return job;
};

/**
 * IA editorial (Etapa 2): si el job ya trae su transcripción pero no trae
 * decisión de corte/zoom propia, le pide a Claude un plan y lo aplica. Se
 * salta solo (sin romper el job) si no hay guía editorial para el canal o
 * si no hay transcripción todavía — así un job manual con sus propios
 * `cuts`/`zooms` sigue funcionando exactamente igual que hoy.
 */
/**
 * Guía editorial, perfil de recursos e historial de correcciones de un
 * canal -- compartido entre el flujo normal (planEditIfNeeded) y
 * POST /jobs/:id/replan, para que ambos elijan el archivo de guía de la
 * misma forma (ver job.layout) y no se desincronicen con el tiempo.
 */
// relocateToNearestSurvivingInterval y remapResourcesWithCtaGuarantee
// viven en ./cta-guarantee.mjs (extraídas para poder testearlas sin
// levantar este servidor Express) -- compartidas entre el flujo normal
// (planEditIfNeeded) y POST /jobs/:id/replan.

/**
 * Modelo combinado (02-nov-2026): `visualStyle` opcional del perfil
 * del canal (`public/channels/<canal>/profile.json`, el archivo del
 * TEMA que ya carga el motor de render para los colores -- no el
 * `editorial-profile.json` de arriba, que es otro archivo) para que
 * las imágenes generadas con IA de un mismo canal se vean coherentes.
 * Sin el archivo o sin el campo, devuelve `undefined` -- nunca lanza;
 * `buildImageGenerationPrompt` ya tiene su propio estilo genérico de
 * respaldo (ver image-generation.mjs).
 */
const readChannelVisualStyle = async (channel) => {
  try {
    const raw = await fsp.readFile(path.join(PROJECT_ROOT, "public/channels", channel, "profile.json"), "utf8");
    const profile = JSON.parse(raw);
    return typeof profile?.theme?.visualStyle === "string" ? profile.theme.visualStyle : undefined;
  } catch {
    return undefined;
  }
};

const planEditIfNeeded = async (jobId, job) => {
  throwIfCancelled(jobId);
  if (job.input.type !== "recorded-video") return job;
  if (job.skipEditorialAI) return job;
  if ((job.cuts && job.cuts.length > 0) || (job.zooms && job.zooms.length > 0)) {
    return job;
  }
  if (!Array.isArray(job.captions) || job.captions.length === 0) return job;

  const { guidelines, resourceProfile, correctionsHistory } = await loadChannelEditorialContext(
    PROJECT_ROOT,
    job.channel,
    job.layout,
  );
  if (!guidelines) {
    console.log(
      `[job ${jobId}] sin guía editorial para el canal "${job.channel}" — se omite la IA editorial.`,
    );
    return job;
  }

  writeStatus(jobId, { status: "planning" });
  console.log(`[job ${jobId}] pidiendo plan de edición...`);

  // Un video de 2 horas renderizado sin edición real no sirve de nada --
  // si la IA editorial falla, el job se detiene en "error" por defecto.
  // Solo sigue sin cortes/zoom si el job lo pide EXPLÍCITAMENTE
  // (job.allowRenderWithoutEditorialPlan === true), para no bloquear a
  // quien de verdad quiere ese comportamiento (p.ej. pruebas manuales).
  let plan;
  try {
    plan = await planEdit({
      captions: job.captions,
      transcriptWords: job.transcriptWords,
      guidelines,
      resourceProfile,
      correctionsHistory,
      durationInSeconds: job.input.durationInSeconds,
      destination: job.destination,
      layout: job.layout,
      onLog: (msg) => console.log(`[job ${jobId}] ${msg}`),
    });
  } catch (err) {
    const message = `La IA editorial falló: ${err.message ?? err}`;
    if (job.allowRenderWithoutEditorialPlan === true) {
      console.log(
        `[job ${jobId}] ${message} -- allowRenderWithoutEditorialPlan=true, se continúa sin cortes/zoom automáticos.`,
      );
      return job;
    }
    console.log(`[job ${jobId}] ${message} -- deteniendo el job (no se renderiza sin edición).`);
    throw new Error(message);
  }

  // Ojo: "llamada=Xs" es cuánto tardó la llamada a la API (tiempo de
  // reloj), NO la suma de lo que se corta del video -- van aparte y
  // etiquetados a propósito, porque mezclarlos sin etiqueta ya generó
  // una confusión real (se leyó como si fuera la duración total
  // recortada, que es un número completamente distinto).
  const totalCutSeconds = plan.cuts.reduce((sum, c) => sum + (c.endSeconds - c.startSeconds), 0);
  console.log(
    `[job ${jobId}] plan de edición listo: ${plan.cuts.length} corte(s) (${totalCutSeconds.toFixed(1)}s en total), ` +
      `${plan.zooms.length} zoom(s), llamada=${(plan.metrics.elapsedMs / 1000).toFixed(1)}s, modelo=${plan.metrics.model}, ` +
      `stop_reason=${plan.metrics.stopReason}, max_tokens=${plan.metrics.maxTokens}, ` +
      `reintentó=${plan.metrics.retried}, tokens=${plan.metrics.inputTokens ?? "?"}in/${plan.metrics.outputTokens ?? "?"}out`,
  );
  if (plan.notes) {
    console.log(`[job ${jobId}] notas del editor IA: ${plan.notes}`);
  }
  if (plan.cutIssues.length > 0) {
    console.log(`[job ${jobId}] ${plan.cutIssues.length} corte(s) propuesto(s) se descartaron:`);
    for (const issue of plan.cutIssues) {
      console.log(`[job ${jobId}]   ${issue}`);
    }
  }
  // Cortes casi contiguos (sin palabra real en el hueco) se fusionan acá
  // -- antes de persistir job.cuts, para que el motor nunca vea la
  // astilla. Si hay transcriptWords los usa para verificar que el hueco
  // no se come una palabra; sin eso, no fusiona nada (por seguridad).
  const { cuts: mergedCuts, mergeLog } = mergeNearbyGaplessCuts(plan.cuts, job.transcriptWords);
  for (const line of mergeLog) {
    console.log(`[job ${jobId}]   ${line}`);
  }
  // Defecto real (job ff69b475/a416b0e): un corte terminaba dentro de la
  // palabra "Cameron" y se comía sus primeras sílabas. Ningún borde de
  // corte puede caer dentro de una palabra -- se recorta hacia adentro
  // con margen, o se descarta entero si no hay forma segura de hacerlo.
  const { cuts: snappedCuts, cutIssues: snapCutIssues } = snapCutsToWordBoundaries(mergedCuts, job.transcriptWords);
  for (const issue of snapCutIssues) {
    console.log(`[job ${jobId}]   ${issue}`);
  }
  // Los tiempos de Whisper pueden estar desfasados del audio real --
  // confirmado en producción: "Cameron Sepah" sonaba cortado aunque el
  // ajuste por palabra ya se había aplicado, y el desfase medido
  // superaba la ventana angosta que se usaba antes. El audio real
  // (silencedetect de FFmpeg) es ahora la fuente PRINCIPAL: busca la
  // pausa real más cercana a cada borde dentro de +-1s, sin exigir que
  // quede dentro del límite "seguro por palabra" de Whisper. Si algún
  // borde no tiene una pausa real confirmada, se descarta el corte
  // entero -- se prioriza conservar el audio hablado antes que
  // producir un corte sin confirmar. Sin un video real en disco (job
  // de prueba sin `input.baseVideo`) se omite -- quedan los cortes ya
  // seguros por palabra, igual que antes de esta corrección.
  let acousticCuts = snappedCuts;
  let acousticCutIssues = [];
  let qualityGateIncidents = [];
  if (typeof job.input.baseVideo === "string") {
    const videoPath = path.join(PROJECT_ROOT, "public", job.input.baseVideo);
    const ffmpegPathForAudio = resolveFfmpeg();
    const ffmpegEnvForAudio = binaryEnv(ffmpegPathForAudio);
    // Medición explícita del tiempo adicional de la solución estructural
    // (dictamen 31-oct-2026, sección 10: "tiempo adicional real de
    // procesamiento") -- se mide con un cronómetro en el propio proceso,
    // no infiriendo restas entre líneas de log con otra marca de tiempo.
    const acousticPhaseStartedAt = Date.now();
    ({ cuts: acousticCuts, cutIssues: acousticCutIssues } = await refineCutsWithRealSilence({
      cuts: snappedCuts,
      videoPath,
      videoDurationSeconds: job.input.durationInSeconds,
      ffmpegPath: ffmpegPathForAudio,
      ffmpegEnv: ffmpegEnvForAudio,
      log: (msg) => console.log(`[job ${jobId}]   ${msg}`),
    }));

    // Puerta automática de calidad (dictamen 31-oct-2026, sección 4):
    // antes de persistir los cortes definitivos, se arma la pista de
    // audio EDITADA con exactamente esos cortes y se verifica que no
    // haya empalmes defectuosos ni silencios anormales. Si algo falla,
    // esta función ya intenta su propia corrección (siguiente pausa
    // candidata) o descarta el corte -- lo que llega acá en `.cuts` es
    // lo que de verdad se renderiza.
    const gateResult = await runQualityGateWithRemediation({
      ffmpegPath: ffmpegPathForAudio,
      ffmpegEnv: ffmpegEnvForAudio,
      videoPath,
      cuts: acousticCuts,
      videoDurationSeconds: job.input.durationInSeconds,
      log: (msg) => console.log(`[job ${jobId}]   ${msg}`),
    });
    acousticCuts = gateResult.cuts;
    qualityGateIncidents = gateResult.incidents;
    console.log(
      `[job ${jobId}] puerta de calidad: ${gateResult.ok ? "OK" : "NO SUPERADA"} tras ${gateResult.rounds} ronda(s)${gateResult.stoppedReason ? ` -- ${gateResult.stoppedReason}` : ""}.`,
    );
    console.log(
      `[job ${jobId}] tiempo adicional de la solución estructural (mapa de pausas reales + puerta de calidad): ${((Date.now() - acousticPhaseStartedAt) / 1000).toFixed(1)}s.`,
    );
    if (!gateResult.ok) {
      throw new Error(
        `La puerta de calidad del audio no se pudo resolver automáticamente: ${gateResult.stoppedReason}`,
      );
    }
  }
  for (const issue of [...acousticCutIssues, ...qualityGateIncidents]) {
    console.log(`[job ${jobId}]   ${issue}`);
  }
  for (const cut of acousticCuts) {
    console.log(
      `[job ${jobId}]   corte ${cut.startSeconds.toFixed(2)}-${cut.endSeconds.toFixed(2)}s: ${cut.reason ?? "(sin razón)"}`,
    );
  }
  for (const zoom of plan.zooms) {
    console.log(
      `[job ${jobId}]   zoom ${zoom.startSeconds.toFixed(2)}-${zoom.endSeconds.toFixed(2)}s (${zoom.fromScale}x->${zoom.toScale}x): ${zoom.reason ?? "(sin razón)"}`,
    );
  }
  console.log(`[job ${jobId}] recursos propuestos: ${plan.resources.length}`);
  for (const resource of plan.resources) {
    console.log(
      `[job ${jobId}]   recurso [${resource.segment}/${resource.type}] ${resource.startSeconds.toFixed(2)}-${resource.endSeconds.toFixed(2)}s ` +
        `(${resource.editorialGoal}, esencial=${resource.essential}): ${resource.description}` +
        (resource.emojiChar ? ` -- emoji: ${resource.emojiChar}` : ""),
    );
  }

  job.cuts = acousticCuts.map(({ id, startSeconds, endSeconds }) => ({ id, startSeconds, endSeconds }));
  job.cutIssues = [...plan.cutIssues, ...snapCutIssues, ...acousticCutIssues, ...qualityGateIncidents];
  job.zooms = plan.zooms.map(({ id, startSeconds, endSeconds, fromScale, toScale, origin }) => ({
    id,
    startSeconds,
    endSeconds,
    fromScale,
    toScale,
    origin,
  }));

  // Los recursos se pensaron en tiempo del video ORIGINAL, igual que los
  // cortes -- se traducen acá a la línea temporal FINAL (ya con los
  // cortes aplicados y fusionados) con el mismo mecanismo que usa el
  // motor para overlays/captions. Los CTA obligatorios (ctaPosition)
  // nunca desaparecen en silencio -- ver remapResourcesWithCtaGuarantee.
  const timeline = buildTimeline(job.input.durationInSeconds, job.cuts);
  const { resources: remappedResources, droppedCount, ctaIssues } = remapResourcesWithCtaGuarantee({
    resources: plan.resources,
    timeline,
    log: (msg) => console.log(`[job ${jobId}]   ${msg}`),
    existingCtaIssues: plan.ctaIssues,
  });
  if (droppedCount > 0) {
    console.log(`[job ${jobId}] ${droppedCount} recurso(s) descartado(s) por caer dentro de un corte.`);
  }
  if (ctaIssues.length > 0) {
    console.log(`[job ${jobId}] *** ${ctaIssues.length} PROBLEMA(S) CON LOS CTA OBLIGATORIOS ***`);
    for (const issue of ctaIssues) {
      console.log(`[job ${jobId}]   ${issue}`);
    }
  }
  console.log(`[job ${jobId}] duración editada: ${timeline.outputDurationInSeconds.toFixed(2)}s`);
  for (const r of remappedResources) {
    if (r.ctaPosition) {
      console.log(
        `[job ${jobId}]   CTA "${r.ctaPosition}" en ${r.editedSeconds}s (${r.editedPercent}% de la duración editada): ${r.description}`,
      );
    }
  }
  job.resources = remappedResources;
  job.ctaIssues = ctaIssues;
  // Fase 3A (autorizada 30-oct-2026) solo renderiza CTA y text-highlight --
  // el resto queda identificado como pendiente de Fase 3B, nunca inventado
  // ni omitido en silencio (ver cta-guarantee.mjs#computePendingResources).
  job.pendingResources = computePendingResources(remappedResources, (msg) => console.log(`[job ${jobId}] ${msg}`));

  await fsp.writeFile(jobFilePath(jobId), JSON.stringify(job, null, 2));
  return job;
};

/**
 * Fase 3B (31-oct-2026): resuelve contra Pixabay los recursos `broll`/
 * `image` que todavía no tengan `resolvedAsset` -- corre SIEMPRE, no
 * solo cuando `planEditIfNeeded` llamó al modelo (un job con `resources`
 * puestos a mano, como la prueba corta de esta entrega, también pasa
 * por acá; es idempotente -- un recurso ya resuelto o ya marcado como
 * fallido no se vuelve a tocar). El planificador sigue siendo el único
 * que decide qué recurso usar, dónde va y cuánto dura -- esto solo
 * responde de dónde sale el archivo.
 *
 * "essential" sin alternativa válida detiene el job (regla vigente,
 * dictamen de Fase 3B) -- pero SOLO para este caso nuevo (broll/image
 * sin resultado en Pixabay). Un `document-reference`/`graphic` esencial
 * pendiente sigue como siempre (se registra, no detiene) -- no es parte
 * de este alcance y no debe cambiar de comportamiento sin que se pida.
 */
const acquireResourcesIfNeeded = async (jobId, job) => {
  throwIfCancelled(jobId);
  const needsAcquisition = (job.resources ?? []).some(
    (r) => (r.type === "broll" || r.type === "image") && !r.resolvedAsset && !r.acquisitionFailureReason,
  );
  if (!needsAcquisition) return job;

  const apiKey = readPixabayApiKey();
  let updatedResources = job.resources;
  if (!apiKey) {
    console.log(`[job ${jobId}] sin clave de Pixabay configurada (PIXABAY_API_KEY_FILE) -- los recursos broll/image quedan pendientes.`);
    updatedResources = (job.resources ?? []).map((r) =>
      (r.type === "broll" || r.type === "image") && !r.resolvedAsset && !r.acquisitionFailureReason
        ? { ...r, acquisitionFailureReason: "no se pudo adquirir: falta configurar la clave de Pixabay en el servicio." }
        : r,
    );
  } else {
    // resolveOneResource ya registra, para cada recurso, la consulta,
    // los candidatos evaluados (con su puntaje), el elegido con su
    // licencia/procedencia, o el motivo del rechazo -- no se repite ese
    // detalle acá (quedaría tres veces en el log: acá, adentro, y en el
    // resumen de pendingResources más abajo).
    //
    // Modelo combinado (02-nov-2026): si Pixabay no encuentra nada, el
    // mismo `resolveOneResource` intenta generación con IA -- solo
    // para "illustrative-ok", solo si hay clave de Gemini configurada
    // (su ausencia NUNCA detiene el job, simplemente esos recursos
    // quedan pendientes con el motivo de Pixabay, igual que hoy sin
    // la clave de Gemini creada todavía).
    const imageGenerationApiKey = readGeminiApiKey();
    const visualStyle = await readChannelVisualStyle(job.channel);
    ({ resources: updatedResources } = await acquireResourcesForJob({
      resources: job.resources,
      apiKey,
      cacheDir: RESOURCE_CACHE_DIR,
      assetsDir: RESOURCE_ASSETS_DIR,
      jobId,
      imageGenerationApiKey,
      visualStyle,
      log: (msg) => console.log(`[job ${jobId}]   ${msg}`),
    }));
  }

  job.resources = updatedResources;
  job.pendingResources = computePendingResources(updatedResources, (msg) => console.log(`[job ${jobId}] ${msg}`));
  await fsp.writeFile(jobFilePath(jobId), JSON.stringify(job, null, 2));

  const unresolvedEssential = updatedResources.filter(
    (r) => (r.type === "broll" || r.type === "image") && r.essential && !r.resolvedAsset,
  );
  if (unresolvedEssential.length > 0) {
    throw new Error(
      `${unresolvedEssential.length} recurso(s) esencial(es) de tipo broll/image no se pudieron adquirir: ` +
        unresolvedEssential.map((r) => `"${r.id}" (${r.acquisitionFailureReason ?? "sin motivo registrado"})`).join("; ") +
        " -- se detiene el job, pide resolución (otra consulta visual, o resolverlo a mano) antes de reintentar.",
    );
  }

  return job;
};

/**
 * Verifica técnicamente el MP4 final (duración/resolución/códec) y, si
 * hay una carpeta de Drive configurada, lo sube ahí -- para poder
 * revisarlo/aprobarlo sin acceso al VPS. Lo llama automáticamente
 * processQueue al terminar un render, pero también se puede llamar a
 * mano (POST /jobs/:id/finalize) para un job que ya terminó antes de que
 * existiera esto, o si la subida falló la primera vez y se quiere
 * reintentar. Mira el ARCHIVO en disco, no el status guardado -- un job
 * puede haber renderizado bien y el status haber quedado mal (p.ej. por
 * un reinicio justo después) sin que eso invalide el MP4 ya escrito.
 */
const finalizeJobOutput = async (jobId) => {
  const outputPath = path.join(OUTPUTS_DIR, `${jobId}.mp4`);

  const outputInfo = await probeVideoInfo(outputPath).catch((err) => {
    console.log(`[job ${jobId}] no se pudo verificar el MP4 final:`, err.message ?? err);
    return null;
  });
  if (outputInfo) {
    const sizeBytes = await fsp.stat(outputPath).then((s) => s.size).catch(() => null);
    outputInfo.sizeBytes = sizeBytes;
    console.log(
      `[job ${jobId}] salida verificada: ${outputInfo.width}x${outputInfo.height}, ` +
        `códec=${outputInfo.codec}, duración=${outputInfo.durationSeconds?.toFixed(2)}s, ` +
        `tamaño=${sizeBytes ? (sizeBytes / 1024 / 1024).toFixed(1) + "MB" : "?"}`,
    );
  }

  let driveOutput;
  if (DRIVE_OUTPUT_FOLDER_ID) {
    try {
      console.log(`[job ${jobId}] subiendo el MP4 final a Drive...`);
      const uploaded = await uploadFile({
        filePath: outputPath,
        fileName: `${jobId}.mp4`,
        folderId: DRIVE_OUTPUT_FOLDER_ID,
      });
      driveOutput = { fileId: uploaded.id, webViewLink: uploaded.webViewLink };
      console.log(`[job ${jobId}] subido a Drive: ${uploaded.webViewLink}`);
    } catch (err) {
      console.log(`[job ${jobId}] no se pudo subir a Drive:`, err.message ?? err);
    }
  }

  // Decisión de Alex (31-oct-2026): youtube-16-9 no lleva subtítulos
  // pegados (YouTube ya muestra los suyos encima) -- en su lugar se
  // entrega un .srt aparte, con el mismo nombre base que el MP4, en la
  // misma carpeta de Drive. vertical-9-16 sigue llevándolos pegados y
  // NO genera .srt (no hace falta: ya están en la imagen).
  let srtOutput;
  try {
    const job = JSON.parse(await fsp.readFile(jobFilePath(jobId), "utf8"));
    if (Array.isArray(job.captions) && job.captions.length > 0 && !shouldBurnCaptions(job)) {
      const timeline = buildTimeline(job.input.durationInSeconds, job.cuts ?? []);
      const srtText = buildSrt(job.captions, timeline);
      const srtPath = path.join(OUTPUTS_DIR, `${jobId}.srt`);
      await fsp.writeFile(srtPath, srtText, "utf8");
      console.log(`[job ${jobId}] .srt generado (destino "${job.destination}", sin subtítulos pegados): ${srtPath}`);

      if (DRIVE_OUTPUT_FOLDER_ID) {
        try {
          console.log(`[job ${jobId}] subiendo el .srt a Drive...`);
          const uploadedSrt = await uploadFile({
            filePath: srtPath,
            fileName: `${jobId}.srt`,
            folderId: DRIVE_OUTPUT_FOLDER_ID,
            mimeType: "application/x-subrip",
          });
          srtOutput = { fileId: uploadedSrt.id, webViewLink: uploadedSrt.webViewLink };
          console.log(`[job ${jobId}] .srt subido a Drive: ${uploadedSrt.webViewLink}`);
        } catch (err) {
          console.log(`[job ${jobId}] no se pudo subir el .srt a Drive:`, err.message ?? err);
        }
      }
    }
  } catch (err) {
    console.log(`[job ${jobId}] no se pudo generar el .srt:`, err.message ?? err);
  }

  return writeStatus(jobId, {
    output: outputInfo ?? undefined,
    drive: driveOutput,
    driveSrt: srtOutput,
  });
};

const processQueue = () => {
  if (active >= RENDER_CONCURRENCY || queue.length === 0) {
    return;
  }
  const jobId = queue.shift();
  active += 1;

  const attemptStartedAt = new Date().toISOString();

  (async () => {
    console.log(`[job ${jobId}] iniciando (active=${active})`);
    const job = JSON.parse(await fsp.readFile(jobFilePath(jobId), "utf8"));
    await resolveJobInput(jobId, job);
    await transcribeJobIfNeeded(jobId, job);
    await planEditIfNeeded(jobId, job);
    await acquireResourcesIfNeeded(jobId, job);
    throwIfCancelled(jobId);

    // Para validar transcripción + plan editorial sin comprometerse a un
    // render real (p.ej. un video largo nuevo, antes de confiar en el
    // tiempo/costo que va a tomar) -- job.planOnly=true. Nunca renderiza,
    // nunca genera MP4, nunca sube a Drive. Por defecto false: el
    // comportamiento normal no cambia.
    if (job.planOnly === true) {
      console.log(`[job ${jobId}] planOnly=true -- transcripción y plan listos, sin renderizar (pedido explícito).`);
      writeStatus(jobId, { status: "done" });
      return;
    }

    writeStatus(jobId, { status: "rendering" });
    await runRender(jobId, job);
    console.log(`[render ${jobId}] terminado OK`);

    await finalizeJobOutput(jobId);
    writeStatus(jobId, { status: "done" });
  })()
    .catch((err) => {
      // Evidencia accesible por la API + historial de intentos (Fase
      // 0, causa raíz con evidencia del VPS, 09-nov-2026, autorizado
      // por Alex, criterios 1+2). Causa raíz real confirmada contra el
      // código: antes, `error`/`renderProgress` se guardaban en el
      // estado del job, pero (a) nunca llevaban nada de lo que
      // Remotion/Chrome dijeron durante un atasco (solo el mensaje
      // final), y (b) un reintento posterior los borraba sin dejar
      // rastro del intento anterior. `renderEvidence` lleva TODO lo
      // que render-worker.mjs capturó (adjuntado en `err.evidence`
      // cuando el error viene de un render real -- undefined para
      // errores de otras etapas, p.ej. transcripción/plan/recursos,
      // donde no aplica). `attempts` conserva el historial acotado
      // ANTES de que el próximo reintento pise `error`/`renderProgress`.
      const renderEvidence = err?.evidence ?? undefined;
      const current = jobs.get(jobId) ?? {};
      const attemptRecord = {
        attemptNumber: (current.attempts?.length ?? 0) + 1,
        startedAt: attemptStartedAt,
        endedAt: new Date().toISOString(),
        outcome: err instanceof CancelledError ? "cancelled" : "error",
        error: err instanceof CancelledError ? undefined : String(err.message ?? err),
        renderEvidence,
      };
      const attempts = appendAttemptHistory(current.attempts, attemptRecord);

      if (err instanceof CancelledError) {
        // Criterio 5 (corrección 10-nov-2026): antes, cancelar un
        // render no dejaba ningún `renderEvidence` en el estado vivo
        // del job -- solo quedaba (desde ahora) en `attempts`. Ahora
        // también queda en el nivel superior, igual que timeout/atasco.
        console.log(`[job ${jobId}] cancelado.`);
        writeStatus(jobId, { status: "cancelled", renderEvidence, attempts });
      } else {
        console.log(`[job ${jobId}] terminó con error:`, err.message ?? err);
        writeStatus(jobId, { status: "error", error: String(err.message ?? err), renderEvidence, attempts });
      }
    })
    .finally(() => {
      cancelledJobIds.delete(jobId);
      active -= 1;
      processQueue();
    });
};

const enqueue = (jobId) => {
  writeStatus(jobId, { status: "queued", createdAt: new Date().toISOString() });
  queue.push(jobId);
  processQueue();
};

/**
 * Borra entradas y salidas de trabajos ya terminados (done/error) más
 * viejos que RETENTION_DAYS. Nunca toca un trabajo en cola o en proceso.
 */
const cleanupOldFiles = async () => {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let deleted = 0;

  for (const [jobId, status] of jobs.entries()) {
    if (status.status !== "done" && status.status !== "error") continue;
    const updatedAt = Date.parse(status.updatedAt ?? "") || 0;
    if (updatedAt > cutoff) continue;

    for (const file of [
      path.join(OUTPUTS_DIR, `${jobId}.mp4`),
      path.join(UPLOADS_VIDEOS_DIR, `${jobId}.mp4`),
      // Huérfanos posibles si el servicio se reinició a mitad de una
      // conversión HEVC->H.264 (ver normalizeVideoCodec): el archivo
      // original pendiente de convertir, y el archivo de salida a
      // medio escribir. recoverJobsFromDisk() ya marca el job como
      // "error" en ese caso -- esto solo limpia los archivos.
      path.join(UPLOADS_VIDEOS_DIR, `${jobId}.source.mp4`),
      path.join(UPLOADS_VIDEOS_DIR, `${jobId}.mp4.converting.mp4`),
      path.join(UPLOADS_VIDEOS_DIR, `${jobId}.mp4.part`),
      jobFilePath(jobId),
      statusFilePath(jobId),
    ]) {
      try {
        await fsp.unlink(file);
        deleted += 1;
      } catch {
        // Puede no existir (p.ej. input.type no era recorded-video); se ignora.
      }
    }
    jobs.delete(jobId);
    statusWriter.forget(jobId);
  }

  if (deleted > 0) {
    console.log(`Limpieza automática: ${deleted} archivo(s) de trabajos de hace más de ${RETENTION_DAYS} días.`);
  }
};

const app = express();
app.use(express.json({ limit: "2mb" }));

const upload = multer({
  dest: "/tmp/fabrica-videos-uploads",
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    fieldSize: 5 * 1024 * 1024,
  },
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, active, queued: queue.length });
});

app.post("/jobs", upload.single("video"), async (req, res) => {
  const jobId = crypto.randomUUID();

  try {
    // Dos formas de llamar a este endpoint:
    //  - multipart/form-data con el archivo en "video" y el job (JSON) en
    //    el campo de texto "job" (subida directa, como hasta ahora).
    //  - application/json con el job completo como cuerpo, e
    //    `input.driveFileId` en vez de un archivo (lo descarga el motor).
    const job = req.is("application/json") ? req.body : JSON.parse(req.body.job ?? "null");

    if (!job || !job.channel || !job.destination || !job.input || !job.input.type) {
      await fsp.unlink(req.file?.path ?? "").catch(() => {});
      return res.status(400).json({
        error: "El job debe traer channel, destination e input.type.",
      });
    }

    if (job.input.type === "recorded-video") {
      if (req.file) {
        const info = await probeVideoInfo(req.file.path).catch((probeErr) => {
          throw new Error(`No se pudo verificar el video subido: ${probeErr.message}`);
        });

        if (ALLOWED_VIDEO_CODECS.has(info.codec)) {
          const videoDest = path.join(UPLOADS_VIDEOS_DIR, `${jobId}.mp4`);
          await safeRename(req.file.path, videoDest);
          job.input.baseVideo = `uploads/videos/${jobId}.mp4`;
          job.input.durationInSeconds = info.durationSeconds;
        } else if (isAutoConvertibleCodec(info.codec)) {
          // HEVC/H.265 (típico de iPhone): se acepta igual, pero la
          // conversión a H.264 puede tardar minutos en un video largo
          // -- no se hace acá (bloquearía esta respuesta HTTP), pasa en
          // la cola (resolveJobInput/normalizeVideoCodec), igual que ya
          // pasa con la descarga de Drive. Solo se deja el archivo en
          // su ubicación definitiva, pendiente de normalizar.
          const pendingFileName = `${jobId}.source.mp4`;
          await safeRename(req.file.path, path.join(UPLOADS_VIDEOS_DIR, pendingFileName));
          job.input.pendingVideoFile = pendingFileName;
        } else {
          await fsp.unlink(req.file.path).catch(() => {});
          return res.status(422).json({
            error: `Códec de video "${info.codec}" no soportado. H.264/VP8/VP9/AV1 se aceptan directamente; HEVC/H.265 (típico de iPhone) se convierte automáticamente. Este códec no es ninguno de esos -- convierte el video antes de subirlo.`,
          });
        }
      } else if (!job.input.driveFileId) {
        return res.status(400).json({
          error:
            'input.type es "recorded-video": falta el archivo "video" (subida directa) o "input.driveFileId" (Drive).',
        });
      }
      // Si vino driveFileId, o si el archivo subido necesita conversión
      // de códec, el trabajo pesado pasa en la cola (resolveJobInput),
      // no aquí — así el POST responde al instante aunque el archivo
      // pese GBs o la conversión tarde minutos.
    }

    await fsp.writeFile(jobFilePath(jobId), JSON.stringify(job, null, 2));

    enqueue(jobId);
    res.status(202).json({ jobId });
  } catch (err) {
    await fsp.unlink(req.file?.path ?? "").catch(() => {});
    res.status(500).json({ error: String(err.message ?? err) });
  }
});

/** Lista todos los jobs conocidos (los que sobrevivieron la limpieza automática), más recientes primero. */
app.get("/jobs", (req, res) => {
  const all = [...jobs.entries()]
    .map(([jobId, status]) => ({ jobId, ...status }))
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  res.json(all);
});

/**
 * Además del estado en memoria, incluye `resources`/`pendingResources`
 * del job guardado en disco (01-nov-2026, pedido para poder revisar un
 * job sin acceso al disco del VPS) -- de solo lectura, no llama a
 * ningún modelo, no persiste ni modifica nada. Si el archivo del job no
 * existe (ya limpiado, o el job nunca llegó a escribirse), simplemente
 * se omiten esos dos campos -- nunca falla la respuesta por eso.
 */
app.get("/jobs/:id", async (req, res) => {
  const status = jobs.get(req.params.id);
  if (!status) {
    return res.status(404).json({ error: "jobId desconocido." });
  }
  let resources;
  let pendingResources;
  try {
    const job = JSON.parse(await fsp.readFile(jobFilePath(req.params.id), "utf8"));
    resources = job.resources;
    pendingResources = job.pendingResources;
  } catch {
    // Sin archivo de job en disco (todavía no se escribió, o ya se
    // limpió) -- se responde igual, solo sin estos dos campos.
  }
  res.json({ jobId: req.params.id, ...status, resources, pendingResources });
});

/**
 * Verifica (ffprobe) y sube a Drive (si está configurado) el MP4 de un
 * job, aunque ya haya terminado hace rato -- para un job que corrió
 * antes de que existiera esto, o si la subida falló y se quiere
 * reintentar. Solo necesita que el ARCHIVO exista en disco, no que el
 * status diga "done" (ver finalizeJobOutput).
 */
app.post("/jobs/:id/finalize", async (req, res) => {
  const jobId = req.params.id;
  if (!fs.existsSync(path.join(OUTPUTS_DIR, `${jobId}.mp4`))) {
    return res.status(404).json({ error: "No hay un MP4 de salida en disco para este job." });
  }
  try {
    const updated = await finalizeJobOutput(jobId);
    res.json({ jobId, ...updated });
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
});

/**
 * Vuelve a pedirle un plan de edición a la IA editorial para un job que
 * YA tiene su transcripción guardada -- sin re-transcribir ni renderizar
 * nada. Pensado para probar un cambio en el prompt/modelo contra una
 * transcripción real sin gastar una corrida completa: no escribe nada en
 * el job ni en su estado, solo devuelve el plan. No usa `job.cuts`/
 * `job.zooms` existentes como atajo -- siempre llama al modelo.
 */
app.post("/jobs/:id/replan", async (req, res) => {
  const jobId = req.params.id;
  let job;
  try {
    job = JSON.parse(await fsp.readFile(jobFilePath(jobId), "utf8"));
  } catch {
    return res.status(404).json({ error: "jobId desconocido (sin archivo de job en disco)." });
  }
  if (!Array.isArray(job.captions) || job.captions.length === 0) {
    return res.status(409).json({ error: "Este job no tiene transcripción guardada todavía." });
  }

  // El layout a usar: el que venga en el body de esta llamada (para
  // comparar perfiles sin tocar el job guardado), si no el que ya traía
  // el job guardado, si no ninguno (guía base del canal).
  const layout = (req.is("application/json") && req.body?.layout) || job.layout;
  const { guidelines, resourceProfile, correctionsHistory } = await loadChannelEditorialContext(
    PROJECT_ROOT,
    job.channel,
    layout,
  );
  if (!guidelines) {
    return res.status(409).json({ error: `Sin guía editorial para el canal "${job.channel}"${layout ? ` (layout "${layout}")` : ""}.` });
  }

  try {
    const plan = await planEdit({
      captions: job.captions,
      transcriptWords: job.transcriptWords,
      guidelines,
      resourceProfile,
      correctionsHistory,
      durationInSeconds: job.input.durationInSeconds,
      destination: job.destination,
      layout,
      onLog: (msg) => console.log(`[replan ${jobId}] ${msg}`),
    });

    // Mismo post-procesamiento que el flujo normal (fusión de cortes
    // casi contiguos + CTA que nunca desaparecen en silencio) -- para
    // que /replan refleje la línea temporal FINAL, no el plan crudo del
    // modelo. No se persiste nada del job -- es solo para revisar.
    const { cuts: mergedCuts, mergeLog } = mergeNearbyGaplessCuts(plan.cuts, job.transcriptWords);
    for (const line of mergeLog) {
      console.log(`[replan ${jobId}]   ${line}`);
    }
    const { cuts: snappedCuts, cutIssues: snapCutIssues } = snapCutsToWordBoundaries(mergedCuts, job.transcriptWords);
    for (const issue of snapCutIssues) {
      console.log(`[replan ${jobId}]   ${issue}`);
    }
    let acousticCuts = snappedCuts;
    let acousticCutIssues = [];
    let qualityGate = null;
    // Medido con un cronómetro en el proceso (dictamen 31-oct-2026, "tiempo
    // adicional real del mecanismo") -- cubre mapa de pausas reales +
    // refineCutsWithRealSilence + puerta de calidad, sin incluir la
    // llamada al modelo (medida aparte en plan.metrics.elapsedMs).
    const audioMechanismStartedAt = Date.now();
    if (typeof job.input.baseVideo === "string") {
      const videoPath = path.join(PROJECT_ROOT, "public", job.input.baseVideo);
      const ffmpegPathForAudio = resolveFfmpeg();
      const ffmpegEnvForAudio = binaryEnv(ffmpegPathForAudio);
      ({ cuts: acousticCuts, cutIssues: acousticCutIssues } = await refineCutsWithRealSilence({
        cuts: snappedCuts,
        videoPath,
        videoDurationSeconds: job.input.durationInSeconds,
        ffmpegPath: ffmpegPathForAudio,
        ffmpegEnv: ffmpegEnvForAudio,
        log: (msg) => console.log(`[replan ${jobId}]   ${msg}`),
      }));

      // Mismo gate que correría el render real -- en /replan es solo
      // diagnóstico (no persiste nada), para que el operador vea el
      // resultado ANTES de autorizar la única replanificación real
      // (sección 7 del dictamen, ~US$0.30).
      const gateResult = await runQualityGateWithRemediation({
        ffmpegPath: ffmpegPathForAudio,
        ffmpegEnv: ffmpegEnvForAudio,
        videoPath,
        cuts: acousticCuts,
        videoDurationSeconds: job.input.durationInSeconds,
        log: (msg) => console.log(`[replan ${jobId}]   ${msg}`),
      });
      acousticCuts = gateResult.cuts;
      qualityGate = { ok: gateResult.ok, rounds: gateResult.rounds, incidents: gateResult.incidents, stoppedReason: gateResult.stoppedReason ?? null };
    }
    const audioMechanismElapsedMs = Date.now() - audioMechanismStartedAt;
    console.log(`[replan ${jobId}] mecanismo de audio (mapa de pausas + puerta de calidad): ${(audioMechanismElapsedMs / 1000).toFixed(1)}s.`);
    for (const issue of acousticCutIssues) {
      console.log(`[replan ${jobId}]   ${issue}`);
    }
    const timeline = buildTimeline(job.input.durationInSeconds, acousticCuts);
    const { resources, droppedCount, ctaIssues } = remapResourcesWithCtaGuarantee({
      resources: plan.resources,
      timeline,
      log: (msg) => console.log(`[replan ${jobId}]   ${msg}`),
      existingCtaIssues: plan.ctaIssues,
    });
    if (ctaIssues.length > 0) {
      console.log(`[replan ${jobId}] *** ${ctaIssues.length} PROBLEMA(S) CON LOS CTA OBLIGATORIOS ***`);
      for (const issue of ctaIssues) {
        console.log(`[replan ${jobId}]   ${issue}`);
      }
    }
    for (const r of resources) {
      if (r.ctaPosition) {
        console.log(
          `[replan ${jobId}]   CTA "${r.ctaPosition}" en ${r.editedSeconds}s (${r.editedPercent}% de la duración editada): ${r.description}`,
        );
      }
    }
    const pendingResources = computePendingResources(resources, (msg) => console.log(`[replan ${jobId}] ${msg}`));

    res.json({
      jobId,
      layout: layout ?? null,
      ...plan,
      cuts: acousticCuts,
      cutIssues: [...plan.cutIssues, ...snapCutIssues, ...acousticCutIssues],
      qualityGate,
      audioMechanismElapsedMs,
      resources,
      ctaIssues,
      pendingResources,
      editedDurationInSeconds: Number(timeline.outputDurationInSeconds.toFixed(2)),
      resourcesDroppedByCuts: droppedCount,
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
});

/**
 * Diagnóstico de solo lectura: corre snapCutsToWordBoundaries() sobre
 * cortes que manda quien llama (NO job.cuts -- el job puede ser de
 * antes de que existiera esta corrección, o quien llama puede estar
 * probando valores que todavía no se persistieron), usando las
 * transcriptWords YA guardadas del job. No llama al modelo, no cuesta
 * nada, no persiste ni modifica el job -- existe para poder ver
 * exactamente qué palabra cae en cada borde sin tener que exponer el
 * array completo de transcriptWords (puede ser enorme) por otro canal.
 *
 * Precisión B del operador sobre el resultado real en el VPS
 * (30-oct-2026): si el job tiene un video real en disco
 * (`input.baseVideo`), además corre `silencedetect` real de FFmpeg
 * alrededor de cada borde -- devuelve las pausas reales detectadas en
 * +-3s y las compara contra el límite "seguro por palabra" de Whisper
 * (para medir el desfase), más si esa pausa caería dentro de la
 * ventana que de verdad usa producción (+-1s). Sigue sin llamar al
 * modelo, sin costo, sin persistir ni modificar nada.
 */
app.post("/jobs/:id/snap-cuts", async (req, res) => {
  const jobId = req.params.id;
  let job;
  try {
    job = JSON.parse(await fsp.readFile(jobFilePath(jobId), "utf8"));
  } catch {
    return res.status(404).json({ error: "jobId desconocido (sin archivo de job en disco)." });
  }
  if (!Array.isArray(job.transcriptWords) || job.transcriptWords.length === 0) {
    return res.status(409).json({
      error:
        'Este job no tiene "transcriptWords" guardadas -- puede ser que se transcribió con una versión anterior que no las guardaba (solo "captions" agrupadas por línea). No se puede ajustar cortes a límites de palabra sin esto; haría falta regenerar la transcripción.',
    });
  }

  const cuts = req.body?.cuts;
  if (!Array.isArray(cuts) || cuts.length === 0) {
    return res.status(400).json({ error: 'Body inválido: se espera {"cuts": [{"id", "startSeconds", "endSeconds"}, ...]}.' });
  }
  for (const cut of cuts) {
    if (!cut || typeof cut.id !== "string" || !Number.isFinite(cut.startSeconds) || !Number.isFinite(cut.endSeconds)) {
      return res.status(400).json({ error: `Corte inválido: cada elemento necesita "id" (string), "startSeconds" y "endSeconds" (number). Recibido: ${JSON.stringify(cut)}` });
    }
  }

  const { adjustedCuts, cutIssues, wordsNearEdges } = buildSnapCutsDiagnostic(cuts, job.transcriptWords);

  let acousticNote = null;
  // finalCuts: los cortes EFECTIVOS que de verdad usaría producción --
  // corte por la MISMA función que usan planEditIfNeeded/POST /replan
  // (refineCutsWithRealSilence), nunca una reimplementación aparte
  // para este diagnóstico (pedido explícito del operador).
  let finalCuts = adjustedCuts;
  let allDiscardReasons = [...cutIssues];
  let qualityGate = null;
  // Mide el mismo mecanismo que /replan y planEditIfNeeded (mapa de
  // pausas + puerta de calidad) SIN llamar al modelo y sin renderizar --
  // este endpoint ya era gratis; ahora además reporta el tiempo exacto,
  // útil para medirlo sin ningún gasto nuevo (dictamen 31-oct-2026).
  const audioMechanismStartedAt = Date.now();
  let audioMechanismElapsedMs = null;
  if (typeof job.input.baseVideo !== "string") {
    acousticNote = 'Este job no tiene "input.baseVideo" (sin video real en disco) -- se omite el análisis de audio real, solo se devuelve el diagnóstico por palabra.';
  } else {
    const videoPath = path.join(PROJECT_ROOT, "public", job.input.baseVideo);
    const ffmpegPathForAudio = resolveFfmpeg();
    const ffmpegEnvForAudio = binaryEnv(ffmpegPathForAudio);

    const finalResult = await refineCutsWithRealSilence({
      cuts: adjustedCuts,
      videoPath,
      videoDurationSeconds: job.input.durationInSeconds,
      ffmpegPath: ffmpegPathForAudio,
      ffmpegEnv: ffmpegEnvForAudio,
    });
    allDiscardReasons = [...allDiscardReasons, ...finalResult.cutIssues];

    // Puerta de calidad sobre los cortes finales -- mismo mecanismo que
    // correría el render real, para que este diagnóstico de solo
    // lectura muestre también si el empalme resultante pasaría la
    // verificación automática (o qué corrección/descarte aplicaría).
    if (finalResult.cuts.length > 0) {
      const gateResult = await runQualityGateWithRemediation({
        ffmpegPath: ffmpegPathForAudio,
        ffmpegEnv: ffmpegEnvForAudio,
        videoPath,
        cuts: finalResult.cuts,
        videoDurationSeconds: job.input.durationInSeconds,
      });
      finalCuts = gateResult.cuts;
      qualityGate = { ok: gateResult.ok, rounds: gateResult.rounds, incidents: gateResult.incidents, stoppedReason: gateResult.stoppedReason ?? null };
      allDiscardReasons = [...allDiscardReasons, ...gateResult.incidents];
    } else {
      finalCuts = finalResult.cuts;
    }

    // Mapa de pausas reales calculado UNA SOLA VEZ por refineCutsWithRealSilence
    // -- se reutiliza acá para el contexto por borde (+-3s), en vez de
    // volver a invocar FFmpeg para cada uno (antes: 1 llamada por
    // borde; ahora: 0, ya está calculado).
    for (const edge of wordsNearEdges) {
      if (edge.discarded) {
        edge.silenceAnalysis = null;
        continue;
      }
      if (!finalResult.pauseMap) {
        edge.silenceAnalysis = { error: "no se pudo calcular el mapa de pausas reales para este video (ver acousticNote / cutIssues)." };
        continue;
      }
      const candidates = rankPauseCandidates(finalResult.pauseMap.intervals, edge.adjustedSeconds).filter(
        (c) => c.distanceSeconds <= SILENCE_WIDE_REPORT_RADIUS_SECONDS,
      );
      const nearest = candidates[0] ?? null;
      edge.silenceAnalysis = {
        realPausesWithin3s: candidates.map((c) => ({ start: Number(c.interval.start.toFixed(3)), end: Number(c.interval.end.toFixed(3)) })),
        nearestRealPauseSeconds: nearest ? Number(nearest.chosenSeconds.toFixed(3)) : null,
        // Si esa pausa caería dentro de la ventana que de verdad usa
        // producción (+-1s) -- si no, producción descartaría este
        // corte en vez de usarla (precisión A del operador). El
        // mismo dato ya queda reflejado en finalCuts/discardedCuts
        // arriba (vía la función real) -- esto es solo contexto por
        // borde.
        wouldUseInProduction: Boolean(nearest && nearest.distanceSeconds <= SILENCE_SEARCH_RADIUS_SECONDS),
        // Distancia (con signo) desde el límite "seguro por palabra"
        // hasta el CENTRO de la pausa real más cercana dentro de
        // +-3s -- NO es una medición del desfase de Whisper: si no
        // hay ninguna pausa real cerca, esto queda en null y no dice
        // nada sobre si Whisper está o no desfasado en ese punto.
        distanceToNearestRealPauseSeconds: nearest ? Number((nearest.chosenSeconds - edge.adjustedSeconds).toFixed(3)) : null,
      };
    }

    audioMechanismElapsedMs = Date.now() - audioMechanismStartedAt;
  }

  // Todo corte pedido que no sobrevivió en finalCuts queda identificado
  // acá con su motivo -- nunca debería desaparecer sin aparecer en
  // ninguno de los dos arrays (ni finalCuts ni discardedCuts).
  const survivingIds = new Set(finalCuts.map((c) => c.id));
  const discardedCuts = cuts
    .filter((c) => !survivingIds.has(c.id))
    .map((c) => ({
      cutId: c.id,
      reason: allDiscardReasons.find((r) => r.includes(`"${c.id}"`)) ?? "descartado -- motivo no encontrado en los registros, revisar manualmente.",
    }));

  res.json({
    jobId,
    originalCuts: cuts,
    adjustedCuts,
    cutIssues,
    wordsNearEdges,
    finalCuts,
    discardedCuts,
    acousticNote,
    qualityGate,
    audioMechanismElapsedMs,
  });
});

/**
 * Cancela un trabajo. Si todavía está en cola (no empezó), lo saca y ya
 * — no corrió nada. Si está en curso, mata el proceso de render si lo
 * hay y pide a las demás etapas (descarga/transcripción/plan editorial)
 * que aborten en su próximo punto de chequeo; el estado final queda en
 * "cancelled" cuando la etapa en curso efectivamente se detiene (no es
 * instantáneo salvo que esté en cola o rendering).
 */
app.post("/jobs/:id/cancel", (req, res) => {
  const jobId = req.params.id;
  const status = jobs.get(jobId);
  if (!status) {
    return res.status(404).json({ error: "jobId desconocido." });
  }
  if (["done", "error", "cancelled"].includes(status.status)) {
    return res.status(409).json({ error: `El trabajo ya está en estado "${status.status}", no se puede cancelar.` });
  }

  const queueIndex = queue.indexOf(jobId);
  if (queueIndex !== -1) {
    queue.splice(queueIndex, 1);
    const next = writeStatus(jobId, { status: "cancelled" });
    console.log(`[job ${jobId}] cancelado (estaba en cola, no había empezado).`);
    return res.json({ jobId, ...next });
  }

  cancelledJobIds.add(jobId);
  const child = runningChildren.get(jobId);
  if (child) {
    // Corrección 08-nov-2026 (criterio 2): mismo mecanismo que el
    // vigilante de atasco y el timeout -- termina TODO el grupo de
    // procesos (npx + Remotion + Chrome), no solo el proceso directo.
    killProcessGroup(child, "SIGTERM");
    setTimeout(() => killProcessGroup(child, "SIGKILL"), 10_000);
  }
  const next = writeStatus(jobId, { status: "cancelling" });
  console.log(`[job ${jobId}] cancelación pedida (en curso: ${status.status}).`);
  res.json({ jobId, ...next });
});

/**
 * Reintenta un job que falló o se canceló -- SIN repetir transcripción,
 * plan editorial ni adquisición de recursos que ya estén en el
 * job.json persistido (ver server/job-retry.mjs para la causa raíz: el
 * pipeline ya es idempotente por construcción, esto solo lo expone
 * como endpoint y lo deja visible en el log). Si el archivo del job o
 * el video base ya no existen (p.ej. la limpieza automática de
 * RETENTION_DAYS ya corrió), rechaza con un error claro en vez de
 * encolar un job roto -- no hay nada que recuperar en ese caso, hay
 * que volver a subir el video.
 */
app.post("/jobs/:id/retry", async (req, res) => {
  const jobId = req.params.id;
  const status = jobs.get(jobId);
  const retryCheck = canRetryJob(status);
  if (!retryCheck.ok) {
    return res.status(status ? 409 : 404).json({ error: retryCheck.reason });
  }

  const fileCheck = await readJobFileForRetry(jobFilePath(jobId), RETENTION_DAYS);
  if (!fileCheck.ok) {
    return res.status(409).json({ error: fileCheck.reason });
  }
  const job = fileCheck.job;

  if (job.input?.type === "recorded-video" && job.input.baseVideo) {
    const videoCheck = await checkBaseVideoExists(path.join(PROJECT_ROOT, "public", job.input.baseVideo), RETENTION_DAYS);
    if (!videoCheck.ok) {
      return res.status(409).json({ error: videoCheck.reason });
    }
  }

  const plan = describeRetryPlan(job);
  console.log(`[job ${jobId}] reintento pedido -- plan de recuperación:`);
  for (const step of plan) {
    console.log(`[job ${jobId}]   ${step.skipped ? "SE OMITE" : "SE REPITE"} -- ${step.name}: ${step.detail}`);
  }

  // A diferencia de enqueue() (jobs nuevos), nunca se pisa createdAt --
  // es el mismo job de antes, no uno nuevo. Tampoco queda el `error`
  // viejo colgado junto al estado "queued" nuevo.
  cancelledJobIds.delete(jobId);
  const next = writeStatus(jobId, { status: "queued", error: undefined, renderProgress: undefined });
  queue.push(jobId);
  processQueue();
  console.log(`[job ${jobId}] reencolado para reintentar.`);
  res.json({ jobId, ...next });
});

/**
 * Puerta G0 (reducir el tiempo de render, 11-nov-2026, autorizado por
 * Alex): sobre el job.json YA persistido de un job existente, cuenta
 * cuántos cuadros de SALIDA son "planos" (solo video base) frente a
 * "compuestos" (con zoom, overlay, recurso o subtítulo quemado), sin
 * renderizar NADA -- ni un cuadro, ni una llamada a FFmpeg/Chrome. Es
 * el dato que decide si vale la pena el render selectivo. Nunca toca
 * el estado del job, nunca compite con un render real -- es solo
 * lectura + aritmética sobre lo ya persistido.
 */
app.get("/jobs/:id/segment-plan", async (req, res) => {
  const jobId = req.params.id;
  const fileCheck = await readJobFileForRetry(jobFilePath(jobId), RETENTION_DAYS);
  if (!fileCheck.ok) {
    return res.status(404).json({ error: fileCheck.reason });
  }
  const plan = planSegments(fileCheck.job);
  res.json({ jobId, ...plan });
});

/**
 * Render de DIAGNÓSTICO (causa raíz con evidencia del VPS, 09-nov-2026,
 * autorizado por Alex, criterio 3) -- sobre el video base y el
 * job.json YA persistidos de un job existente, corre un render MUY
 * corto (los primeros cuadros y una ventana en el medio del video, ver
 * render-diagnose.mjs) con registro detallado de Remotion/Chrome
 * activado SOLO en este modo. Nunca toca el estado del job real
 * (nunca llama a `writeStatus`), nunca escribe en `OUTPUTS_DIR`, y
 * nunca llama a ninguna API de pago -- sin costo. No corre si hay un
 * render real en curso (de este job o de cualquier otro -- compite por
 * CPU con él y contaminaría la medición de actividad).
 */
app.post("/jobs/:id/diagnose", async (req, res) => {
  const jobId = req.params.id;
  if (active > 0 || runningChildren.has(jobId)) {
    return res.status(409).json({
      error: "Hay un render real en curso -- el diagnóstico no corre junto a un render real (competiría por CPU y contaminaría la medición de actividad).",
    });
  }

  const fileCheck = await readJobFileForRetry(jobFilePath(jobId), RETENTION_DAYS);
  if (!fileCheck.ok) {
    return res.status(404).json({ error: fileCheck.reason });
  }
  const job = fileCheck.job;

  if (job.input?.type !== "recorded-video" || !job.input.baseVideo) {
    return res.status(409).json({ error: "El job no tiene un video base grabado -- no hay nada que diagnosticar." });
  }
  const baseVideoAbsolutePath = path.join(PROJECT_ROOT, "public", job.input.baseVideo);
  const videoCheck = await checkBaseVideoExists(baseVideoAbsolutePath, RETENTION_DAYS);
  if (!videoCheck.ok) {
    return res.status(409).json({ error: videoCheck.reason });
  }

  let sourceVideoDiagnosticsLine = null;
  try {
    const ffprobePath = resolveFfprobe();
    const diag = await probeSourceVideoDiagnostics(baseVideoAbsolutePath, { ffprobePath, env: binaryEnv(ffprobePath) });
    sourceVideoDiagnosticsLine = formatSourceVideoDiagnosticsLine(diag);
  } catch (err) {
    sourceVideoDiagnosticsLine = `no se pudo diagnosticar (${err.message ?? err})`;
  }

  const totalFrames = Math.round((job.input.durationInSeconds ?? 0) * ENGINE_FPS);
  // Criterio 1 (reducir el tiempo de render, 11-nov-2026): ventanas de
  // inicio, medio Y final -- no solo inicio+medio -- para medir
  // ms/cuadro real en partes representativas del video, no solo el
  // arranque. `windows` lleva la posición de cada una dentro de la
  // selección combinada, para poder atribuirle a cada una su propio
  // ms/cuadro (ver computeWindowTimings en render-diagnose.mjs).
  const windows = buildDiagnosticWindows(totalFrames);
  const frames = windows.length > 0 ? windows.map((w) => `${w.start}-${w.end}`).join(",") : null;
  if (!frames) {
    return res.status(409).json({ error: `No se pudo determinar cuántos cuadros tiene el job (durationInSeconds=${job.input.durationInSeconds}).` });
  }

  // Criterio 3 (concurrencia medida, no supuesta): el body puede pedir
  // una concurrencia distinta a la de producción SOLO para este
  // diagnóstico -- nunca cambia REMOTION_CONCURRENCY real. Útil para
  // correr el mismo workflow de n8n varias veces, cambiando solo este
  // campo, y comparar cuadros/s medidos a 1/2/3/4.
  const concurrency = req.body?.concurrency ? String(req.body.concurrency) : REMOTION_CONCURRENCY;
  // Opción (c): <Video> de @remotion/media frente a OffthreadVideo,
  // sobre el video REAL del job (no sintético) -- ver
  // src/engine/sources/RecordedVideoSource.tsx. "media" activa la
  // variante; cualquier otro valor (u omitirlo) deja el comportamiento
  // de producción intacto (OffthreadVideo).
  const videoComponent = req.body?.videoComponent === "media" ? "media" : "offthread";
  const renderEnv = videoComponent === "media" ? { ...process.env, REMOTION_VIDEO_COMPONENT: "media" } : process.env;

  const diagnosticsDir = path.join(PROJECT_ROOT, "diagnostics");
  await fsp.mkdir(diagnosticsDir, { recursive: true });
  const outputPath = path.join(diagnosticsDir, `${jobId}-${Date.now()}.mp4`);

  console.log(`[diagnóstico ${jobId}] iniciando -- frames=${frames}, concurrencia=${concurrency}, componente de video=${videoComponent}, video fuente -- ${sourceVideoDiagnosticsLine}`);
  const result = await runDiagnosticRender({
    cwd: PROJECT_ROOT,
    env: renderEnv,
    outputPath,
    propsJobFile: `uploads/jobs/${jobId}.json`,
    concurrency,
    enableMultiprocessOnLinux: ENABLE_MULTIPROCESS_ON_LINUX,
    browserExecutable: REMOTION_BROWSER_EXECUTABLE,
    binariesDirectory: REMOTION_BINARIES_DIRECTORY,
    frames,
    windows,
    timeoutMs: RENDER_DIAGNOSE_TIMEOUT_MINUTES * 60 * 1000,
  });
  console.log(
    `[diagnóstico ${jobId}] terminado -- completed=${result.completed} timedOut=${result.timedOut} ` +
      `huérfanos=${result.descendantProcessesAliveAfterCut ?? "desconocido"} hitos=${JSON.stringify(result.milestones)} ` +
      `ms/cuadro por ventana=${JSON.stringify(result.windowTimings)}`,
  );

  res.json({ jobId, sourceVideoDiagnosticsLine, totalFrames, frames, concurrency, videoComponent, ...result });
});

app.get("/jobs/:id/download", (req, res) => {
  const status = jobs.get(req.params.id);
  if (!status || status.status !== "done") {
    return res.status(409).json({ error: "El trabajo todavía no está listo." });
  }
  const file = path.join(OUTPUTS_DIR, `${req.params.id}.mp4`);
  res.download(file);
});

// Errores de multer (p.ej. archivo más grande que MAX_UPLOAD_BYTES) llegan
// aquí en vez de tumbar el proceso.
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    return res.status(status).json({ error: `Error subiendo el archivo: ${err.message}` });
  }
  res.status(500).json({ error: String(err.message ?? err) });
});

recoverJobsFromDisk();
cleanupOldFiles();
setInterval(cleanupOldFiles, CLEANUP_INTERVAL_HOURS * 60 * 60 * 1000);

/**
 * Se registra una sola vez al arrancar: los binarios que se compilan en el
 * build (whisper.cpp) hornean las instrucciones de CPU del runner de CI, no
 * las de donde terminan corriendo. Esto deja ver en los logs de Portainer
 * qué CPU real tiene el host (los contenedores no virtualizan el set de
 * instrucciones) sin necesitar acceso por terminal al VPS.
 */
const logCpuFeatures = () => {
  try {
    const cpuinfo = fs.readFileSync("/proc/cpuinfo", "utf8");
    const model = cpuinfo.match(/model name\s*:\s*(.+)/)?.[1]?.trim() ?? "?";
    const flags = cpuinfo.match(/^flags\s*:\s*(.+)/m)?.[1] ?? "";
    const has = (flag) => flags.split(" ").includes(flag);
    console.log(`  CPU host -> ${model}`);
    console.log(
      `  instrucciones -> avx=${has("avx")} avx2=${has("avx2")} fma=${has("fma")} f16c=${has("f16c")} avx512f=${has("avx512f")}`,
    );
  } catch {
    // No es Linux (p.ej. probando esto en macOS) — no hay /proc/cpuinfo.
  }
};

app.listen(PORT, () => {
  console.log(`fabrica-videos API escuchando en :${PORT}`);
  console.log(`  imagen (GIT_SHA) -> ${process.env.GIT_SHA ?? "desconocido (variable GIT_SHA no definida -- imagen construida antes de este cambio)"}`);
  console.log(`  uploads/jobs   -> ${UPLOADS_JOBS_DIR}`);
  console.log(`  uploads/videos -> ${UPLOADS_VIDEOS_DIR}`);
  console.log(`  outputs        -> ${OUTPUTS_DIR}`);
  console.log(`  concurrencia de renders (jobs en paralelo) -> ${RENDER_CONCURRENCY}`);
  console.log(`  concurrencia de Remotion (pestañas/hilos DENTRO de un render) -> ${REMOTION_CONCURRENCY}`);
  console.log(`  tope de subida directa -> ${(MAX_UPLOAD_BYTES / 1024 / 1024 / 1024).toFixed(1)} GB`);
  console.log(`  timeout de render -> ${RENDER_TIMEOUT_MINUTES} min`);
  console.log(
    `  vigilante de render trabado -> ${RENDER_STUCK_TIMEOUT_MINUTES} min SIN cuadros nuevos Y SIN actividad de CPU del grupo de procesos ` +
      `(criterio rediseñado 09-nov-2026: si hay actividad de CPU real -- bundling, navegador arrancando, decodificación lenta -- NO corta, aunque no haya cuadros; ` +
      `el timeout total de render sigue siendo el límite absoluto si nunca se puede medir la CPU)`,
  );
  console.log(`  timeout del render de diagnóstico (POST /jobs/:id/diagnose) -> ${RENDER_DIAGNOSE_TIMEOUT_MINUTES} min`);
  console.log(`  retención -> ${RETENTION_DAYS} días (limpieza cada ${CLEANUP_INTERVAL_HOURS}h)`);
  console.log(`  credenciales de Drive -> ${process.env.GOOGLE_APPLICATION_CREDENTIALS ? "configuradas" : "NO configuradas"}`);
  console.log(`  subida del MP4 final a Drive -> ${DRIVE_OUTPUT_FOLDER_ID ? `carpeta ${DRIVE_OUTPUT_FOLDER_ID}` : "NO configurada (se omite)"}`);
  logCpuFeatures();
});
