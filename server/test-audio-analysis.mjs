// PRUEBA SIMULADA -- no llama a FFmpeg real (no hay uno funcional en
// este entorno de desarrollo, ver informe). Prueba la lógica PURA de
// análisis de energía (computeRmsProfile, findAcousticPausePoint) con
// buffers PCM y perfiles sintéticos, y el CONTROL DE FLUJO de
// refineEdgeAcoustically/refineCutsAcoustically inyectando un extractor
// PCM falso (__setPcmExtractorForTesting, mismo patrón que
// __setAnthropicClientForTesting en editorial.mjs) -- la invocación
// REAL de FFmpeg dentro del extractor de verdad (realExtractPcmWindow)
// queda sin probar acá a propósito, revisada por lectura cuidadosa en
// vez de ejecución.
import {
  computeRmsProfile,
  findAcousticPausePoint,
  refineEdgeAcoustically,
  refineCutsAcoustically,
  __setPcmExtractorForTesting,
  PAUSE_RELATIVE_DROP_DB,
  PAUSE_MIN_SUSTAINED_MS,
} from "./audio-analysis.mjs";

let failures = 0;
const approx = (a, b, eps = 0.05) => Math.abs(a - b) < eps;
const check = (label, cond) => {
  if (!cond) {
    failures++;
    console.log(`FAIL: ${label}`);
  } else {
    console.log(`ok: ${label}`);
  }
};

/** Construye un buffer PCM s16le mono de `durationMs` con amplitud constante. */
const pcmFrame = (amplitude, durationMs, sampleRate = 16000) => {
  const sampleCount = Math.round((sampleRate * durationMs) / 1000);
  const buf = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i++) {
    buf.writeInt16LE(amplitude, i * 2);
  }
  return buf;
};

const concatPcm = (...buffers) => Buffer.concat(buffers);

// --- computeRmsProfile ---

{
  const silence = pcmFrame(0, 10);
  const profile = computeRmsProfile(silence, 0);
  check("silencio absoluto: 1 frame de 10ms", profile.length === 1);
  check("silencio absoluto: db en el piso (-96)", profile[0].db === -96);
}

{
  const full = pcmFrame(32767, 10);
  const profile = computeRmsProfile(full, 0);
  check("amplitud máxima constante: db cercano a 0", approx(profile[0].db, 0, 0.1));
}

{
  const half = pcmFrame(16384, 10);
  const profile = computeRmsProfile(half, 0);
  // 20*log10(16384/32768) = 20*log10(0.5) ≈ -6.02dB
  check("amplitud a la mitad: db ≈ -6.02", approx(profile[0].db, -6.02));
}

{
  const buf = concatPcm(pcmFrame(30000, 10), pcmFrame(30000, 10));
  const profile = computeRmsProfile(buf, 5.0);
  check("offsetSeconds: el primer frame empieza en el tiempo de ventana dado", profile[0].offsetSeconds === 5.0);
  check("offsetSeconds: el segundo frame está 10ms después", approx(profile[1].offsetSeconds, 5.01));
}

// --- findAcousticPausePoint ---

{
  // Pausa real: 5 frames de silencio (50ms, sostenido) en medio de voz
  // fuerte -- debe encontrarse.
  const profile = [
    { offsetSeconds: 0.0, db: -10 },
    { offsetSeconds: 0.01, db: -10 },
    { offsetSeconds: 0.02, db: -40 }, // empieza la pausa
    { offsetSeconds: 0.03, db: -42 },
    { offsetSeconds: 0.04, db: -45 }, // la más silenciosa
    { offsetSeconds: 0.05, db: -41 },
    { offsetSeconds: 0.06, db: -40 }, // termina la pausa
    { offsetSeconds: 0.07, db: -10 },
    { offsetSeconds: 0.08, db: -10 },
  ];
  const point = findAcousticPausePoint(profile);
  check("pausa real sostenida: se encuentra un punto", point !== null);
  check("pausa real: el punto elegido es el más silencioso del tramo (0.04, -45dB)", point === 0.04);
}

{
  // Caída breve de un solo frame (p.ej. dentro de una consonante) --
  // NO cuenta como pausa real (requisito 5 del dictamen).
  const profile = [
    { offsetSeconds: 0.0, db: -10 },
    { offsetSeconds: 0.01, db: -10 },
    { offsetSeconds: 0.02, db: -30 }, // un solo frame bajo, no sostenido
    { offsetSeconds: 0.03, db: -10 },
    { offsetSeconds: 0.04, db: -10 },
  ];
  const point = findAcousticPausePoint(profile);
  check("caída de un solo frame (no sostenida): no se confunde con una pausa real", point === null);
}

