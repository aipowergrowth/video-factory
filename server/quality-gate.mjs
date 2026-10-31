// Puerta automática de calidad del audio (dictamen de solución
// estructural, 31-oct-2026, sección 4): antes de confiar en los cortes
// que producción va a aplicar, construye la pista de audio EDITADA
// (con esos cortes ya aplicados, no el video completo) y la verifica:
// duración esperada, sin discontinuidades/silencios anormales, sin
// defectos acústicos evidentes en cada empalme. Si un empalme falla,
// intenta la siguiente pausa candidata dentro del límite ya permitido
// (misma fuente que usó refineCutsWithRealSilence); si no hay ninguna,
// descarta ese corte y conserva el audio original -- nunca al revés.
//
// Complementa (no reemplaza) a audio-analysis.mjs: ese módulo decide
// DÓNDE puede cortarse de forma segura (silencedetect sobre el video
// ORIGINAL); este módulo verifica que la pista YA CORTADA, una vez
// armada, de verdad suena bien (análisis de energía por cuadro sobre
// un WAV PCM real) -- son preguntas distintas, no una reimplementación
// paralela de la misma búsqueda de pausas.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildTimeline } from "./timeline.mjs";

const execFileAsync = promisify(execFile);

/**
 * Parsea un buffer WAV leyendo sus chunks reales (no asume una cabecera
 * fija de 44 bytes) -- un WAV puede traer chunks extra antes de "data",
 * y el tamaño que declara el chunk "data" no siempre es confiable (hay
 * encoders que escriben 0xFFFFFFFF cuando no conocen el tamaño final de
 * antemano, o el valor queda truncado). Si el tamaño declarado no cabe
 * en el buffer real, se usa lo que de verdad hay disponible.
 */
export const parseWavPcm = (buffer) => {
  if (buffer.length < 12 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("No es un archivo WAV válido (falta la cabecera RIFF/WAVE).");
  }
  let offset = 12;
  let fmt = null;
  let dataStart = null;
  let dataSize = null;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    if (chunkId === "fmt ") {
      fmt = {
        numChannels: buffer.readUInt16LE(bodyStart + 2),
        sampleRate: buffer.readUInt32LE(bodyStart + 4),
        bitsPerSample: buffer.readUInt16LE(bodyStart + 14),
      };
    } else if (chunkId === "data") {
      dataStart = bodyStart;
      dataSize = chunkSize;
    }
    // Los chunks RIFF se alinean a 2 bytes.
    offset = bodyStart + chunkSize + (chunkSize % 2);
    if (fmt && dataStart !== null) break;
  }
  if (!fmt || dataStart === null) {
    throw new Error("WAV sin chunk 'fmt ' o 'data' reconocible.");
  }
  const available = buffer.length - dataStart;
  const realSize = dataSize === null || dataSize === 0 || dataSize > available ? available : dataSize;
  return {
    sampleRate: fmt.sampleRate,
    numChannels: fmt.numChannels,
    bitsPerSample: fmt.bitsPerSample,
    pcm: buffer.subarray(dataStart, dataStart + realSize),
  };
};

/**
 * RMS por cuadro de `frameMs`, en dBFS (20*log10(rms)); un cuadro sin
 * ninguna muestra no nula queda en -Infinity (silencio digital total).
 * Solo soporta PCM de 16 bits con signo (lo único que se le pide a
 * FFmpeg al construir la pista -- encoder `pcm_s16le`, confirmado
 * disponible en el binario de producción).
 */
