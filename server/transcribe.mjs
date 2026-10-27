// Transcripción automática en el servidor (Etapa 1). Reutiliza exactamente
// la misma librería y el mismo whisper.cpp que ya usábamos a mano en local
// (scripts/transcribe.mjs) — aquí solo cambia que whisper.cpp ya viene
// compilado en la imagen (ver Dockerfile) en vez de instalarse al vuelo, y
// que el resultado se agrupa con server/captions.mjs en vez del script CLI.
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { transcribe, toCaptions } from "@remotion/install-whisper-cpp";
import { groupCaptions } from "./captions.mjs";

const execFileAsync = promisify(execFile);

const WHISPER_VERSION = "1.5.5";

/** Lectura best-effort de la memoria usada por el contenedor (cgroup v2).
 * No existe en macOS (desarrollo local) — ahí simplemente no se reporta. */
const readContainerMemoryBytes = async () => {
  try {
    const raw = await fs.readFile("/sys/fs/cgroup/memory.current", "utf8");
    return Number(raw.trim());
  } catch {
    return null;
  }
};

const extractAudioToWav = async (ffmpegPath, videoPath, wavPath, env) => {
  await execFileAsync(
    ffmpegPath,
    ["-y", "-i", videoPath, "-vn", "-ar", "16000", "-ac", "1", "-f", "wav", wavPath],
    { env, maxBuffer: 1024 * 1024 * 64 },
  );
};

/**
 * Transcribe el audio de un video y devuelve líneas de subtítulo ya
 * agrupadas y con las correcciones del canal aplicadas. Mide tiempo y
 * memoria del contenedor antes/después (Etapa 1 lo pide explícitamente).
 */
export const transcribeVideo = async ({
  videoPath,
  corrections,
  ffmpegPath,
  ffmpegEnv,
  whisperDir,
  model,
  onLog = () => {},
}) => {
  const startedAt = Date.now();
  const memBefore = await readContainerMemoryBytes();

  const tmpWav = path.join(os.tmpdir(), `transcribe-${crypto.randomUUID()}.wav`);
  try {
    onLog("extrayendo audio...");
    await extractAudioToWav(ffmpegPath, videoPath, tmpWav, ffmpegEnv);

    onLog(`transcribiendo con whisper.cpp (modelo "${model}")...`);
    const whisperOutput = await transcribe({
      model,
      whisperPath: whisperDir,
      whisperCppVersion: WHISPER_VERSION,
      inputPath: tmpWav,
      tokenLevelTimestamps: true,
      translateToEnglish: false,
      language: "auto",
    });

    const memDuring = await readContainerMemoryBytes();
    const { captions: words } = toCaptions({ whisperCppOutput: whisperOutput });
    const lines = groupCaptions(words, corrections);

    const elapsedMs = Date.now() - startedAt;
    const memAfter = await readContainerMemoryBytes();

    return {
      captions: lines,
      detectedLanguage: whisperOutput?.result?.language ?? null,
      metrics: {
        elapsedMs,
        wordCount: words.length,
        lineCount: lines.length,
        containerMemoryBytes: { before: memBefore, duringOrAfter: memDuring ?? memAfter },
      },
    };
  } finally {
    await fs.unlink(tmpWav).catch(() => {});
  }
};
