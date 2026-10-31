// PRUEBA SIMULADA -- no ejecuta FFmpeg real (igual que test-audio-analysis.mjs).
// Construye buffers WAV/PCM a mano para probar el parseo y las
// verificaciones PURAS (parseWavPcm, computeRmsProfileDb, checkDuration,
// checkAbnormalSilences, checkSplices, buildAudioExtractionArgs), e
// inyecta un "ejecutor de FFmpeg" falso (__setFfmpegRunnerForTesting,
// mismo patrón que __setSilenceDetectorForTesting en audio-analysis.mjs)
// para probar el CONTROL DE FLUJO de buildEditedAudioTrack/runQualityGate/
// runQualityGateWithRemediation sin invocar FFmpeg de verdad. El
// comportamiento REAL de `atrim`/`concat`/`pcm_s16le` contra el binario
// de producción se prueba en server/test-audio-regression.mjs (GitHub
// Actions, ver .github/workflows/audio-regression-tests.yml).
import fsp from "node:fs/promises";
import {
  parseWavPcm,
  computeRmsProfileDb,
  checkDuration,
  checkAbnormalSilences,
  checkSplices,
  buildAudioExtractionArgs,
  buildEditedAudioTrack,
  runQualityGate,
  runQualityGateWithRemediation,
  __setFfmpegRunnerForTesting,
} from "./quality-gate.mjs";

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

/** Construye un WAV PCM de 16 bits a mano (sin asumir que quien lo lea confíe en el tamaño declarado -- ver parseWavPcm). */
const buildWav = ({ sampleRate = 1000, numChannels = 1, samples }) => {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * numChannels * bytesPerSample, 28);
  buffer.writeUInt16LE(numChannels * bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i++) {
    buffer.writeInt16LE(samples[i], 44 + i * 2);
  }
  return buffer;
};

// --- parseWavPcm ---

{
  const samples = [100, -100, 200, -200, 300];
  const buffer = buildWav({ sampleRate: 16000, numChannels: 1, samples });
  const wav = parseWavPcm(buffer);
  check("parseWavPcm: sampleRate correcto", wav.sampleRate === 16000);
  check("parseWavPcm: numChannels correcto", wav.numChannels === 1);
  check("parseWavPcm: bitsPerSample correcto", wav.bitsPerSample === 16);
  check("parseWavPcm: tamaño del PCM correcto", wav.pcm.length === samples.length * 2);
  check("parseWavPcm: primer sample correcto", wav.pcm.readInt16LE(0) === 100);
  check("parseWavPcm: último sample correcto", wav.pcm.readInt16LE(8) === 300);
}

{
  check("parseWavPcm: sin cabecera RIFF/WAVE -- lanza error", (() => {
    try {
      parseWavPcm(Buffer.from("esto no es un wav"));
      return false;
    } catch {
      return true;
    }
  })());
}

{
  // El chunk "data" miente sobre su tamaño (más grande que lo que
  // realmente hay en el buffer) -- precisión original del operador:
  // no confiar en el tamaño declarado. Se usa lo que de verdad cabe.
  const samples = [1, 2, 3, 4];
  const buffer = buildWav({ samples });
  buffer.writeUInt32LE(0xffffffff, 40); // dataSize mentido
  const wav = parseWavPcm(buffer);
  check("parseWavPcm: dataSize mentido -- usa el tamaño real disponible, no se cae", wav.pcm.length === samples.length * 2);
}

// --- computeRmsProfileDb ---

{
  const samples = new Array(30).fill(0); // silencio digital total
  const wav = { pcm: buildWav({ sampleRate: 1000, samples }).subarray(44), sampleRate: 1000, numChannels: 1, bitsPerSample: 16 };
  const profile = computeRmsProfileDb(wav, 10); // 10ms -> 10 samples/cuadro, 3 cuadros
  check("computeRmsProfileDb: silencio total -- todos los cuadros en -Infinity", profile.framesDb.every((db) => db === -Infinity));
  check("computeRmsProfileDb: cantidad de cuadros correcta", profile.framesDb.length === 3);
}

