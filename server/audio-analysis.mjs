// Análisis de audio real para corregir bordes de corte (dictamen de
// corrección de audio, 30-oct-2026, secciones 2-3 + precisiones A/B
// del operador sobre el resultado real en el VPS).
//
// Historia real de este archivo, importante para entender el diseño:
// la primera versión extraía PCM crudo (`-f s16le pipe:1`) y calculaba
// energía RMS a mano. El ffmpeg REAL de producción
// (compositor-linux-x64-gnu, compilado con --disable-muxers) no tiene
// el muxer "s16le" -- solo un conjunto chico: webm, opus, mp4, wav,
// mp3, mov, matroska, hevc, h264, gif, image2, image2pipe, adts, m4a,
// mpegts, null, avi. Además, el desfase de Whisper respecto al audio
// real puede ser mayor que la ventana angosta (+-0.35s) que esa
// primera versión buscaba DENTRO del límite ya "seguro por palabra" --
// si Whisper está desfasado, ese límite deja de ser confiable.
//
// Esta versión reemplaza todo el mecanismo por `silencedetect`, el
// filtro de audio que YA trae el ffmpeg de producción (confirmado),
// usado con el muxer "null" (también confirmado) -- NO necesita
// extraer ni un byte de audio: ffmpeg hace la detección de silencios
// internamente y la reporta por stderr. Esto evita de raíz el problema
// de la cabecera WAV (nunca se extrae PCM en absoluto) y, sobre todo,
// permite buscar la pausa real más cercana en una ventana ancha
// (+-1.0s) SIN depender de que los límites de Whisper sean correctos.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Precisión (a) del operador, 30-oct-2026: mover cada borde a la
// pausa real más cercana dentro de +-1.0s, SIN exigir que quede dentro
// de los límites de Whisper (a diferencia del mecanismo anterior).
export const SILENCE_SEARCH_RADIUS_SECONDS = 1.0;
// Precisión (b): ventana más ancha solo para el diagnóstico/comparación
// (snap-cuts), no para la decisión real.
export const SILENCE_WIDE_REPORT_RADIUS_SECONDS = 3.0;
// Propuestos por el operador en su pedido.
export const SILENCE_NOISE_DB = -35;
export const SILENCE_MIN_DURATION_SECONDS = 0.12;

const buildSilencedetectArgs = ({ videoPath, windowStart, windowDuration, noiseDb, minDurationSeconds }) => [
  "-ss", windowStart.toFixed(3),
  "-i", videoPath,
  "-t", windowDuration.toFixed(3),
  "-vn",
  "-af", `silencedetect=noise=${noiseDb}dB:d=${minDurationSeconds}`,
  "-f", "null",
  "-",
];

/**
 * Corre `silencedetect` sobre una ventana del audio real y devuelve el
 * stderr crudo (ahí es donde ffmpeg loguea `silence_start`/`silence_end`
 * -- el filtro no necesita escribir ningún archivo ni dato de audio).
 *
 * Deliberadamente SOLO seek de entrada (`-ss` antes de `-i`, sin seek
 * de salida) -- es el que de forma más confiable conserva, en los
 * timestamps que reporta el filtro, el tiempo del archivo ORIGINAL en
 * vez de resetearlo a cero; para audio (`-vn`, sin dependencia de
 * keyframes de video) la precisión de este seek es buena. NO se pudo
 * verificar contra un ffmpeg de producción real desde este entorno de
 * desarrollo (ver informe) -- por eso `parseSilenceDetectOutput` NO
 * asume ciegamente que el resultado es absoluto: lo verifica contra la
 * ventana pedida y corrige si hiciera falta (ver más abajo).
 *
 * NO es testeable sin un FFmpeg real -- la lógica de parseo/decisión
 * (parseSilenceDetectOutput, findNearestRealPause) es pura y SÍ está
 * probada con texto de stderr sintético.
 */
const realDetectSilences = async ({ ffmpegPath, ffmpegEnv, videoPath, windowStart, windowDuration, noiseDb, minDurationSeconds }) => {
  const args = buildSilencedetectArgs({ videoPath, windowStart, windowDuration, noiseDb, minDurationSeconds });
  try {
    const { stderr } = await execFileAsync(ffmpegPath, args, { env: ffmpegEnv, encoding: "utf8", maxBuffer: 1024 * 1024 * 4 });
    return stderr ?? "";
  } catch (err) {
    // ffmpeg con -f null normalmente sale con código 0; si falla por
    // otra razón (archivo inexistente, filtro no soportado, etc.), el
    // stderr sigue siendo útil para el mensaje de error -- se propaga
    // igual, quien llama decide qué hacer.
    if (err && typeof err.stderr === "string") {
      throw new Error(`${err.message}\n${err.stderr}`);
    }
    throw err;
  }
};

let silenceDetector = realDetectSilences;

export const detectSilences = (args) => silenceDetector(args);

