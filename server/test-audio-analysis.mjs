// PRUEBA SIMULADA -- no llama a FFmpeg real (no hay uno funcional en
// este entorno de desarrollo, ver informe; y el ffmpeg REAL de
// producción además resultó estar compilado con --disable-muxers, sin
// el muxer "s16le" que usaba la versión anterior de este archivo).
// Prueba la lógica PURA de parseo/decisión (parseSilenceDetectOutput,
// findNearestRealPause) con texto de stderr sintético, y el CONTROL DE
// FLUJO de findRealPauseNearEdge/refineCutsWithRealSilence inyectando
// un detector de silencios falso (__setSilenceDetectorForTesting,
// mismo patrón que __setAnthropicClientForTesting en editorial.mjs) --
// la invocación REAL de FFmpeg (realDetectSilences) queda sin probar
// acá a propósito, revisada por lectura cuidadosa en vez de ejecución.
import {
  parseSilenceDetectOutput,
  findNearestRealPause,
  findRealPauseNearEdge,
  refineCutsWithRealSilence,
  __setSilenceDetectorForTesting,
  SILENCE_SEARCH_RADIUS_SECONDS,
} from "./audio-analysis.mjs";

let failures = 0;
const approx = (a, b, eps = 0.01) => Math.abs(a - b) < eps;
const check = (label, cond) => {
  if (!cond) {
    failures++;
    console.log(`FAIL: ${label}`);
  } else {
    console.log(`ok: ${label}`);
  }
};

/** stderr sintético de ffmpeg con un solo par silence_start/silence_end. */
const fakeStderr = (startStr, endStr) =>
  `[silencedetect @ 0x55] silence_start: ${startStr}\n[silencedetect @ 0x55] silence_end: ${endStr} | silence_duration: 0.333\n`;

// --- parseSilenceDetectOutput ---

{
  // Caso ABSOLUTO: los tiempos reportados ya caen dentro de la ventana
  // pedida (29-31s) -- se usan tal cual, sin sumar windowStart.
  const stderr = fakeStderr("29.68", "30.24");
  const intervals = parseSilenceDetectOutput(stderr, 29.0, 2.0);
  check("interpretación absoluta: 1 intervalo", intervals.length === 1);
  check("interpretación absoluta: se usa el valor tal cual (29.68)", approx(intervals[0].start, 29.68));
}

{
  // Caso RELATIVO: los tiempos reportados son chicos (0.68s), no
  // caen dentro de la ventana absoluta (29-31s) -- se interpretan como
  // relativos al inicio de la ventana y se les suma windowStart (29.0).
  const stderr = fakeStderr("0.68", "1.24");
  const intervals = parseSilenceDetectOutput(stderr, 29.0, 2.0);
  check("interpretación relativa: se detecta y se corrige sumando windowStart", approx(intervals[0].start, 29.68));
}

{
  // silence_start sin su silence_end correspondiente -- la ventana
  // terminó todavía en silencio. Se cierra al final de la ventana, no
  // se descarta ni se extrapola más allá.
  const stderr = "[silencedetect @ 0x55] silence_start: 29.9\n";
  const intervals = parseSilenceDetectOutput(stderr, 29.0, 2.0); // ventana 29.0-31.0
  check("silence_start sin silence_end: se cierra al final de la ventana analizada", intervals.length === 1 && approx(intervals[0].end, 31.0));
}

{
  // Sin ninguna línea de silencio -- ninguna pausa detectada.
  const intervals = parseSilenceDetectOutput("algo de log normal de ffmpeg\nnada de silencedetect\n", 29.0, 2.0);
  check("sin líneas de silencio: array vacío", intervals.length === 0);
}

{
  // Dos pares en la misma ventana.
  const stderr = fakeStderr("29.2", "29.4") + fakeStderr("30.6", "30.9");
  const intervals = parseSilenceDetectOutput(stderr, 29.0, 2.0);
  check("dos pares silence_start/end: se detectan ambos", intervals.length === 2);
}

// --- findNearestRealPause ---

{
  const intervals = [{ start: 29.2, end: 29.4 }, { start: 30.6, end: 30.9 }];
  const result = findNearestRealPause(intervals, 29.5);
  check("más cercano: elige el intervalo 29.2-29.4 (dist 0.1) sobre 30.6-30.9 (dist 1.1)", result.interval.start === 29.2);
  check("más cercano: distancia correcta", approx(result.distanceSeconds, 0.1));
}

