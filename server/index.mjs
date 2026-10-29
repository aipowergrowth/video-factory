import express from "express";
import multer from "multer";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { downloadFileWithRetry, uploadFile } from "./drive.mjs";
import { transcribeVideo } from "./transcribe.mjs";
import { planEdit } from "./editorial.mjs";
import { buildTimeline, remapRangeToOutput } from "./timeline.mjs";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT ?? 3001);
const PROJECT_ROOT = process.env.PROJECT_ROOT ?? process.cwd();
const UPLOADS_JOBS_DIR =
  process.env.UPLOADS_JOBS_DIR ?? path.join(PROJECT_ROOT, "public/uploads/jobs");
const UPLOADS_VIDEOS_DIR =
  process.env.UPLOADS_VIDEOS_DIR ??
  path.join(PROJECT_ROOT, "public/uploads/videos");
const OUTPUTS_DIR = process.env.OUTPUTS_DIR ?? "/data/outputs";
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
// Limpieza automática: entradas/salidas terminadas más viejas que esto se
// borran, para no llenar el disco con el uso semanal.
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS ?? 7);
const CLEANUP_INTERVAL_HOURS = Number(
  process.env.CLEANUP_INTERVAL_HOURS ?? 6,
);
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

for (const dir of [UPLOADS_JOBS_DIR, UPLOADS_VIDEOS_DIR, OUTPUTS_DIR]) {
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

const resolveCompositorBinary = (name) => {
  const bin = process.platform === "win32" ? `${name}.exe` : name;
  if (REMOTION_BINARIES_DIRECTORY) {
    return path.join(REMOTION_BINARIES_DIRECTORY, bin);
  }

  const candidates = [
    "@remotion/compositor-linux-x64-gnu",
    "@remotion/compositor-linux-x64-musl",
    "@remotion/compositor-linux-arm64-gnu",
    "@remotion/compositor-linux-arm64-musl",
    "@remotion/compositor-darwin-x64",
    "@remotion/compositor-darwin-arm64",
    "@remotion/compositor-win32-x64-msvc",
  ];
  for (const pkg of candidates) {
    try {
      const mod = require(pkg);
      return path.join(mod.dir, bin);
    } catch {
      // Paquete no instalado para esta plataforma/arquitectura; probar el siguiente.
    }
  }
  throw new Error("No se encontró ningún @remotion/compositor-* instalado.");
};

const resolveCompositorFfprobe = () => resolveCompositorBinary("ffprobe");
const resolveCompositorFfmpeg = () => resolveCompositorBinary("ffmpeg");

/** macOS (solo desarrollo local) necesita esta variable para encontrar
 * los .dylib que viven junto al binario; en Linux no hace falta. */
const binaryEnv = (binaryPath) =>
  process.platform === "darwin"
    ? { ...process.env, DYLD_LIBRARY_PATH: path.dirname(binaryPath) }
    : process.env;

/**
 * Códec del video y su duración real, en una sola pasada de ffprobe. La
 * duración la calcula siempre el servidor (nunca se confía en lo que
 * mande el cliente) — necesario para el flujo de Drive, donde nadie la
 * escribe a mano, y más fiable también para la subida directa.
 */
const probeVideoInfo = async (filePath) => {
  const ffprobePath = resolveCompositorFfprobe();
  const env = binaryEnv(ffprobePath);
  const { stdout } = await execFileAsync(
    ffprobePath,
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,width,height",
      "-show_entries",
      "format=duration",
      "-of",
      "default=nw=1",
      filePath,
    ],
    { env },
  );
  const fields = Object.fromEntries(
    stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const idx = line.indexOf("=");
        return [line.slice(0, idx), line.slice(idx + 1)];
      }),
  );
  return {
    codec: fields.codec_name,
    width: fields.width ? Number(fields.width) : null,
    height: fields.height ? Number(fields.height) : null,
    durationSeconds: fields.duration ? Number(fields.duration) : null,
  };
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