export const computeRmsProfileDb = ({ pcm, sampleRate, numChannels, bitsPerSample }, frameMs = 10) => {
  if (bitsPerSample !== 16) {
    throw new Error(`computeRmsProfileDb solo soporta PCM de 16 bits (recibido: ${bitsPerSample}).`);
  }
  const bytesPerSample = 2;
  const frameSamples = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const totalSamplesPerChannel = Math.floor(pcm.length / (bytesPerSample * numChannels));
  const frameCount = totalSamplesPerChannel === 0 ? 0 : Math.ceil(totalSamplesPerChannel / frameSamples);
  const framesDb = new Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    const startSample = f * frameSamples;
    const endSample = Math.min(totalSamplesPerChannel, startSample + frameSamples);
    let sumSquares = 0;
    let count = 0;
    for (let s = startSample; s < endSample; s++) {
      for (let c = 0; c < numChannels; c++) {
        const byteOffset = (s * numChannels + c) * bytesPerSample;
        const sample = pcm.readInt16LE(byteOffset) / 32768;
        sumSquares += sample * sample;
        count += 1;
      }
    }
    const rms = count > 0 ? Math.sqrt(sumSquares / count) : 0;
    framesDb[f] = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
  }
  return { framesDb, frameMs, frameSamples };
};

/** Duración real (del PCM ya armado) contra la esperada (de buildTimeline). */
export const checkDuration = (actualDurationSeconds, expectedDurationSeconds, toleranceSeconds = 0.15) => {
  const deltaSeconds = actualDurationSeconds - expectedDurationSeconds;
  return { ok: Math.abs(deltaSeconds) <= toleranceSeconds, actualDurationSeconds, expectedDurationSeconds, deltaSeconds };
};

/**
 * Silencios anormalmente largos en la pista YA EDITADA -- no debería
 * haber un hueco de voz mayor al que el propio contenido explica; un
 * silencio largo e inesperado suele ser síntoma de un corte que se fue
 * más allá de lo previsto, o de un tramo que se perdió en el empalme.
 */
export const checkAbnormalSilences = ({ framesDb, frameMs }, { silenceDb = -40, maxAllowedSilenceSeconds = 2.5 } = {}) => {
  const issues = [];
  let runStart = null;
  for (let i = 0; i <= framesDb.length; i++) {
    const isSilent = i < framesDb.length && framesDb[i] <= silenceDb;
    if (isSilent && runStart === null) {
      runStart = i;
    } else if (!isSilent && runStart !== null) {
      const runSeconds = ((i - runStart) * frameMs) / 1000;
      if (runSeconds > maxAllowedSilenceSeconds) {
        issues.push({
          startSeconds: Number(((runStart * frameMs) / 1000).toFixed(3)),
          endSeconds: Number(((i * frameMs) / 1000).toFixed(3)),
          durationSeconds: Number(runSeconds.toFixed(3)),
        });
      }
      runStart = null;
    }
  }
  return { ok: issues.length === 0, issues };
};

/**
 * Verifica cada empalme (el instante, en tiempo de SALIDA, donde dos
 * tramos del original -- antes no adyacentes -- quedaron pegados).
 * Como cada borde se eligió dentro de una pausa real confirmada, la
 * zona alrededor del empalme debería sonar silenciosa en AMBOS lados;
 * si no lo está, la pausa elegida puede no haber sido real, o el
 * empalme introdujo ruido. Además se compara la muestra cruda
 * inmediatamente antes/después del punto exacto del corte -- un salto
 * de amplitud brusco ahí suena como un clic, incluso dentro de una
 * zona que en promedio (por cuadro) parece silenciosa.
 */
