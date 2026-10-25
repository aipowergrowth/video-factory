import express from "express";
import multer from "multer";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

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
const REMOTION_CONCURRENCY = process.env.REMOTION_CONCURRENCY ?? "2";
const ENABLE_MULTIPROCESS_ON_LINUX =
  (process.env.ENABLE_MULTIPROCESS_ON_LINUX ?? "true") === "true";
// Solo necesarios fuera de Linux (p.ej. probando esto en macOS). En el
// contenedor Linux de producción se dejan sin definir.
const REMOTION_BROWSER_EXECUTABLE = process.env.REMOTION_BROWSER_EXECUTABLE;
const REMOTION_BINARIES_DIRECTORY = process.env.REMOTION_BINARIES_DIRECTORY;

// Códecs de video que el Chromium que usa Remotion decodifica de forma
// fiable. HEVC/H.265 (típico de grabaciones de iPhone) NO funciona — hay
// que convertirlo antes (ver scripts/trim_video.swift o un paso de ffmpeg
// equivalente). Lección aprendida renderizando el primer video real.
const ALLOWED_VIDEO_CODECS = new Set(["h264", "vp8", "vp9", "av1"]);

for (const dir of [UPLOADS_JOBS_DIR, UPLOADS_VIDEOS_DIR, OUTPUTS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const resolveCompositorFfprobe = () => {
  if (REMOTION_BINARIES_DIRECTORY) {
    const bin = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
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
      const bin = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
      return path.join(mod.dir, bin);
    } catch {
      // Paquete no instalado para esta plataforma/arquitectura; probar el siguiente.
    }
  }
  throw new Error("No se encontró ningún @remotion/compositor-* instalado.");
};

const probeVideoCodec = async (filePath) => {
  const ffprobePath = resolveCompositorFfprobe();
  const env =
    process.platform === "darwin"
      ? { ...process.env, DYLD_LIBRARY_PATH: path.dirname(ffprobePath) }
      : process.env;
  const { stdout } = await execFileAsync(
    ffprobePath,
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name",
      "-of",
      "default=nw=1:nk=1",
      filePath,
    ],
    { env },
  );
  return stdout.trim();
};

/**
 * Cola simple de renders: como mucho RENDER_CONCURRENCY trabajos de
 * render a la vez (pensado para 4 CPU / 6 GB — ver docker-stack.yml).
 */
const jobs = new Map(); // jobId -> { status, error, createdAt, updatedAt }
const queue = [];
let active = 0;

const writeStatus = (jobId, patch) => {
  const current = jobs.get(jobId) ?? {};
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  jobs.set(jobId, next);
  return next;
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

    let stderrTail = "";
    child.stderr.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000);
    });

    child.on("exit", (code, signal) => {
      console.log(`[render ${jobId}] proceso hijo salió: code=${code} signal=${signal}`);
      if (code === 0) {
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
      console.log(`[render ${jobId}] error al lanzar el proceso:`, err);
      reject(err);
    });
  });

const processQueue = () => {
  if (active >= RENDER_CONCURRENCY || queue.length === 0) {
    return;
  }
  const jobId = queue.shift();
  active += 1;
  writeStatus(jobId, { status: "rendering" });

  console.log(`[render ${jobId}] iniciando (active=${active})`);

  runRender(jobId)
    .then(() => {
      console.log(`[render ${jobId}] terminado OK`);
      writeStatus(jobId, { status: "done" });
    })
    .catch((err) => {
      console.log(`[render ${jobId}] terminó con error:`, err.message ?? err);
      writeStatus(jobId, { status: "error", error: String(err.message ?? err) });
    })
    .finally(() => {
      active -= 1;
      processQueue();
    });
};

const enqueue = (jobId) => {
  writeStatus(jobId, { status: "queued", createdAt: new Date().toISOString() });
  queue.push(jobId);
  processQueue();
};

const app = express();
const upload = multer({ dest: "/tmp/fabrica-videos-uploads" });

app.get("/health", (_req, res) => {
  res.json({ ok: true, active, queued: queue.length });
});

app.post("/jobs", upload.single("video"), async (req, res) => {
  const jobId = crypto.randomUUID();

  try {
    if (!req.body.job) {
      return res.status(400).json({ error: 'Falta el campo "job" (JSON).' });
    }
    const job = JSON.parse(req.body.job);

    if (!job.channel || !job.destination || !job.input || !job.input.type) {
      return res.status(400).json({
        error: "El job debe traer channel, destination e input.type.",
      });
    }

    if (job.input.type === "recorded-video") {
      if (!req.file) {
        return res.status(400).json({
          error: 'input.type es "recorded-video": falta el archivo "video".',
        });
      }

      let codec;
      try {
        codec = await probeVideoCodec(req.file.path);
      } catch (probeErr) {
        await fsp.unlink(req.file.path).catch(() => {});
        return res.status(500).json({
          error: `No se pudo verificar el códec del video subido: ${probeErr.message}`,
        });
      }
      if (!ALLOWED_VIDEO_CODECS.has(codec)) {
        await fsp.unlink(req.file.path).catch(() => {});
        return res.status(422).json({
          error: `Códec de video "${codec}" no soportado (se necesita H.264/VP8/VP9/AV1, no HEVC/H.265). Convierte el video antes de subirlo.`,
        });
      }

      const videoDest = path.join(UPLOADS_VIDEOS_DIR, `${jobId}.mp4`);
      await fsp.rename(req.file.path, videoDest);
      job.input.baseVideo = `uploads/videos/${jobId}.mp4`;
    }

    const jobFilePath = path.join(UPLOADS_JOBS_DIR, `${jobId}.json`);
    await fsp.writeFile(jobFilePath, JSON.stringify(job, null, 2));

    enqueue(jobId);
    res.status(202).json({ jobId });
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
});

app.get("/jobs/:id", (req, res) => {
  const status = jobs.get(req.params.id);
  if (!status) {
    return res.status(404).json({ error: "jobId desconocido." });
  }
  res.json({ jobId: req.params.id, ...status });
});

app.get("/jobs/:id/download", (req, res) => {
  const status = jobs.get(req.params.id);
  if (!status || status.status !== "done") {
    return res.status(409).json({ error: "El trabajo todavía no está listo." });
  }
  const file = path.join(OUTPUTS_DIR, `${req.params.id}.mp4`);
  res.download(file);
});

app.listen(PORT, () => {
  console.log(`fabrica-videos API escuchando en :${PORT}`);
  console.log(`  uploads/jobs   -> ${UPLOADS_JOBS_DIR}`);
  console.log(`  uploads/videos -> ${UPLOADS_VIDEOS_DIR}`);
  console.log(`  outputs        -> ${OUTPUTS_DIR}`);
  console.log(`  concurrencia de renders -> ${RENDER_CONCURRENCY}`);
});
