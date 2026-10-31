// PRUEBA SIMULADA -- no llama a FFmpeg real. Prueba la lógica PURA de
// parseo/decisión (parseSilenceDetectOutput, findNearestRealPause,
// rankPauseCandidates, findSafeEdgeInMap) con texto de stderr
// sintético, y el CONTROL DE FLUJO de computeFullPauseMap/
// refineCutsWithRealSilence inyectando un detector de silencios falso
// (__setSilenceDetectorForTesting, mismo patrón que
// __setAnthropicClientForTesting en editorial.mjs). La prueba de
// FFmpeg real contra el mismo binario/imagen que producción vive en
// server/test-audio-regression.mjs (corre en GitHub Actions, ver
// .github/workflows/audio-regression-tests.yml) -- este archivo cubre
// la lógica, aquel cubre el comportamiento real de FFmpeg.
import {
  parseSilenceDetectOutput,
  findNearestRealPause,
  rankPauseCandidates,
  findSafeEdgeInMap,
  computeFullPauseMap,
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

// --- rankPauseCandidates / findSafeEdgeInMap: búsqueda en el mapa ya calculado ---

{
  const intervals = [{ start: 10.0, end: 10.2 }, { start: 29.2, end: 29.4 }, { start: 30.6, end: 30.9 }];
  const ranked = rankPauseCandidates(intervals, 29.5);
  check("rankPauseCandidates: devuelve los 3, ordenados por distancia", ranked.length === 3 && ranked[0].interval.start === 29.2 && ranked[1].interval.start === 30.6);
}

{
  check("rankPauseCandidates: lista vacía con intervals vacío", rankPauseCandidates([], 10).length === 0);
}

{
  const map = { intervals: [{ start: 29.2, end: 29.4 }, { start: 30.6, end: 30.9 }] };
  const result = findSafeEdgeInMap(map, 29.5, 1.0);
  check("findSafeEdgeInMap: found=true con el candidato más cercano", result.found === true && approx(result.seconds, 29.3));
}

{
  const map = { intervals: [{ start: 29.2, end: 29.4 }, { start: 30.6, end: 30.9 }] };
  const result = findSafeEdgeInMap(map, 29.5, 0.05); // ninguno cae dentro de 50ms
  check("findSafeEdgeInMap: found=false si ningún candidato entra en la distancia máxima", result.found === false);
}

{
  // skip=1: pide el SEGUNDO candidato (para "la siguiente pausa
  // candidata" que usa la puerta de calidad cuando el primero falla
  // su propia verificación).
  const map = { intervals: [{ start: 29.2, end: 29.4 }, { start: 29.6, end: 29.9 }, { start: 35.0, end: 35.2 }] };
  const first = findSafeEdgeInMap(map, 29.5, 1.0, 0);
  const second = findSafeEdgeInMap(map, 29.5, 1.0, 1);
  check("findSafeEdgeInMap: skip=0 elige el más cercano", approx(first.seconds, 29.3));
  check("findSafeEdgeInMap: skip=1 elige el segundo más cercano, no el mismo", approx(second.seconds, 29.75) && second.seconds !== first.seconds);
}

check("constante expuesta: SILENCE_SEARCH_RADIUS_SECONDS = 1.0", SILENCE_SEARCH_RADIUS_SECONDS === 1.0);

// --- computeFullPauseMap: UNA sola llamada al detector sobre todo el video ---

{
  let calls = 0;
  let receivedWindow = null;
  __setSilenceDetectorForTesting(async ({ windowStart, windowDuration }) => {
    calls++;
    receivedWindow = { windowStart, windowDuration };
    return fakeStderr("29.68", "30.24") + fakeStderr("109.1", "109.9");
  });
  const map = await computeFullPauseMap({ ffmpegPath: "fake", ffmpegEnv: {}, videoPath: "fake.mp4", videoDurationSeconds: 759.27 });
  check("computeFullPauseMap: UNA sola llamada al detector (no una por borde)", calls === 1);
  check("computeFullPauseMap: la ventana pedida cubre TODO el video (0 a la duración completa)", receivedWindow.windowStart === 0 && receivedWindow.windowDuration === 759.27);
  check("computeFullPauseMap: se parsean los 2 intervalos reportados", map.intervals.length === 2);
  __setSilenceDetectorForTesting(null);
}

// --- refineCutsWithRealSilence: calcula el mapa UNA vez y lo reutiliza para todos los cortes ---

{
  // Ambos bordes de los DOS cortes encuentran pausa real en el MISMO
  // mapa -- precisión (a): ya no limitado por el rango "seguro por
  // palabra" de Whisper. Un solo llamado al detector para ambos cortes
  // (antes: hasta 4 llamadas, una por borde).
  let calls = 0;
  __setSilenceDetectorForTesting(async () => {
    calls++;
    return fakeStderr("29.58", "29.78") + fakeStderr("30.6", "30.82") + fakeStderr("49.9", "50.1") + fakeStderr("54.9", "55.1");
  });
  const logs = [];
  const { cuts, cutIssues, pauseMap } = await refineCutsWithRealSilence({
    cuts: [
      { id: "ai-cut-0", startSeconds: 29.68, endSeconds: 30.71 },
      { id: "ai-cut-1", startSeconds: 50.0, endSeconds: 55.0 },
    ],
    videoPath: "fake.mp4", ffmpegPath: "fake", ffmpegEnv: {}, videoDurationSeconds: 759.27,
    log: (msg) => logs.push(msg),
  });
  check("refineCutsWithRealSilence: una sola llamada al detector para TODOS los cortes", calls === 1);
  check("ambos cortes con ambos bordes con pausa real: los dos sobreviven", cuts.length === 2);
  check("ambos cortes con pausa real: sin cutIssues", cutIssues.length === 0);
  check("ambos cortes con pausa real: se logueó el desfase de cada borde", logs.some((l) => l.includes("desfase")));
  check("refineCutsWithRealSilence: expone el mapa calculado para reutilizarlo (diagnóstico/puerta de calidad)", pauseMap && pauseMap.intervals.length === 4);
  check("cada corte conserva sus candidatos por borde (para la puerta de calidad)", Array.isArray(cuts[0]._startCandidates) && Array.isArray(cuts[0]._endCandidates));
  __setSilenceDetectorForTesting(null);
}

{
  // Un borde no encuentra pausa real -- se descarta el corte ENTERO
  // (precisión (a): "si no hay pausa, no cortes: conserva el audio").
  // Solo hay una pausa real en todo el "video" (24.9-25.1) -- el borde
  // final (25.0) la encuentra, el de inicio (10.0) no tiene nada cerca.
  __setSilenceDetectorForTesting(async () => fakeStderr("24.9", "25.1"));
  const { cuts, cutIssues } = await refineCutsWithRealSilence({
    cuts: [{ id: "ai-cut-x", startSeconds: 10.0, endSeconds: 25.0 }],
    videoPath: "fake.mp4", ffmpegPath: "fake", ffmpegEnv: {}, videoDurationSeconds: 100,
  });
  check("un borde sin pausa real: el corte se descarta entero", cuts.length === 0);
  check("un borde sin pausa real: queda registrado en cutIssues", cutIssues.length === 1 && cutIssues[0].includes("ai-cut-x"));
}

{
  // El análisis de audio falla (FFmpeg no disponible/archivo inexistente)
  // -- se conservan TODOS los cortes propuestos (se descartan), se registra.
  __setSilenceDetectorForTesting(async () => {
    throw new Error("ffmpeg no disponible (simulado)");
  });
  const logs = [];
  const { cuts, cutIssues, pauseMap } = await refineCutsWithRealSilence({
    cuts: [{ id: "ai-cut-y", startSeconds: 10.0, endSeconds: 11.0 }],
    videoPath: "fake.mp4", ffmpegPath: "fake", ffmpegEnv: {}, videoDurationSeconds: 100,
    log: (msg) => logs.push(msg),
  });
  check("falla el cálculo del mapa: el corte se descarta (se conserva el audio)", cuts.length === 0);
  check("falla el cálculo del mapa: queda registrado en cutIssues", cutIssues.some((i) => i.includes("ai-cut-y")));
  check("falla el cálculo del mapa: también queda en el log", logs.some((l) => l.includes("falló")));
  check("falla el cálculo del mapa: pauseMap queda en null", pauseMap === null);
  __setSilenceDetectorForTesting(null);
}

{
  // Un corte muy corto cuyos DOS bordes terminan resolviendo a la MISMA
  // pausa real (único candidato cercano a ambos) -- los dos convergen
  // en su centro (20.3s), dejando un corte de largo <= 0. Se descarta,
  // nunca se deja un corte invertido o vacío.
  __setSilenceDetectorForTesting(async () => fakeStderr("20.25", "20.35"));
  const { cuts, cutIssues } = await refineCutsWithRealSilence({
    cuts: [{ id: "ai-cut-cross", startSeconds: 20.0, endSeconds: 20.6 }],
    videoPath: "fake.mp4", ffmpegPath: "fake", ffmpegEnv: {}, videoDurationSeconds: 100,
  });
  check("pausas convergentes: el corte se descarta", cuts.length === 0);
  check("pausas convergentes: queda registrado en cutIssues", cutIssues.some((i) => i.includes("cruzan")));
  __setSilenceDetectorForTesting(null);
}

console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
process.exit(failures === 0 ? 0 : 1);