export const checkSplices = (
  { pcm, sampleRate, numChannels, framesDb, frameMs },
  spliceOffsetsSeconds,
  { quietDb = -30, sampleJumpThreshold = 0.35, windowMs = 60 } = {},
) => {
  const issues = [];
  const bytesPerSample = 2;
  const windowFrames = Math.max(1, Math.round(windowMs / frameMs));

  spliceOffsetsSeconds.forEach((offsetSeconds, index) => {
    const spliceFrame = Math.round((offsetSeconds * 1000) / frameMs);
    const nearby = [
      ...framesDb.slice(Math.max(0, spliceFrame - windowFrames), spliceFrame),
      ...framesDb.slice(spliceFrame, Math.min(framesDb.length, spliceFrame + windowFrames)),
    ].filter((db) => Number.isFinite(db));
    const maxNearbyDb = nearby.length > 0 ? Math.max(...nearby) : -Infinity;
    if (maxNearbyDb > quietDb) {
      issues.push({
        index,
        offsetSeconds,
        type: "not-quiet",
        detail: `la zona del empalme (±${windowMs}ms) no está tan silenciosa como se esperaba (pico ${maxNearbyDb.toFixed(1)}dB, umbral ${quietDb}dB) -- la pausa elegida puede no haber sido real.`,
      });
    }

    const spliceSample = Math.round(offsetSeconds * sampleRate);
    const byteOffset = spliceSample * numChannels * bytesPerSample;
    const prevByteOffset = byteOffset - bytesPerSample * numChannels;
    if (prevByteOffset >= 0 && byteOffset + bytesPerSample * numChannels <= pcm.length) {
      const before = pcm.readInt16LE(prevByteOffset) / 32768;
      const after = pcm.readInt16LE(byteOffset) / 32768;
      const jump = Math.abs(after - before);
      if (jump > sampleJumpThreshold) {
        issues.push({
          index,
          offsetSeconds,
          type: "sample-jump",
          detail: `salto brusco de amplitud justo en el empalme (${jump.toFixed(3)} sobre un rango de -1 a 1, umbral ${sampleJumpThreshold}) -- puede sonar como un clic.`,
        });
      }
    }
  });

  return { ok: issues.length === 0, issues };
};

/**
 * Construye el comando de FFmpeg que arma, en UNA pasada, la pista de
 * audio editada: recorta cada tramo que sobrevive (según `timeline`,
 * de timeline.mjs) y los concatena en orden. Usa solo filtros centrales
 * de libavfilter (`atrim`, `asetpts`, `concat`) y el muxer `wav` +
 * encoder `pcm_s16le` -- ambos confirmados disponibles en el binario de
 * producción (a diferencia del muxer `s16le` raw, que NO lo está).
 */
export const buildAudioExtractionArgs = (videoPath, timeline, outputPath) => {
  const { segments } = timeline;
  if (segments.length === 0) {
    throw new Error("buildAudioExtractionArgs: la línea de tiempo no tiene ningún tramo (todo el video fue cortado).");
  }
  const filterParts = segments.map((seg, i) => {
    const label = segments.length === 1 ? "outa" : `a${i}`;
    return `[0:a]atrim=start=${seg.sourceStart.toFixed(6)}:end=${seg.sourceEnd.toFixed(6)},asetpts=PTS-STARTPTS[${label}]`;
  });
  const filterComplex =
    segments.length === 1
      ? filterParts[0]
      : `${filterParts.join(";")};${segments.map((_, i) => `[a${i}]`).join("")}concat=n=${segments.length}:v=0:a=1[outa]`;
  return ["-y", "-i", videoPath, "-filter_complex", filterComplex, "-map", "[outa]", "-acodec", "pcm_s16le", "-f", "wav", outputPath];
};

const realRunFfmpeg = async (ffmpegPath, ffmpegEnv, args) => {
  await execFileAsync(ffmpegPath, args, { env: ffmpegEnv, maxBuffer: 1024 * 1024 * 128 });
};
let runFfmpeg = realRunFfmpeg;
/** Inyección para pruebas (mismo patrón que audio-analysis.mjs) -- nunca ejecuta FFmpeg de verdad. */
export const __setFfmpegRunnerForTesting = (fn) => {
  runFfmpeg = fn ?? realRunFfmpeg;
};

/**
 * Arma la pista de audio editada con EXACTAMENTE los cortes que
 * producción aplicará y la devuelve ya parseada (PCM + metadatos),
 * junto con los puntos de empalme (en tiempo de salida) que hay que
 * revisar. Borra el WAV temporal al terminar, haya salido bien o no.
 */