{
  const intervals = [{ start: 29.0, end: 29.5 }];
  const result = findNearestRealPause(intervals, 29.2);
  check("objetivo DENTRO del intervalo: distancia 0", result.distanceSeconds === 0);
  check("objetivo dentro del intervalo: el punto elegido es el CENTRO del intervalo (29.25), no el objetivo", approx(result.chosenSeconds, 29.25));
}

{
  check("sin intervalos: devuelve null", findNearestRealPause([], 10) === null);
}

// --- findRealPauseNearEdge: control de flujo con detector simulado ---

{
  __setSilenceDetectorForTesting(async () => fakeStderr("29.68", "30.24"));
  const result = await findRealPauseNearEdge({
    ffmpegPath: "fake", ffmpegEnv: {}, videoPath: "fake.mp4",
    targetSeconds: 29.9,
  });
  check("pausa real encontrada dentro de la distancia máxima: found=true", result.found === true);
  check("pausa real encontrada: el punto elegido es el centro del intervalo (29.96)", approx(result.seconds, 29.96));
  __setSilenceDetectorForTesting(null);
}

{
  // La pausa detectada está fuera de la ventana realmente analizada
  // (más lejos del objetivo que SILENCE_SEARCH_RADIUS_SECONDS) -- un
  // ffmpeg real nunca reportaría algo fuera de lo que se le pidió
  // analizar, así que el detector simulado respeta la ventana pedida.
  __setSilenceDetectorForTesting(async ({ windowStart, windowDuration }) => {
    const windowEnd = windowStart + windowDuration;
    // La única pausa real de este audio está en 29.68-30.24 -- el
    // detector solo la "ve" si cae dentro de la ventana que se le pidió.
    if (29.68 >= windowStart && 30.24 <= windowEnd) return fakeStderr("29.68", "30.24");
    return "";
  });
  const result = await findRealPauseNearEdge({
    ffmpegPath: "fake", ffmpegEnv: {}, videoPath: "fake.mp4",
    targetSeconds: 29.9, maxDistanceSeconds: 0.01,
  });
  check("pausa fuera de la ventana realmente analizada: found=false", result.found === false);
  __setSilenceDetectorForTesting(null);
}

{
  // Sin ninguna pausa detectada -- found=false, nunca se inventa un punto.
  __setSilenceDetectorForTesting(async () => "sin silencios en este tramo\n");
  const result = await findRealPauseNearEdge({
    ffmpegPath: "fake", ffmpegEnv: {}, videoPath: "fake.mp4",
    targetSeconds: 50.0,
  });
  check("sin pausas detectadas: found=false", result.found === false);
  __setSilenceDetectorForTesting(null);
}

{
  // Ventana recortada por la duración real del video (videoDurationSeconds)
  // hasta degenerar -- ni siquiera llama al detector.
  let called = false;
  __setSilenceDetectorForTesting(async () => {
    called = true;
    return "";
  });
  const result = await findRealPauseNearEdge({
    ffmpegPath: "fake", ffmpegEnv: {}, videoPath: "fake.mp4",
    // videoDurationSeconds (98) menor que windowStart (target-radio=99)
    // -- la ventana [99,98] queda invertida, duración <= 0.
    targetSeconds: 100.0, videoDurationSeconds: 98.0, maxDistanceSeconds: 1.0,
  });
  check("ventana degenerada por duración del video: no llama al detector", called === false);
  check("ventana degenerada: found=false", result.found === false);
  __setSilenceDetectorForTesting(null);
}

check("constante expuesta: SILENCE_SEARCH_RADIUS_SECONDS = 1.0", SILENCE_SEARCH_RADIUS_SECONDS === 1.0);

// --- refineCutsWithRealSilence: orquesta ambos bordes de cada corte ---