{
  // Caída sostenida pero poco profunda (menos de 12dB bajo el pico) --
  // tampoco cuenta: podría ser el valle normal entre dos vocales, no
  // una pausa real entre palabras.
  const profile = [
    { offsetSeconds: 0.0, db: -10 },
    { offsetSeconds: 0.01, db: -10 },
    { offsetSeconds: 0.02, db: -16 }, // solo 6dB bajo el pico, no 12
    { offsetSeconds: 0.03, db: -16 },
    { offsetSeconds: 0.04, db: -16 },
    { offsetSeconds: 0.05, db: -10 },
  ];
  const point = findAcousticPausePoint(profile);
  check("caída sostenida pero poco profunda (<12dB bajo el pico): no se toma como pausa", point === null);
}

{
  // Todo fuerte, sin ningún mínimo real -- requisito 8: sin punto
  // seguro, no se inventa uno.
  const profile = [
    { offsetSeconds: 0.0, db: -8 },
    { offsetSeconds: 0.01, db: -9 },
    { offsetSeconds: 0.02, db: -8 },
    { offsetSeconds: 0.03, db: -9 },
  ];
  check("sin ningún mínimo real en toda la ventana: devuelve null, no inventa un punto", findAcousticPausePoint(profile) === null);
}

{
  // Dos tramos silenciosos de distinta duración -- se elige el más
  // largo (el que con más confianza es una pausa real), no el primero.
  const profile = [
    { offsetSeconds: 0.00, db: -10 },
    { offsetSeconds: 0.01, db: -40 }, // tramo corto (10ms) -- no llega al mínimo sostenido
    { offsetSeconds: 0.02, db: -10 },
    { offsetSeconds: 0.03, db: -10 },
    { offsetSeconds: 0.04, db: -41 }, // tramo largo (50ms) -- este es el que debería elegirse
    { offsetSeconds: 0.05, db: -43 },
    { offsetSeconds: 0.06, db: -50 },
    { offsetSeconds: 0.07, db: -42 },
    { offsetSeconds: 0.08, db: -41 },
    { offsetSeconds: 0.09, db: -10 },
  ];
  const point = findAcousticPausePoint(profile);
  check("dos tramos silenciosos: se elige el tramo más largo (sostenido), no el primero", point === 0.06);
}

{
  check("constantes expuestas: PAUSE_RELATIVE_DROP_DB = 12", PAUSE_RELATIVE_DROP_DB === 12);
  check("constantes expuestas: PAUSE_MIN_SUSTAINED_MS = 30", PAUSE_MIN_SUSTAINED_MS === 30);
}

{
  // Perfil vacío: no explota, devuelve null.
  check("perfil vacío: devuelve null sin lanzar error", findAcousticPausePoint([]) === null);
}

/** PCM de `durationSeconds` con un tramo silencioso centrado (loud-quiet-loud). */
const buildPausePatternPcm = (durationSeconds, { loudAmp = 30000, quietAmp = 50 } = {}) => {
  const totalMs = durationSeconds * 1000;
  const thirdMs = totalMs / 3;
  return concatPcm(pcmFrame(loudAmp, thirdMs), pcmFrame(quietAmp, thirdMs), pcmFrame(loudAmp, totalMs - 2 * thirdMs));
};

/** PCM de `durationSeconds` todo fuerte -- sin ninguna pausa real. */
const buildAllLoudPcm = (durationSeconds, amp = 30000) => pcmFrame(amp, durationSeconds * 1000);

// --- refineEdgeAcoustically: control de flujo con FFmpeg simulado ---

{
  __setPcmExtractorForTesting(async ({ startSeconds, durationSeconds }) => buildPausePatternPcm(durationSeconds));
  const result = await refineEdgeAcoustically({
    ffmpegPath: "fake", ffmpegEnv: {}, videoPath: "fake.mp4",
    wordSafeSeconds: 30.0, safeMin: 29.5, safeMax: 30.5,
  });
  check("pausa real encontrada: refined=true", result.refined === true);
  check("pausa real encontrada: el punto elegido cae dentro del tramo silencioso (centro de la ventana)", result.seconds > 29.5 && result.seconds < 30.5);
  check("pausa real encontrada: devuelve el perfil completo", result.profile.length > 0);
  __setPcmExtractorForTesting(null);
}

{
  __setPcmExtractorForTesting(async ({ durationSeconds }) => buildAllLoudPcm(durationSeconds));
  const result = await refineEdgeAcoustically({
    ffmpegPath: "fake", ffmpegEnv: {}, videoPath: "fake.mp4",
    wordSafeSeconds: 30.0, safeMin: 29.5, safeMax: 30.5,
  });
  check("sin pausa real (todo fuerte): refined=false", result.refined === false);
  check("sin pausa real: cae al límite seguro por palabra (wordSafeSeconds), no inventa un punto", result.seconds === 30.0);
  __setPcmExtractorForTesting(null);
}