{
  const loud = new Array(10).fill(32767); // máxima amplitud posible
  const wav = { pcm: buildWav({ sampleRate: 1000, samples: loud }).subarray(44), sampleRate: 1000, numChannels: 1, bitsPerSample: 16 };
  const profile = computeRmsProfileDb(wav, 10);
  check("computeRmsProfileDb: amplitud máxima constante -- cerca de 0dB", approx(profile.framesDb[0], 0, 0.1));
}

{
  check("computeRmsProfileDb: rechaza algo que no sea 16 bits", (() => {
    try {
      computeRmsProfileDb({ pcm: Buffer.alloc(4), sampleRate: 1000, numChannels: 1, bitsPerSample: 8 });
      return false;
    } catch {
      return true;
    }
  })());
}

// --- checkDuration ---

{
  check("checkDuration: dentro de tolerancia -- ok", checkDuration(44.667, 44.667, 0.1).ok === true);
  check("checkDuration: fuera de tolerancia -- falla", checkDuration(44.667, 44.9, 0.1).ok === false);
  check("checkDuration: deltaSeconds con signo correcto", approx(checkDuration(44.9, 44.667).deltaSeconds, 0.233));
}

// --- checkAbnormalSilences ---

{
  // 500ms de silencio en medio de una pista normal -- por debajo del
  // límite por defecto (2.5s), no se marca.
  const frameMs = 10;
  const framesDb = [-10, -10, ...new Array(50).fill(-50), -10, -10]; // 50 cuadros * 10ms = 500ms
  const result = checkAbnormalSilences({ framesDb, frameMs });
  check("checkAbnormalSilences: silencio corto (500ms) -- no se marca", result.ok === true);
}

{
  // 3s de silencio -- por encima del límite (2.5s por defecto), se marca.
  const frameMs = 10;
  const framesDb = [-10, -10, ...new Array(300).fill(-50), -10, -10]; // 300 cuadros * 10ms = 3s
  const result = checkAbnormalSilences({ framesDb, frameMs });
  check("checkAbnormalSilences: silencio largo (3s) -- se marca", result.ok === false && result.issues.length === 1);
  check("checkAbnormalSilences: duración del silencio detectado correcta", approx(result.issues[0].durationSeconds, 3.0));
}

// --- checkSplices ---

{
  // Empalme sano: alrededor del punto de corte (en tiempo de SALIDA)
  // hay un tramo silencioso (como corresponde, si se cortó dentro de
  // una pausa real confirmada) y SIN salto brusco de muestra.
  const sampleRate = 48000;
  const frameMs = 10;
  const frameSamples = 480; // sampleRate*frameMs/1000
  const quietHalfSamples = 10 * frameSamples; // +-100ms de sobra, más ancho que la ventana de revisión de checkSplices (+-60ms)
  const spliceSample = 4 * sampleRate; // empalme en el segundo 4.0
  const samples = new Array(8 * sampleRate).fill(16000); // pista "ruidosa" en general
  for (let i = spliceSample - quietHalfSamples; i < spliceSample + quietHalfSamples; i++) samples[i] = 5; // pausa real
  const pcm = buildWav({ sampleRate, samples }).subarray(44);
  const profile = computeRmsProfileDb({ pcm, sampleRate, numChannels: 1, bitsPerSample: 16 }, frameMs);
  const result = checkSplices({ pcm, sampleRate, numChannels: 1, framesDb: profile.framesDb, frameMs }, [4.0]);
  check("checkSplices: empalme silencioso y sin salto -- sin defectos", result.ok === true);
}

{
  // Empalme defectuoso tipo A: la zona alrededor NO está silenciosa
  // (la pausa elegida pudo no haber sido real).
  const sampleRate = 48000;
  const frameMs = 10;
  const samples = new Array(8 * sampleRate).fill(16000); // ruidoso en TODAS partes, incluido el empalme
  const pcm = buildWav({ sampleRate, samples }).subarray(44);
  const profile = computeRmsProfileDb({ pcm, sampleRate, numChannels: 1, bitsPerSample: 16 }, frameMs);
  const result = checkSplices({ pcm, sampleRate, numChannels: 1, framesDb: profile.framesDb, frameMs }, [4.0]);
  check("checkSplices: zona del empalme no silenciosa -- se marca 'not-quiet'", result.ok === false && result.issues.some((i) => i.type === "not-quiet"));
}