/**
 * Solo para pruebas: inyecta un detector falso en vez de invocar
 * FFmpeg real -- mismo patrón que __setAnthropicClientForTesting en
 * editorial.mjs.
 */
export const __setSilenceDetectorForTesting = (fakeDetector) => {
  silenceDetector = fakeDetector ?? realDetectSilences;
};

/**
 * stderr crudo de `silencedetect` -> lista de intervalos de silencio
 * real en SEGUNDOS ABSOLUTOS del archivo original. Función PURA,
 * testeable con texto sintético.
 *
 * Un `silence_start` sin su `silence_end` correspondiente (la ventana
 * analizada terminó todavía en silencio) se cierra al final de la
 * ventana -- no se descarta, pero tampoco se extrapola más allá de lo
 * que de verdad se analizó.
 *
 * Salvaguarda (no verificable sin FFmpeg real, ver comentario arriba
 * de realDetectSilences): si los `silence_start` reportados son
 * plausibles como absolutos (caen dentro de la ventana pedida, con 1s
 * de margen), se usan tal cual; si no, se asumen relativos al inicio
 * de la ventana y se les suma `windowStart`. El fin de un intervalo
 * "colgado" (sin su silence_end) es siempre `windowEnd` -- un hecho
 * absoluto sobre la ventana analizada, nunca depende de en qué
 * unidades reportó ffmpeg el inicio.
 */
export const parseSilenceDetectOutput = (stderrText, windowStart, windowDuration) => {
  const windowEnd = windowStart + windowDuration;
  const closedIntervals = [];
  // Un silence_start sin su silence_end (la ventana terminó todavía en
  // silencio) se guarda aparte -- su fin real es "donde terminó la
  // ventana analizada" (windowEnd), un hecho absoluto que no depende
  // de en qué unidades reportó ffmpeg el inicio; nunca se lo sometemos
  // a la misma corrección relativa/absoluta que el inicio.
  let danglingStart = null;

  let pendingStart = null;
  for (const line of stderrText.split("\n")) {
    const startMatch = line.match(/silence_start:\s*(-?[\d.]+)/);
    const endMatch = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (startMatch) {
      pendingStart = Number(startMatch[1]);
    } else if (endMatch && pendingStart !== null) {
      closedIntervals.push({ start: pendingStart, end: Number(endMatch[1]) });
      pendingStart = null;
    }
  }
  if (pendingStart !== null) {
    danglingStart = pendingStart;
  }

  const allStarts = closedIntervals.map((iv) => iv.start).concat(danglingStart !== null ? [danglingStart] : []);
  if (allStarts.length === 0) return [];

  const margin = 1;
  const looksAbsolute = allStarts.every((s) => s >= windowStart - margin && s <= windowEnd + margin);
  const toAbsoluteStart = looksAbsolute ? (s) => s : (s) => s + windowStart;

  const intervals = closedIntervals.map((iv) => ({ start: toAbsoluteStart(iv.start), end: toAbsoluteStart(iv.end) }));
  if (danglingStart !== null) {
    intervals.push({ start: toAbsoluteStart(danglingStart), end: windowEnd });
  }
  return intervals;
};

/**
 * De una lista de intervalos de silencio real, el más cercano a
 * `targetSeconds` -- distancia 0 si el punto ya cae dentro del
 * intervalo. El punto elegido dentro del intervalo elegido es su
 * CENTRO (el lugar más seguro para cortar: máximo margen a ambos
 * lados dentro de la pausa confirmada).
 */
export const findNearestRealPause = (intervals, targetSeconds) => {
  if (!intervals || intervals.length === 0) return null;
  let best = null;
  let bestDistance = Infinity;
  for (const iv of intervals) {
    const distance = targetSeconds < iv.start ? iv.start - targetSeconds : targetSeconds > iv.end ? targetSeconds - iv.end : 0;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = iv;
    }
  }
  return { interval: best, distanceSeconds: bestDistance, chosenSeconds: (best.start + best.end) / 2 };
};

/**
 * Busca la pausa real más cercana a `targetSeconds`, dentro de
 * +-`maxDistanceSeconds` (precisión (a): 1.0s por defecto, ya NO
 * limitado al rango "seguro por palabra" de Whisper). Devuelve `null`
 * si no hay ninguna pausa confirmada dentro de esa distancia --
 * requisito del dictamen: "si no existe un punto seguro, conservar el
 * fragmento hablado", nunca se inventa un punto.
 */