const writeStatus = (jobId, patch) => {
  const current = jobs.get(jobId) ?? {};
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  jobs.set(jobId, next);
  fs.writeFile(statusFilePath(jobId), JSON.stringify(next, null, 2), () => {});
  return next;
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

const runRender = (jobId) =>
  new Promise((resolve, reject) => {
    const jobFile = `uploads/jobs/${jobId}.json`;
    const outputPath = path.join(OUTPUTS_DIR, `${jobId}.mp4`);

    const args = [
      "remotion",
      "render",
      "VideoEngine",
      outputPath,
      `--props=${JSON.stringify({ jobFile })}`,
      `--concurrency=${REMOTION_CONCURRENCY}`,
    ];

    if (ENABLE_MULTIPROCESS_ON_LINUX) {
      args.push("--enable-multiprocess-on-linux");
    }
    if (REMOTION_BROWSER_EXECUTABLE) {
      args.push(`--browser-executable=${REMOTION_BROWSER_EXECUTABLE}`);
    }
    if (REMOTION_BINARIES_DIRECTORY) {
      args.push(`--binaries-directory=${REMOTION_BINARIES_DIRECTORY}`);
    }

    const child = spawn("npx", args, {
      cwd: PROJECT_ROOT,
      env: process.env,
    });
    runningChildren.set(jobId, child);

    let stderrTail = "";
    let timedOut = false;
    child.stderr.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000);
    });

    const timeoutMs = RENDER_TIMEOUT_MINUTES * 60 * 1000;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      console.log(
        `[render ${jobId}] superó ${RENDER_TIMEOUT_MINUTES} min, terminando el proceso.`,
      );
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000);
    }, timeoutMs);

    child.on("exit", (code, signal) => {
      clearTimeout(timeoutTimer);
      runningChildren.delete(jobId);
      console.log(`[render ${jobId}] proceso hijo salió: code=${code} signal=${signal}`);
      if (cancelledJobIds.has(jobId)) {
        reject(new CancelledError(jobId));
      } else if (timedOut) {
        reject(new Error(`El render superó el límite de ${RENDER_TIMEOUT_MINUTES} minutos.`));
      } else if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `remotion render exited with code=${code} signal=${signal}: ${stderrTail}`,
          ),
        );
      }
    });
    child.on("error", (err) => {
      clearTimeout(timeoutTimer);
      runningChildren.delete(jobId);
      console.log(`[render ${jobId}] error al lanzar el proceso:`, err);
      reject(err);
    });
  });

/**
 * Si el trabajo vino con una referencia de Drive (en vez de un archivo ya
 * subido), lo descarga ahora: streaming a disco, con reintentos y
 * verificación de tamaño/MD5. Si ya tiene `baseVideo` (subida directa),
 * no hace nada.
 */