{
  // Empalme defectuoso tipo B: la zona alrededor SÍ está silenciosa en
  // promedio por cuadro, pero hay un salto brusco de amplitud justo en
  // la muestra exacta del corte -- suena como un clic aunque el
  // análisis por cuadro no lo note.
  const sampleRate = 48000;
  const frameMs = 10;
  const frameSamples = 480;
  const quietHalfSamples = 10 * frameSamples; // +-100ms, más ancho que la ventana de revisión (+-60ms)
  const spliceSample = 4 * sampleRate;
  const samples = new Array(8 * sampleRate).fill(16000);
  for (let i = spliceSample - quietHalfSamples; i < spliceSample + quietHalfSamples; i++) samples[i] = 0;
  samples[spliceSample] = Math.round(0.4 * 32768); // salto puntual justo en el empalme
  const pcm = buildWav({ sampleRate, samples }).subarray(44);
  const profile = computeRmsProfileDb({ pcm, sampleRate, numChannels: 1, bitsPerSample: 16 }, frameMs);
  const result = checkSplices({ pcm, sampleRate, numChannels: 1, framesDb: profile.framesDb, frameMs }, [4.0]);
  check("checkSplices: salto brusco puntual en el empalme -- se marca 'sample-jump'", result.ok === false && result.issues.some((i) => i.type === "sample-jump"));
  check("checkSplices: ese mismo tramo sigue viéndose silencioso por cuadro (no se confunde con 'not-quiet')", !result.issues.some((i) => i.type === "not-quiet"));
}

// --- buildAudioExtractionArgs ---

{
  const timeline = { segments: [{ sourceStart: 0, sourceEnd: 4, outputStart: 0, outputEnd: 4 }], outputDurationInSeconds: 4 };
  const args = buildAudioExtractionArgs("video.mp4", timeline, "out.wav");
  const filterArg = args[args.indexOf("-filter_complex") + 1];
  check("buildAudioExtractionArgs: 1 solo tramo -- filtro termina en [outa] sin concat", filterArg.includes("[outa]") && !filterArg.includes("concat"));
  check("buildAudioExtractionArgs: usa el muxer wav y el encoder pcm_s16le (confirmados en producción)", args.includes("pcm_s16le") && args.includes("wav"));
}

{
  const timeline = {
    segments: [
      { sourceStart: 0, sourceEnd: 4, outputStart: 0, outputEnd: 4 },
      { sourceStart: 6, sourceEnd: 10, outputStart: 4, outputEnd: 8 },
    ],
    outputDurationInSeconds: 8,
  };
  const args = buildAudioExtractionArgs("video.mp4", timeline, "out.wav");
  const filterArg = args[args.indexOf("-filter_complex") + 1];
  check("buildAudioExtractionArgs: 2 tramos -- usa concat con n=2", filterArg.includes("concat=n=2:v=0:a=1[outa]"));
  check("buildAudioExtractionArgs: recorta el segundo tramo en 6-10 (tiempo ORIGINAL, no de salida)", filterArg.includes("atrim=start=6.000000:end=10.000000"));
}

// --- buildEditedAudioTrack / runQualityGate: con un ejecutor de FFmpeg inyectado ---

const makeCleanTrackWav = (durationSeconds, spliceOffsetsSeconds) => {
  const sampleRate = 8000;
  const frameSamples = 80; // 10ms
  const total = Math.round(durationSeconds * sampleRate);
  const samples = new Array(total).fill(12000);
  for (const offsetSeconds of spliceOffsetsSeconds) {
    const spliceSample = Math.round(offsetSeconds * sampleRate);
    for (let i = Math.max(0, spliceSample - 10 * frameSamples); i < Math.min(total, spliceSample + 10 * frameSamples); i++) samples[i] = 3;
  }
  return buildWav({ sampleRate, samples });
};

