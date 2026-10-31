// Análisis de energía acústica real del audio (dictamen de corrección
// de audio, 30-oct-2026, sección 2): snapCutsToWordBoundaries
// (editorial.mjs) ya garantiza que ningún borde de corte cae DENTRO de
// una palabra según los tiempos de Whisper -- pero esos tiempos pueden
// estar desfasados respecto al audio real (defecto real: "Cameron
// Sepah" sonaba cortado aunque el ajuste por palabra ya se había
// aplicado). Esto analiza el AUDIO REAL con FFmpeg para, dentro del
// rango ya garantizado seguro por palabra (nunca afuera de él), elegir
// el punto de menor energía real -- la pausa más probable -- en vez de
// confiar solo en el timestamp de Whisper.
//
// Reutiliza FFmpeg (ya vendorizado por @remotion/compositor-*, ver
// resolveCompositorFfmpeg en index.mjs) -- nada de un servicio externo
// (requisito 10 del dictamen).
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Misma tasa que usa Whisper (ver transcribe.mjs) -- consistente con
// el resto del pipeline, y de sobra para resolver energía en ventanas
// de 10ms (160 muestras).
const SAMPLE_RATE = 16000;
const FRAME_MS = 10;
const FRAME_SAMPLES = Math.round((SAMPLE_RATE * FRAME_MS) / 1000);
const FRAME_BYTES = FRAME_SAMPLES * 2; // s16le = 2 bytes/muestra

// Ventana de búsqueda alrededor de cada borde (precisión B del
// operador, 30-oct-2026): +-0.35s. NUNCA se busca fuera del rango ya
// garantizado seguro por palabra (edgeBounds de snapCutsToWordBoundaries)
// -- esta ventana solo puede acortar esa búsqueda, nunca ampliarla.
export const AUDIO_SEARCH_RADIUS_SECONDS = 0.35;

// Umbral propuesto (el dictamen pide explícitamente "el umbral que tú
// propongas"): una caída de al menos 12dB por debajo del pico de la
// propia ventana, sostenida por al menos 30ms (3 frames de 10ms)
// consecutivos. Una pausa real entre palabras muestra una caída mucho
// más marcada y sostenida que el mínimo típico dentro de una consonante
// (que suele ser más breve y menos profundo) -- esto es justamente el
// requisito 5 del dictamen: no confundir un mínimo de volumen dentro de
// una consonante con un límite real entre palabras.
export const PAUSE_RELATIVE_DROP_DB = 12;
export const PAUSE_MIN_SUSTAINED_MS = 30;
const PAUSE_MIN_SUSTAINED_FRAMES = Math.round(PAUSE_MIN_SUSTAINED_MS / FRAME_MS);

/**
 * Extrae una ventana chica de audio en PCM crudo (mono, 16kHz, s16le)
 * del video real. Seek rápido (input, aproximado) + seek fino (output,
 * preciso) -- evita decodificar el archivo completo desde el inicio
 * para llegar a un punto tarde en un video largo, sin perder precisión
 * en el punto exacto.
 *
 * NO es testeable sin un FFmpeg real -- este entorno de desarrollo no
 * tiene uno funcional (ver informe). Revisar con cuidado antes de
 * confiar en ella; la lógica de análisis (computeRmsProfile,
 * findAcousticPausePoint) es pura y SÍ está probada.
 */
const realExtractPcmWindow = async ({ ffmpegPath, ffmpegEnv, videoPath, startSeconds, durationSeconds }) => {
  const coarseStart = Math.max(0, startSeconds - 2);
  const fineOffset = startSeconds - coarseStart;
  const { stdout } = await execFileAsync(
    ffmpegPath,
    [
      "-ss", coarseStart.toFixed(3),
      "-i", videoPath,
      "-ss", fineOffset.toFixed(3),
      "-t", durationSeconds.toFixed(3),
      "-vn",
      "-ar", String(SAMPLE_RATE),
      "-ac", "1",
      "-f", "s16le",
      "pipe:1",
    ],
    { env: ffmpegEnv, encoding: "buffer", maxBuffer: 1024 * 1024 * 8 },
  );
  return stdout;
};

let pcmExtractor = realExtractPcmWindow;

export const extractPcmWindow = (args) => pcmExtractor(args);

/**
 * Solo para pruebas: inyecta un extractor falso en vez de invocar
 * FFmpeg real -- mismo patrón que __setAnthropicClientForTesting en
 * editorial.mjs. Permite probar el control de flujo de
 * refineEdgeAcoustically/refineCutsAcoustically (fallback al límite
 * seguro por palabra, descarte si el resultado degenera, manejo de
 * errores) sin un FFmpeg real.
 */