export const buildEditedAudioTrack = async ({ ffmpegPath, ffmpegEnv, videoPath, cuts, videoDurationSeconds }) => {
  const timeline = buildTimeline(videoDurationSeconds, cuts);
  const tmpPath = path.join(os.tmpdir(), `quality-gate-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
  const args = buildAudioExtractionArgs(videoPath, timeline, tmpPath);
  try {
    await runFfmpeg(ffmpegPath, ffmpegEnv, args);
    const buffer = await fsp.readFile(tmpPath);
    const wav = parseWavPcm(buffer);
    const spliceOffsetsSeconds = timeline.segments.slice(0, -1).map((seg) => seg.outputEnd);
    return { wav, timeline, spliceOffsetsSeconds, expectedDurationSeconds: timeline.outputDurationInSeconds };
  } finally {
    await fsp.unlink(tmpPath).catch(() => {});
  }
};

/**
 * Una sola pasada de la puerta de calidad (sin reintentos): arma la
 * pista editada y corre las cinco verificaciones del dictamen
 * (duración, empalmes, silencios anormales -- las otras dos, "respeta
 * límites acústicos" y "se conserva el habla no autorizada a
 * eliminar", ya las garantiza aguas arriba refineCutsWithRealSilence,
 * que es la única fuente de los cortes que llegan hasta aquí).
 */
export const runQualityGate = async ({ ffmpegPath, ffmpegEnv, videoPath, cuts, videoDurationSeconds, log = () => {} }) => {
  if (cuts.length === 0) {
    return { ok: true, durationCheck: { ok: true }, spliceCheck: { ok: true, issues: [] }, silenceCheck: { ok: true, issues: [] }, spliceCount: 0, issues: [] };
  }

  const { wav, spliceOffsetsSeconds, expectedDurationSeconds } = await buildEditedAudioTrack({
    ffmpegPath,
    ffmpegEnv,
    videoPath,
    cuts,
    videoDurationSeconds,
  });
  const actualDurationSeconds = wav.pcm.length / (wav.sampleRate * wav.numChannels * 2);
  const durationCheck = checkDuration(actualDurationSeconds, expectedDurationSeconds);
  const profile = computeRmsProfileDb(wav);
  const spliceCheck = checkSplices({ ...wav, framesDb: profile.framesDb, frameMs: profile.frameMs }, spliceOffsetsSeconds);
  const silenceCheck = checkAbnormalSilences(profile);
  const ok = durationCheck.ok && spliceCheck.ok && silenceCheck.ok;

  const issues = [];
  if (!durationCheck.ok) {
    issues.push(`duración de la pista editada: esperada ${expectedDurationSeconds.toFixed(3)}s, obtenida ${actualDurationSeconds.toFixed(3)}s (delta ${durationCheck.deltaSeconds.toFixed(3)}s).`);
  }
  for (const s of spliceCheck.issues) issues.push(`empalme #${s.index} en ${s.offsetSeconds.toFixed(3)}s: ${s.detail}`);
  for (const s of silenceCheck.issues) issues.push(`silencio anormal de ${s.durationSeconds.toFixed(2)}s entre ${s.startSeconds.toFixed(2)}s y ${s.endSeconds.toFixed(2)}s de la pista editada.`);
  for (const issue of issues) log(`puerta de calidad: ${issue}`);
  if (ok) log(`puerta de calidad: ${spliceOffsetsSeconds.length} empalme(s) verificado(s), sin defectos.`);

  return { ok, durationCheck, spliceCheck, silenceCheck, spliceCount: spliceOffsetsSeconds.length, issues };
};

const stripCandidates = ({ _startCandidates, _endCandidates, ...rest }) => rest;

const tryAlternateSeconds = (cut, startSkip, endSkip) => {
  const startCands = cut._startCandidates ?? [];
  const endCands = cut._endCandidates ?? [];
  if (startSkip >= startCands.length || endSkip >= endCands.length) return null;
  const s = startCands[startSkip];
  const e = endCands[endSkip];
  if (e.chosenSeconds - s.chosenSeconds <= 0) return null;
  return { ...cut, startSeconds: s.chosenSeconds, endSeconds: e.chosenSeconds };
};

/**
 * Puerta de calidad CON el flujo de corrección del dictamen (sección
 * 4): si un empalme falla, (1) intenta la siguiente pausa candidata ya
 * confirmada dentro del límite permitido para ese borde (viene de
 * `cut._startCandidates`/`_endCandidates`, que deja refineCutsWithRealSilence);
 * (2) si no queda ninguna, descarta ese corte entero y conserva el
 * audio original en ese tramo; (3) vuelve a verificar la pista
 * completa; (4) registra la incidencia y sigue. Solo se detiene ante
 * un defecto que no esté atado a un empalme concreto (duración o
 * silencio anormal) -- ahí no hay "siguiente candidato" que probar.
 *
 * Requiere que `cuts` venga de refineCutsWithRealSilence (con los
 * candidatos adjuntos); si vinieran de otra fuente, simplemente no hay
 * corrección posible y el primer fallo descarta el corte directamente.
 */
export const runQualityGateWithRemediation = async ({
  ffmpegPath,
  ffmpegEnv,
  videoPath,
  cuts,
  videoDurationSeconds,
  log = () => {},
  maxRounds = 6,
}) => {
  let currentCuts = cuts.map((c) => ({ ...c }));
  const incidents = [];
  const attemptState = new Map();

  for (let round = 0; round < maxRounds; round++) {
    const result = await runQualityGate({ ffmpegPath, ffmpegEnv, videoPath, cuts: currentCuts, videoDurationSeconds, log });
    if (result.ok) {
      return { ok: true, cuts: currentCuts.map(stripCandidates), incidents, rounds: round + 1, qualityReport: result };
    }

    const failingIndexes = new Set(result.spliceCheck.issues.map((i) => i.index));
    if (failingIndexes.size === 0) {
      const reason = "defecto no atribuible a un empalme específico (duración o silencio anormal) -- no hay una corrección automática segura que intentar.";
      incidents.push(reason);
      return { ok: false, cuts: currentCuts.map(stripCandidates), incidents, rounds: round + 1, qualityReport: result, stoppedReason: reason };
    }

    let changed = false;
    const nextCuts = [];
    for (let i = 0; i < currentCuts.length; i++) {
      const cut = currentCuts[i];
      if (!failingIndexes.has(i)) {
        nextCuts.push(cut);
        continue;
      }
      const state = attemptState.get(cut.id) ?? { startSkip: 0, endSkip: 0 };
      let alt = tryAlternateSeconds(cut, state.startSkip + 1, state.endSkip);
      let nextState = { startSkip: state.startSkip + 1, endSkip: state.endSkip };
      if (!alt) {
        alt = tryAlternateSeconds(cut, state.startSkip, state.endSkip + 1);
        nextState = { startSkip: state.startSkip, endSkip: state.endSkip + 1 };
      }
      changed = true;
      if (alt) {
        attemptState.set(cut.id, nextState);
        nextCuts.push(alt);
        incidents.push(`corte "${cut.id}": el empalme no superó la puerta de calidad -- se intentó la siguiente pausa candidata dentro del límite permitido.`);
      } else {
        incidents.push(`corte "${cut.id}": el empalme no superó la puerta de calidad y no quedan más pausas candidatas dentro del límite -- se descarta el corte, se conserva el audio original.`);
      }
    }
    if (!changed) {
      const reason = "no se encontró ninguna corrección ni corte para descartar -- defecto no resuelto automáticamente.";
      incidents.push(reason);
      return { ok: false, cuts: currentCuts.map(stripCandidates), incidents, rounds: round + 1, qualityReport: result, stoppedReason: reason };
    }
    currentCuts = nextCuts;
  }

  const reason = `se alcanzó el límite de ${maxRounds} rondas de corrección sin un resultado seguro.`;
  incidents.push(reason);
  return { ok: false, cuts: currentCuts.map(stripCandidates), incidents, rounds: maxRounds, qualityReport: null, stoppedReason: reason };
};