{
  // safeMin === safeMax (sin ventana real para buscar) -- ni se llama
  // al extractor, cae directo al límite seguro por palabra.
  let called = false;
  __setPcmExtractorForTesting(async () => {
    called = true;
    return buildAllLoudPcm(0.1);
  });
  const result = await refineEdgeAcoustically({
    ffmpegPath: "fake", ffmpegEnv: {}, videoPath: "fake.mp4",
    wordSafeSeconds: 30.0, safeMin: 30.0, safeMax: 30.0,
  });
  check("ventana de búsqueda vacía: no llama al extractor en absoluto", called === false);
  check("ventana de búsqueda vacía: devuelve el límite seguro sin tocar", result.seconds === 30.0 && result.refined === false);
  __setPcmExtractorForTesting(null);
}

{
  // El extractor (FFmpeg) falla -- se captura, no se propaga, no se
  // inventa un punto: se usa el límite seguro por palabra.
  __setPcmExtractorForTesting(async () => {
    throw new Error("ffmpeg no encontrado (simulado)");
  });
  let threw = false;
  let result;
  try {
    result = await refineEdgeAcoustically({
      ffmpegPath: "fake", ffmpegEnv: {}, videoPath: "fake.mp4",
      wordSafeSeconds: 30.0, safeMin: 29.5, safeMax: 30.5,
    });
  } catch {
    threw = true;
  }
  check("si FFmpeg falla, refineEdgeAcoustically SÍ propaga el error (lo maneja quien lo llama, no acá)", threw === true);
  __setPcmExtractorForTesting(null);
}

// --- refineCutsAcoustically: orquesta ambos bordes de cada corte ---

{
  // Ambos bordes encuentran una pausa real -- el corte final usa los
  // puntos refinados, con log de ambas decisiones.
  __setPcmExtractorForTesting(async ({ durationSeconds }) => buildPausePatternPcm(durationSeconds));
  const logs = [];
  const { cuts, cutIssues } = await refineCutsAcoustically({
    cuts: [{ id: "c1", startSeconds: 10.0, endSeconds: 20.0 }],
    edgeBounds: { c1: { start: { min: 9.5, max: 10.5 }, end: { min: 19.5, max: 20.5 } } },
    videoPath: "fake.mp4", ffmpegPath: "fake", ffmpegEnv: {},
    minCutSeconds: 0.15,
    log: (msg) => logs.push(msg),
  });
  check("ambos bordes refinados: el corte sobrevive", cuts.length === 1);
  check("ambos bordes refinados: sin cutIssues", cutIssues.length === 0);
  check("ambos bordes refinados: se logueó la decisión de cada borde", logs.some((l) => l.includes("borde inicio")) && logs.some((l) => l.includes("borde final")));
  __setPcmExtractorForTesting(null);
}

{
  // El análisis acústico falla para un corte -- se usa el límite
  // seguro por palabra para ESE corte (no rompe los demás), y queda
  // registrado en el log (no en cutIssues: el corte en sí sigue siendo
  // válido, solo no se pudo refinar más).
  __setPcmExtractorForTesting(async () => {
    throw new Error("ffmpeg no disponible (simulado)");
  });
  const logs = [];
  const { cuts, cutIssues } = await refineCutsAcoustically({
    cuts: [{ id: "c1", startSeconds: 10.0, endSeconds: 20.0 }],
    edgeBounds: { c1: { start: { min: 9.5, max: 10.5 }, end: { min: 19.5, max: 20.5 } } },
    videoPath: "fake.mp4", ffmpegPath: "fake", ffmpegEnv: {},
    minCutSeconds: 0.15,
    log: (msg) => logs.push(msg),
  });
  check("falla el análisis acústico: el corte sobrevive con sus límites seguros por palabra (sin refinar)", cuts.length === 1 && cuts[0].startSeconds === 10.0 && cuts[0].endSeconds === 20.0);
  check("falla el análisis acústico: no genera cutIssues (el corte sigue siendo válido)", cutIssues.length === 0);
  check("falla el análisis acústico: queda registrado en el log", logs.some((l) => l.includes("falló")));
  __setPcmExtractorForTesting(null);
}

{
  // Un corte sin edgeBounds (p.ej. ya fue descartado por
  // snapCutsToWordBoundaries antes de llegar acá) pasa sin tocar.
  const { cuts } = await refineCutsAcoustically({
    cuts: [{ id: "sin-bounds", startSeconds: 5.0, endSeconds: 5.3 }],
    edgeBounds: {},
    videoPath: "fake.mp4", ffmpegPath: "fake", ffmpegEnv: {},
    minCutSeconds: 0.15,
  });
  check("corte sin edgeBounds: pasa sin tocar", cuts.length === 1 && cuts[0].startSeconds === 5.0 && cuts[0].endSeconds === 5.3);
}

console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
process.exit(failures === 0 ? 0 : 1);