const resolveJobInput = async (jobId, job) => {
  throwIfCancelled(jobId);
  if (job.input.type !== "recorded-video" || job.input.baseVideo) {
    return job;
  }
  if (!job.input.driveFileId) {
    throw new Error(
      'input.type es "recorded-video": falta "baseVideo" (subida directa) o "driveFileId" (Drive).',
    );
  }

  writeStatus(jobId, { status: "downloading" });
  console.log(`[job ${jobId}] descargando de Drive: ${job.input.driveFileId}`);

  const destPath = path.join(UPLOADS_VIDEOS_DIR, `${jobId}.mp4`);
  const partPath = `${destPath}.part`;

  await downloadFileWithRetry(job.input.driveFileId, partPath, {
    maxAttempts: DRIVE_DOWNLOAD_MAX_ATTEMPTS,
    waitMs: DRIVE_DOWNLOAD_WAIT_MS,
  });

  const info = await probeVideoInfo(partPath);
  if (!ALLOWED_VIDEO_CODECS.has(info.codec)) {
    await fsp.unlink(partPath).catch(() => {});
    throw new Error(
      `Códec de video "${info.codec}" no soportado (se necesita H.264/VP8/VP9/AV1, no HEVC/H.265). Convierte el video antes de subirlo a Drive.`,
    );
  }

  await safeRename(partPath, destPath);
  job.input.baseVideo = `uploads/videos/${jobId}.mp4`;
  job.input.durationInSeconds = info.durationSeconds;
  delete job.input.driveFileId;
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

  const ffmpegPath = resolveCompositorFfmpeg();
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
const planEditIfNeeded = async (jobId, job) => {
  throwIfCancelled(jobId);
  if (job.input.type !== "recorded-video") return job;
  if (job.skipEditorialAI) return job;
  if ((job.cuts && job.cuts.length > 0) || (job.zooms && job.zooms.length > 0)) {
    return job;
  }
  if (!Array.isArray(job.captions) || job.captions.length === 0) return job;

  const channelDir = path.join(PROJECT_ROOT, "public/channels", job.channel);
  // Si el canal tiene formatos distintos (p.ej. pantalla compartida vs.
  // cámara en "Alex Cripto y Negocios"), job.layout elige qué guía usar.
  // Sin layout o sin el archivo específico, se usa la de siempre -- un
  // job sin layout se comporta exactamente igual que antes de esto.
  const guidelines =
    (job.layout &&
      (await fsp.readFile(path.join(channelDir, `editorial-guidelines.${job.layout}.md`), "utf8").catch(() => null))) ??
    (await fsp.readFile(path.join(channelDir, "editorial-guidelines.md"), "utf8").catch(() => null));
  if (!guidelines) {
    console.log(
      `[job ${jobId}] sin guía editorial para el canal "${job.channel}" — se omite la IA editorial.`,
    );
    return job;
  }
  // Ambos opcionales: si no existen, planEdit sigue funcionando igual
  // (perfil de recursos sin restricciones extra, sin historial previo).
  const resourceProfile = await fsp
    .readFile(path.join(channelDir, "editorial-profile.json"), "utf8")
    .then(JSON.parse)
    .catch(() => null);
  const correctionsHistory = await fsp
    .readFile(path.join(channelDir, "editorial-corrections.json"), "utf8")
    .then(JSON.parse)
    .catch(() => []);

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

  console.log(
    `[job ${jobId}] plan de edición listo: ${plan.cuts.length} corte(s), ${plan.zooms.length} zoom(s), ` +
      `${(plan.metrics.elapsedMs / 1000).toFixed(1)}s, modelo=${plan.metrics.model}, ` +
      `stop_reason=${plan.metrics.stopReason}, max_tokens=${plan.metrics.maxTokens}, ` +
      `reintentó=${plan.metrics.retried}, tokens=${plan.metrics.inputTokens ?? "?"}in/${plan.metrics.outputTokens ?? "?"}out`,
  );
  if (plan.notes) {
    console.log(`[job ${jobId}] notas del editor IA: ${plan.notes}`);
  }
  for (const cut of plan.cuts) {
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
        `(${resource.editorialGoal}, esencial=${resource.essential}): ${resource.description}`,
    );
  }

  job.cuts = plan.cuts.map(({ id, startSeconds, endSeconds }) => ({ id, startSeconds, endSeconds }));
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
  // cortes aplicados) con el mismo mecanismo que usa el motor para
  // overlays/captions. Si el intervalo de un recurso cae entero dentro de
  // un corte, desaparece (con registro); si un corte lo partió en dos
  // pedazos que sobreviven, se resuelven como dos recursos separados en
  // vez de inventar continuidad entre ellos.
  const timeline = buildTimeline(job.input.durationInSeconds, job.cuts);
  const remappedResources = [];
  let resourcesDroppedByCuts = 0;
  for (const resource of plan.resources) {
    const ranges = remapRangeToOutput(timeline, {
      startSeconds: resource.startSeconds,
      endSeconds: resource.endSeconds,
    });
    if (ranges.length === 0) {
      resourcesDroppedByCuts += 1;
      console.log(
        `[job ${jobId}]   recurso descartado (su intervalo completo cayó dentro de un corte): ${resource.description}`,
      );
      continue;
    }
    ranges.forEach((range, index) => {
      remappedResources.push({
        ...resource,
        id: ranges.length > 1 ? `${resource.id}-${index}` : resource.id,
        startSeconds: range.startSeconds,
        endSeconds: range.endSeconds,
      });
    });
  }
  if (resourcesDroppedByCuts > 0) {
    console.log(`[job ${jobId}] ${resourcesDroppedByCuts} recurso(s) descartado(s) por caer dentro de un corte.`);
  }
  job.resources = remappedResources;

  await fsp.writeFile(jobFilePath(jobId), JSON.stringify(job, null, 2));
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

  return writeStatus(jobId, {
    output: outputInfo ?? undefined,
    drive: driveOutput,
  });
};