export const __setPcmExtractorForTesting = (fakeExtractor) => {
  pcmExtractor = fakeExtractor ?? realExtractPcmWindow;
};

/**
 * PCM crudo (s16le mono) -> perfil de energía RMS en dB, un valor cada
 * FRAME_MS. Función PURA, testeable sin FFmpeg -- se le puede pasar
 * cualquier Buffer sintético. `windowStartSeconds` es solo para que
 * cada frame lleve su tiempo absoluto real, no relativo a la ventana.
 */
export const computeRmsProfile = (pcmBuffer, windowStartSeconds) => {
  const frameCount = Math.floor(pcmBuffer.length / FRAME_BYTES);
  const profile = [];
  for (let i = 0; i < frameCount; i++) {
    let sumSquares = 0;
    for (let s = 0; s < FRAME_SAMPLES; s++) {
      const offset = i * FRAME_BYTES + s * 2;
      const sample = pcmBuffer.readInt16LE(offset);
      sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / FRAME_SAMPLES);
    // dBFS relativo a la amplitud máxima de s16 (32768). Silencio
    // absoluto (rms=0) da -Infinity -- se deja en un piso razonable
    // para que el perfil sea siempre un número usable.
    const db = rms > 0 ? 20 * Math.log10(rms / 32768) : -96;
    profile.push({
      offsetSeconds: Number((windowStartSeconds + (i * FRAME_MS) / 1000).toFixed(3)),
      db: Number(db.toFixed(1)),
    });
  }
  return profile;
};

/**
 * Busca, dentro de un perfil de energía, un punto de pausa real -- no
 * el mínimo absoluto sin más, sino el tramo más largo que se mantiene
 * sostenido por debajo de PAUSE_RELATIVE_DROP_DB respecto al pico de
 * la propia ventana, y por al menos PAUSE_MIN_SUSTAINED_MS. Dentro de
 * ese tramo, el punto elegido es el de menor energía (el centro
 * acústico de la pausa).
 *
 * Devuelve `null` si ningún tramo cumple -- requisito 8 del dictamen:
 * sin un punto seguro, no se inventa uno. Función PURA, testeable sin
 * FFmpeg.
 */
export const findAcousticPausePoint = (profile) => {
  if (profile.length === 0) return null;
  const peakDb = Math.max(...profile.map((f) => f.db));
  const threshold = peakDb - PAUSE_RELATIVE_DROP_DB;

  let bestStart = -1;
  let bestRun = 0;
  let runStart = -1;
  let run = 0;
  for (let i = 0; i < profile.length; i++) {
    if (profile[i].db <= threshold) {
      if (run === 0) runStart = i;
      run++;
    } else {
      if (run > bestRun) {
        bestRun = run;
        bestStart = runStart;
      }
      run = 0;
    }
  }
  if (run > bestRun) {
    bestRun = run;
    bestStart = runStart;
  }

  if (bestRun < PAUSE_MIN_SUSTAINED_FRAMES) {
    return null;
  }

  const runFrames = profile.slice(bestStart, bestStart + bestRun);
  const quietest = runFrames.reduce((min, f) => (f.db < min.db ? f : min), runFrames[0]);
  return quietest.offsetSeconds;
};

/**
 * Refina un borde de corte YA seguro por palabra con un punto acústico
 * real. `safeMin`/`safeMax` son el rango que snapCutsToWordBoundaries
 * ya calculó como seguro para este borde (`edgeBounds`) -- la ventana
 * de búsqueda (+-AUDIO_SEARCH_RADIUS_SECONDS alrededor de `wordSafeSeconds`)
 * se recorta SIEMPRE a ese rango, nunca lo excede: un hallazgo acústico
 * nunca puede reintroducir el corte de una palabra.
 *
 * Si no hay un punto de pausa confiable, devuelve el propio límite
 * seguro por palabra sin tocar (`refined: false`) -- nunca se deja un
 * borde defectuoso, pero tampoco se inventa una pausa sin confirmar
 * (la selección por energía es una herramienta para mejorar la
 * precisión, no una garantía absoluta -- dictamen, sección 2).
 */