export const findRealPauseNearEdge = async ({
  ffmpegPath,
  ffmpegEnv,
  videoPath,
  targetSeconds,
  maxDistanceSeconds = SILENCE_SEARCH_RADIUS_SECONDS,
  noiseDb = SILENCE_NOISE_DB,
  minDurationSeconds = SILENCE_MIN_DURATION_SECONDS,
  videoDurationSeconds,
}) => {
  const windowStart = Math.max(0, targetSeconds - maxDistanceSeconds);
  const windowEndRaw = targetSeconds + maxDistanceSeconds;
  const windowEnd = typeof videoDurationSeconds === "number" ? Math.min(videoDurationSeconds, windowEndRaw) : windowEndRaw;
  const windowDuration = windowEnd - windowStart;
  if (windowDuration <= 0) {
    return { found: false, intervals: [] };
  }

  const stderrText = await detectSilences({ ffmpegPath, ffmpegEnv, videoPath, windowStart, windowDuration, noiseDb, minDurationSeconds });
  const intervals = parseSilenceDetectOutput(stderrText, windowStart, windowDuration);
  const nearest = findNearestRealPause(intervals, targetSeconds);

  if (!nearest || nearest.distanceSeconds > maxDistanceSeconds) {
    return { found: false, intervals };
  }
  return { found: true, seconds: nearest.chosenSeconds, interval: nearest.interval, intervals };
};

/**
 * Corrige TODOS los cortes usando pausas reales como fuente principal
 * (precisión (a) del operador) -- para el pipeline real
 * (planEditIfNeeded/POST /jobs/:id/replan en index.mjs).
 *
 * Para cada borde de cada corte: busca la pausa real más cercana
 * dentro de +-SILENCE_SEARCH_RADIUS_SECONDS, centrada en el límite ya
 * "seguro por palabra" (de snapCutsToWordBoundaries, recibido en
 * `cuts`) -- se usa como punto de partida de la búsqueda, NO como
 * límite que no se puede cruzar: si Whisper está desfasado, la pausa
 * real elegida puede caer afuera de ese rango.
 *
 * Si CUALQUIERA de los dos bordes no encuentra una pausa real
 * confirmada, se descarta el corte entero y se registra en
 * `cutIssues` -- "si no hay pausa, no cortes: conserva el audio",
 * nunca se fuerza un corte con un borde sin confirmar.
 */
export const refineCutsWithRealSilence = async ({
  cuts,
  videoPath,
  videoDurationSeconds,
  ffmpegPath,
  ffmpegEnv,
  log = () => {},
}) => {
  const cutIssues = [];
  const refined = [];

  for (const cut of cuts) {
    try {
      const startResult = await findRealPauseNearEdge({
        ffmpegPath, ffmpegEnv, videoPath, videoDurationSeconds,
        targetSeconds: cut.startSeconds,
      });
      const endResult = await findRealPauseNearEdge({
        ffmpegPath, ffmpegEnv, videoPath, videoDurationSeconds,
        targetSeconds: cut.endSeconds,
      });

      if (!startResult.found || !endResult.found) {
        cutIssues.push(
          `corte "${cut.id}" (${cut.startSeconds.toFixed(2)}-${cut.endSeconds.toFixed(2)}s${cut.reason ? `, ${cut.reason}` : ""}): ` +
            `${!startResult.found ? "no se encontró una pausa real confirmada cerca del inicio" : ""}` +
            `${!startResult.found && !endResult.found ? " ni cerca del final" : !endResult.found ? "no se encontró una pausa real confirmada cerca del final" : ""}` +
            ` (ventana de ±${SILENCE_SEARCH_RADIUS_SECONDS}s) -- se conserva el audio hablado en vez de forzar un corte sin confirmar.`,
        );
        continue;
      }

      log(
        `corte "${cut.id}" borde inicio: pausa real confirmada en ${startResult.seconds.toFixed(3)}s ` +
          `(antes: ${cut.startSeconds.toFixed(3)}s, desfase ${Math.abs(startResult.seconds - cut.startSeconds).toFixed(3)}s).`,
      );
      log(
        `corte "${cut.id}" borde final: pausa real confirmada en ${endResult.seconds.toFixed(3)}s ` +
          `(antes: ${cut.endSeconds.toFixed(3)}s, desfase ${Math.abs(endResult.seconds - cut.endSeconds).toFixed(3)}s).`,
      );

      if (endResult.seconds - startResult.seconds <= 0) {
        cutIssues.push(
          `corte "${cut.id}": las pausas reales encontradas en cada borde se cruzan (inicio ${startResult.seconds.toFixed(3)}s, final ${endResult.seconds.toFixed(3)}s) -- descartado, se conserva el audio.`,
        );
        continue;
      }

      refined.push({ ...cut, startSeconds: startResult.seconds, endSeconds: endResult.seconds });
    } catch (err) {
      log(`corte "${cut.id}": el análisis de audio real falló (${err.message ?? err}) -- se conserva el audio, no se corta sin confirmar.`);
      cutIssues.push(
        `corte "${cut.id}" (${cut.startSeconds.toFixed(2)}-${cut.endSeconds.toFixed(2)}s): el análisis de audio real falló (${err.message ?? err}) -- se conserva el audio en vez de arriesgar un corte sin confirmar.`,
      );
    }
  }

  return { cuts: refined, cutIssues };
};