const processQueue = () => {
  if (active >= RENDER_CONCURRENCY || queue.length === 0) {
    return;
  }
  const jobId = queue.shift();
  active += 1;

  (async () => {
    console.log(`[job ${jobId}] iniciando (active=${active})`);
    const job = JSON.parse(await fsp.readFile(jobFilePath(jobId), "utf8"));
    await resolveJobInput(jobId, job);
    await transcribeJobIfNeeded(jobId, job);
    await planEditIfNeeded(jobId, job);
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
    await runRender(jobId);
    console.log(`[render ${jobId}] terminado OK`);

    await finalizeJobOutput(jobId);
    writeStatus(jobId, { status: "done" });
  })()
    .catch((err) => {
      if (err instanceof CancelledError) {
        console.log(`[job ${jobId}] cancelado.`);
        writeStatus(jobId, { status: "cancelled" });
      } else {
        console.log(`[job ${jobId}] terminó con error:`, err.message ?? err);
        writeStatus(jobId, { status: "error", error: String(err.message ?? err) });
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
        if (!ALLOWED_VIDEO_CODECS.has(info.codec)) {
          await fsp.unlink(req.file.path).catch(() => {});
          return res.status(422).json({
            error: `Códec de video "${info.codec}" no soportado (se necesita H.264/VP8/VP9/AV1, no HEVC/H.265). Convierte el video antes de subirlo.`,
          });
        }

        const videoDest = path.join(UPLOADS_VIDEOS_DIR, `${jobId}.mp4`);
        await safeRename(req.file.path, videoDest);
        job.input.baseVideo = `uploads/videos/${jobId}.mp4`;
        job.input.durationInSeconds = info.durationSeconds;
      } else if (!job.input.driveFileId) {
        return res.status(400).json({
          error:
            'input.type es "recorded-video": falta el archivo "video" (subida directa) o "input.driveFileId" (Drive).',
        });
      }
      // Si vino driveFileId, la descarga pasa en la cola (resolveJobInput),
      // no aquí — así el POST responde al instante aunque el archivo pese GBs.
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

app.get("/jobs/:id", (req, res) => {
  const status = jobs.get(req.params.id);
  if (!status) {
    return res.status(404).json({ error: "jobId desconocido." });
  }
  res.json({ jobId: req.params.id, ...status });
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

  const guidelinesPath = path.join(
    PROJECT_ROOT,
    "public/channels",
    job.channel,
    "editorial-guidelines.md",
  );
  const guidelines = await fsp.readFile(guidelinesPath, "utf8").catch(() => null);
  if (!guidelines) {
    return res.status(409).json({ error: `Sin guía editorial para el canal "${job.channel}".` });
  }

  try {
    const plan = await planEdit({
      captions: job.captions,
      transcriptWords: job.transcriptWords,
      guidelines,
      durationInSeconds: job.input.durationInSeconds,
      destination: job.destination,
      onLog: (msg) => console.log(`[replan ${jobId}] ${msg}`),
    });
    res.json({ jobId, ...plan });
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
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
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 10_000);
  }
  const next = writeStatus(jobId, { status: "cancelling" });
  console.log(`[job ${jobId}] cancelación pedida (en curso: ${status.status}).`);
  res.json({ jobId, ...next });
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
  console.log(`  uploads/jobs   -> ${UPLOADS_JOBS_DIR}`);
  console.log(`  uploads/videos -> ${UPLOADS_VIDEOS_DIR}`);
  console.log(`  outputs        -> ${OUTPUTS_DIR}`);
  console.log(`  concurrencia de renders -> ${RENDER_CONCURRENCY}`);
  console.log(`  tope de subida directa -> ${(MAX_UPLOAD_BYTES / 1024 / 1024 / 1024).toFixed(1)} GB`);
  console.log(`  timeout de render -> ${RENDER_TIMEOUT_MINUTES} min`);
  console.log(`  retención -> ${RETENTION_DAYS} días (limpieza cada ${CLEANUP_INTERVAL_HOURS}h)`);
  console.log(`  credenciales de Drive -> ${process.env.GOOGLE_APPLICATION_CREDENTIALS ? "configuradas" : "NO configuradas"}`);
  console.log(`  subida del MP4 final a Drive -> ${DRIVE_OUTPUT_FOLDER_ID ? `carpeta ${DRIVE_OUTPUT_FOLDER_ID}` : "NO configurada (se omite)"}`);
  logCpuFeatures();
});