{
  // Pista editada sana: duración correcta, empalme limpio -- runQualityGate da ok=true.
  __setFfmpegRunnerForTesting(async (_ffmpegPath, _ffmpegEnv, args) => {
    const outputPath = args[args.length - 1];
    await fsp.writeFile(outputPath, makeCleanTrackWav(8, [4.0]));
  });
  const result = await runQualityGate({
    ffmpegPath: "fake", ffmpegEnv: {}, videoPath: "fake.mp4",
    cuts: [{ id: "ai-cut-1", startSeconds: 4, endSeconds: 6 }],
    videoDurationSeconds: 10,
  });
  check("runQualityGate: pista sana -- ok=true", result.ok === true);
  check("runQualityGate: 1 empalme verificado", result.spliceCount === 1);
  __setFfmpegRunnerForTesting(null);
}

{
  // Sin cortes: nada que armar -- ok=true trivialmente, sin invocar FFmpeg.
  let called = false;
  __setFfmpegRunnerForTesting(async () => {
    called = true;
  });
  const result = await runQualityGate({ ffmpegPath: "fake", ffmpegEnv: {}, videoPath: "fake.mp4", cuts: [], videoDurationSeconds: 10 });
  check("runQualityGate: sin cortes -- ok=true sin invocar FFmpeg", result.ok === true && called === false);
  __setFfmpegRunnerForTesting(null);
}

{
  // La pista editada construida NO tiene la duración esperada (algo salió mal en el armado) -- se marca.
  __setFfmpegRunnerForTesting(async (_ffmpegPath, _ffmpegEnv, args) => {
    const outputPath = args[args.length - 1];
    await fsp.writeFile(outputPath, makeCleanTrackWav(7.0, [4.0])); // debería ser 8s, no 7s
  });
  const result = await runQualityGate({
    ffmpegPath: "fake", ffmpegEnv: {}, videoPath: "fake.mp4",
    cuts: [{ id: "ai-cut-1", startSeconds: 4, endSeconds: 6 }],
    videoDurationSeconds: 10,
  });
  check("runQualityGate: duración incorrecta -- ok=false", result.ok === false && result.durationCheck.ok === false);
  __setFfmpegRunnerForTesting(null);
}

// --- runQualityGateWithRemediation: corrige, descarta o se detiene ---

{
  // El primer empalme falla (zona ruidosa), pero el corte trae un
  // segundo candidato real (de refineCutsWithRealSilence) que sí
  // produce un empalme limpio -- se corrige SIN descartar el corte.
  let attempt = 0;
  __setFfmpegRunnerForTesting(async (_ffmpegPath, _ffmpegEnv, args) => {
    attempt++;
    const outputPath = args[args.length - 1];
    // El primer intento (usando el borde "candidato 0") sale defectuoso;
    // a partir del segundo (ya con el "candidato 1"), sale limpio.
    const sampleRate = 8000;
    const total = Math.round(8 * sampleRate);
    const samples = new Array(total).fill(12000);
    if (attempt === 1) {
      // sin pausa real: el empalme queda en una zona ruidosa.
    } else {
      const spliceSample = Math.round(4.0 * sampleRate);
      for (let i = Math.max(0, spliceSample - 2000); i < Math.min(total, spliceSample + 2000); i++) samples[i] = 3;
    }
    await fsp.writeFile(outputPath, buildWav({ sampleRate, samples }));
  });
  const cut = {
    id: "ai-cut-1",
    startSeconds: 4.0,
    endSeconds: 6.0,
    _startCandidates: [{ chosenSeconds: 4.0 }, { chosenSeconds: 4.05 }],
    _endCandidates: [{ chosenSeconds: 6.0 }],
  };
  const result = await runQualityGateWithRemediation({
    ffmpegPath: "fake", ffmpegEnv: {}, videoPath: "fake.mp4", cuts: [cut], videoDurationSeconds: 10,
  });
  check("remediación: se corrige con el siguiente candidato -- ok=true", result.ok === true);
  check("remediación: el corte SOBREVIVE (no se descartó)", result.cuts.length === 1);
  check("remediación: tardó más de 1 ronda", result.rounds > 1);
  check("remediación: quedó un incidente registrado", result.incidents.length > 0);
  check("remediación: los cortes devueltos no exponen los candidatos internos", result.cuts[0]._startCandidates === undefined);
  __setFfmpegRunnerForTesting(null);
}