export const refineEdgeAcoustically = async ({
  ffmpegPath,
  ffmpegEnv,
  videoPath,
  wordSafeSeconds,
  safeMin,
  safeMax,
}) => {
  const windowStart = Math.max(safeMin, wordSafeSeconds - AUDIO_SEARCH_RADIUS_SECONDS);
  const windowEnd = Math.min(safeMax, wordSafeSeconds + AUDIO_SEARCH_RADIUS_SECONDS);

  if (windowEnd - windowStart <= 0) {
    return { seconds: wordSafeSeconds, refined: false, profile: [] };
  }

  const pcm = await extractPcmWindow({
    ffmpegPath,
    ffmpegEnv,
    videoPath,
    startSeconds: windowStart,
    durationSeconds: windowEnd - windowStart,
  });
  const profile = computeRmsProfile(pcm, windowStart);
  const pausePoint = findAcousticPausePoint(profile);

  if (pausePoint === null) {
    return { seconds: wordSafeSeconds, refined: false, profile };
  }
  return { seconds: pausePoint, refined: true, profile };
};

/**
 * Refina acústicamente TODOS los cortes (ambos bordes de cada uno) --
 * para el pipeline real (planEditIfNeeded/POST /jobs/:id/replan en
 * index.mjs). Usa `edgeBounds` (de snapCutsToWordBoundaries) para que
 * cada refinamiento nunca busque fuera del rango ya garantizado seguro
 * por palabra.
 *
 * Requisito 8 del dictamen: si ninguno de los dos bordes de un corte
 * encuentra una pausa confiable Y ADEMÁS el corte ya venía ajustado
 * por palabra (su rango seguro es más angosto que lo que pidió el
 * modelo), se prioriza conservar el audio hablado -- nunca se deja un
 * corte con un borde que no se pudo confirmar. En la práctica esto ya
 * lo garantiza snapCutsToWordBoundaries (el corte nunca cae dentro de
 * una palabra); acá solo se vigila que el refinamiento acústico en sí
 * no vuelva a invertir o degenerar el corte -- si pasa, se descarta y
 * se registra, igual que snapCutsToWordBoundaries.
 */
export const refineCutsAcoustically = async ({ cuts, edgeBounds, videoPath, ffmpegPath, ffmpegEnv, minCutSeconds, log = () => {} }) => {
  const cutIssues = [];
  const refined = [];

  for (const cut of cuts) {
    const bounds = edgeBounds[cut.id];
    if (!bounds) {
      refined.push(cut);
      continue;
    }

    let startSeconds = cut.startSeconds;
    let endSeconds = cut.endSeconds;
    try {
      const startResult = await refineEdgeAcoustically({
        ffmpegPath,
        ffmpegEnv,
        videoPath,
        wordSafeSeconds: cut.startSeconds,
        safeMin: bounds.start.min,
        safeMax: bounds.start.max,
      });
      startSeconds = startResult.seconds;
      log(
        `corte "${cut.id}" borde inicio: ${
          startResult.refined
            ? `ajustado acústicamente a ${startSeconds.toFixed(3)}s (pausa real encontrada)`
            : `sin pausa acústica confiable -- se usa el límite seguro por palabra (${startSeconds.toFixed(3)}s)`
        }`,
      );

      const endResult = await refineEdgeAcoustically({
        ffmpegPath,
        ffmpegEnv,
        videoPath,
        wordSafeSeconds: cut.endSeconds,
        safeMin: bounds.end.min,
        safeMax: bounds.end.max,
      });
      endSeconds = endResult.seconds;
      log(
        `corte "${cut.id}" borde final: ${
          endResult.refined
            ? `ajustado acústicamente a ${endSeconds.toFixed(3)}s (pausa real encontrada)`
            : `sin pausa acústica confiable -- se usa el límite seguro por palabra (${endSeconds.toFixed(3)}s)`
        }`,
      );
    } catch (err) {
      log(`corte "${cut.id}": el análisis acústico falló (${err.message ?? err}) -- se usa el límite seguro por palabra sin refinar.`);
      startSeconds = cut.startSeconds;
      endSeconds = cut.endSeconds;
    }

    if (endSeconds - startSeconds < minCutSeconds) {
      cutIssues.push(
        `corte "${cut.id}" (${cut.startSeconds.toFixed(2)}-${cut.endSeconds.toFixed(2)}s): el refinamiento acústico de ambos bordes dejó menos de ${(minCutSeconds * 1000).toFixed(0)}ms de corte real -- descartado para no arriesgar un corte defectuoso.`,
      );
      continue;
    }

    refined.push({ ...cut, startSeconds, endSeconds });
  }

  return { cuts: refined, cutIssues };
};