{
  // Ambos bordes encuentran una pausa real -- el corte usa los puntos
  // reales, incluso si caen afuera del rango "seguro por palabra"
  // original (precisión (a): ya no limitado por Whisper).
  __setSilenceDetectorForTesting(async ({ windowStart }) => {
    // Devuelve una pausa centrada en el punto pedido, sin importar
    // dónde cae la ventana -- simplifica el escenario de prueba.
    return fakeStderr((windowStart + 0.9).toFixed(2), (windowStart + 1.1).toFixed(2));
  });
  const logs = [];
  const { cuts, cutIssues } = await refineCutsWithRealSilence({
    cuts: [{ id: "ai-cut-0", startSeconds: 29.68, endSeconds: 30.71 }],
    videoPath: "fake.mp4", ffmpegPath: "fake", ffmpegEnv: {},
    log: (msg) => logs.push(msg),
  });
  check("ambos bordes con pausa real: el corte sobrevive", cuts.length === 1);
  check("ambos bordes con pausa real: sin cutIssues", cutIssues.length === 0);
  check("ambos bordes con pausa real: se logueó el desfase de cada borde", logs.some((l) => l.includes("desfase")));
  __setSilenceDetectorForTesting(null);
}

{
  // Un borde no encuentra pausa real -- se descarta el corte ENTERO
  // (precisión (a): "si no hay pausa, no cortes: conserva el audio").
  __setSilenceDetectorForTesting(async ({ windowStart }) => (windowStart < 20 ? "" : fakeStderr((windowStart + 0.1).toFixed(2), (windowStart + 0.3).toFixed(2))));
  const { cuts, cutIssues } = await refineCutsWithRealSilence({
    cuts: [{ id: "ai-cut-x", startSeconds: 10.0, endSeconds: 25.0 }],
    videoPath: "fake.mp4", ffmpegPath: "fake", ffmpegEnv: {},
  });
  check("un borde sin pausa real: el corte se descarta entero", cuts.length === 0);
  check("un borde sin pausa real: queda registrado en cutIssues", cutIssues.length === 1 && cutIssues[0].includes("ai-cut-x"));
  __setSilenceDetectorForTesting(null);
}

{
  // El análisis de audio falla (FFmpeg no disponible/archivo inexistente)
  // -- se conserva el audio (se descarta el corte), se registra.
  __setSilenceDetectorForTesting(async () => {
    throw new Error("ffmpeg no disponible (simulado)");
  });
  const logs = [];
  const { cuts, cutIssues } = await refineCutsWithRealSilence({
    cuts: [{ id: "ai-cut-y", startSeconds: 10.0, endSeconds: 11.0 }],
    videoPath: "fake.mp4", ffmpegPath: "fake", ffmpegEnv: {},
    log: (msg) => logs.push(msg),
  });
  check("falla el análisis: el corte se descarta (se conserva el audio)", cuts.length === 0);
  check("falla el análisis: queda registrado en cutIssues", cutIssues.some((i) => i.includes("ai-cut-y")));
  check("falla el análisis: también queda en el log", logs.some((l) => l.includes("falló")));
  __setSilenceDetectorForTesting(null);
}

{
  // Las pausas reales elegidas en cada borde terminan cruzadas
  // (inicio después del final) -- se descarta, nunca se deja un corte
  // invertido. refineCutsWithRealSilence llama primero al borde de
  // inicio y después al de final (orden fijo) -- se usa un contador
  // para responder distinto a cada uno sin depender de inferir la
  // ventana (start target=20.0 -> se le da una pausa tarde, 20.25-20.35;
  // end target=20.3 -> se le da una pausa temprana, 19.9-20.0 -- quedan
  // cruzadas: inicio elegido 20.3 > final elegido 19.95).
  let callCount = 0;
  __setSilenceDetectorForTesting(async () => {
    callCount++;
    return callCount === 1 ? fakeStderr("20.25", "20.35") : fakeStderr("19.9", "20.0");
  });
  const { cuts, cutIssues } = await refineCutsWithRealSilence({
    cuts: [{ id: "ai-cut-cross", startSeconds: 20.0, endSeconds: 20.5 }],
    videoPath: "fake.mp4", ffmpegPath: "fake", ffmpegEnv: {},
  });
  check("pausas cruzadas: el corte se descarta", cuts.length === 0);
  check("pausas cruzadas: queda registrado en cutIssues", cutIssues.some((i) => i.includes("cruzan")));
  __setSilenceDetectorForTesting(null);
}

console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
process.exit(failures === 0 ? 0 : 1);