{
  // El empalme falla y NO hay ningún candidato alternativo -- se
  // descarta el corte (no queda nada que armar: 0 cortes -> sano).
  __setFfmpegRunnerForTesting(async (_ffmpegPath, _ffmpegEnv, args) => {
    const outputPath = args[args.length - 1];
    const sampleRate = 8000;
    const samples = new Array(Math.round(8 * sampleRate)).fill(12000); // siempre ruidoso, nunca sana
    await fsp.writeFile(outputPath, buildWav({ sampleRate, samples }));
  });
  const cut = {
    id: "ai-cut-sin-alternativa",
    startSeconds: 4.0,
    endSeconds: 6.0,
    _startCandidates: [{ chosenSeconds: 4.0 }],
    _endCandidates: [{ chosenSeconds: 6.0 }],
  };
  const result = await runQualityGateWithRemediation({
    ffmpegPath: "fake", ffmpegEnv: {}, videoPath: "fake.mp4", cuts: [cut], videoDurationSeconds: 10,
  });
  check("remediación sin alternativa: se descarta el corte y el resultado final es sano", result.ok === true);
  check("remediación sin alternativa: el corte NO sobrevive", result.cuts.length === 0);
  check("remediación sin alternativa: queda registrado que se descartó", result.incidents.some((i) => i.includes("se descarta")));
  __setFfmpegRunnerForTesting(null);
}

{
  // Defecto no atado a un empalme (silencio anormal en medio de un
  // tramo que no se cortó) -- no hay "siguiente candidato" que
  // intentar; se detiene con un motivo explícito, sin inventar una
  // corrección.
  __setFfmpegRunnerForTesting(async (_ffmpegPath, _ffmpegEnv, args) => {
    const outputPath = args[args.length - 1];
    const sampleRate = 8000;
    const total = Math.round(8 * sampleRate);
    const samples = new Array(total).fill(12000);
    // El empalme (en 4.0s) sale limpio -- zona silenciosa a su alrededor,
    // como en los demás escenarios sanos.
    const spliceSample = Math.round(4.0 * sampleRate);
    for (let i = Math.max(0, spliceSample - 2000); i < Math.min(total, spliceSample + 2000); i++) samples[i] = 3;
    // 3s de silencio anormal bien lejos del empalme: termina en 3.5s,
    // dejando 500ms de audio normal antes de la zona silenciosa del
    // empalme -- así el ÚNICO defecto es este silencio aislado.
    for (let i = Math.round(0.5 * sampleRate); i < Math.round(3.5 * sampleRate); i++) samples[i] = 0;
    await fsp.writeFile(outputPath, buildWav({ sampleRate, samples }));
  });
  const cut = { id: "ai-cut-1", startSeconds: 4.0, endSeconds: 6.0, _startCandidates: [{ chosenSeconds: 4.0 }], _endCandidates: [{ chosenSeconds: 6.0 }] };
  const result = await runQualityGateWithRemediation({
    ffmpegPath: "fake", ffmpegEnv: {}, videoPath: "fake.mp4", cuts: [cut], videoDurationSeconds: 10,
  });
  check("defecto no atribuible a un empalme: se detiene (ok=false)", result.ok === false);
  check("defecto no atribuible a un empalme: motivo explícito registrado", typeof result.stoppedReason === "string" && result.stoppedReason.length > 0);
  check("defecto no atribuible a un empalme: se detuvo en la primera ronda (no reintentó sin sentido)", result.rounds === 1);
  __setFfmpegRunnerForTesting(null);
}

console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
process.exit(failures === 0 ? 0 : 1);
