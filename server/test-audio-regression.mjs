// PRUEBA DE REGRESIÓN CON AUDIO REAL -- a diferencia de
// test-audio-analysis.mjs/test-quality-gate.mjs (que inyectan un
// detector/ejecutor falso porque este entorno de desarrollo no tiene un
// FFmpeg funcional), este archivo SÍ ejecuta el binario real de
// @remotion/compositor-* -- el mismo paquete que la imagen Docker de
// producción instala -- sobre fragmentos de audio SINTÉTICO generados
// con FFmpeg mismo (ver mandato de autonomía, 31-oct-2026: "crea en
// GitHub Actions un flujo de pruebas de regresión con audio real corto,
// que puedas lanzar y leer tú mismo... mientras Alex no autorice usar
// fragmentos de su voz en un repositorio público, usa audio sintético").
//
// Corre en GitHub Actions sobre ubuntu-latest (ver
// .github/workflows/audio-regression-tests.yml) -- ahí `npm ci` instala
// @remotion/compositor-linux-x64-gnu, idéntico al que trae la imagen
// Docker (node:22-bookworm-slim, también glibc/x64). NO se ejecuta como
// parte de `npm test` local porque esta máquina de desarrollo (macOS 12)
// no tiene un FFmpeg que funcione (ver informes anteriores).
//
// Los 4 casos reales de dopamina (Cameron Sepah, pues, 550-554s) se
// reproducen con tono sintético en vez de voz real -- la POSICIÓN
// relativa de las pausas es lo que importa para esta lógica, no el
// contenido. Un "tono" (sine) representa habla continua; "anullsrc"
// representa una pausa real.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveCompositorFfmpeg, binaryEnv } from "./compositor.mjs";
import { refineCutsWithRealSilence } from "./audio-analysis.mjs";
import { runQualityGateWithRemediation } from "./quality-gate.mjs";
import { buildTimeline } from "./timeline.mjs";

const execFileAsync = promisify(execFile);

let failures = 0;
const check = (label, cond, detail = "") => {
  if (!cond) {
    failures++;
    console.log(`FAIL: ${label}${detail ? ` -- ${detail}` : ""}`);
  } else {
    console.log(`ok: ${label}`);
  }
};

const SAMPLE_RATE = 8000;
const ffmpegPath = resolveCompositorFfmpeg();
const ffmpegEnv = binaryEnv(ffmpegPath);
console.log(`usando FFmpeg real: ${ffmpegPath}`);

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vf-audio-regression-"));

/**
 * Construye un WAV sintético concatenando tramos de "voz" (tono sine
 * continuo), "pausa real" (anullsrc, silencio digital) o "ruido de
 * fondo bajo sin pausas reales" (dos tonos mezclados y atenuados) --
 * con el FFmpeg REAL (mismo binario que producción). `segments`: lista
 * de {kind: "voice"|"silence"|"noise", durationSeconds, amplitude?}.
 */
const buildSyntheticFixture = async (name, segments) => {
  const outputPath = path.join(tmpDir, `${name}.wav`);
  const inputArgs = [];
  const stageFilters = [];
  const segmentLabels = [];
  let inputIndex = 0;

  segments.forEach((seg, i) => {
    const label = `seg${i}`;
    if (seg.kind === "voice") {
      inputArgs.push("-f", "lavfi", "-i", `sine=frequency=220:sample_rate=${SAMPLE_RATE}:duration=${seg.durationSeconds}`);
      stageFilters.push(`[${inputIndex}:a]anull[${label}]`);
      inputIndex += 1;
    } else if (seg.kind === "noise") {
      // "anoisesrc" NO está en la lista de filtros habilitados del FFmpeg
      // de producción (confirmado en CI: "No such filter: 'anoisesrc'").
      // Se simula "ruido de fondo bajo, sin pausas reales" mezclando dos
      // tonos de baja amplitud en frecuencias no relacionadas (evita que
      // se cancelen periódicamente y generen silencios falsos) -- "sine",
      // "volume" y "amix" sí están confirmados en el FFmpeg de producción.
      inputArgs.push(
        "-f", "lavfi", "-i", `sine=frequency=137:sample_rate=${SAMPLE_RATE}:duration=${seg.durationSeconds}`,
        "-f", "lavfi", "-i", `sine=frequency=211:sample_rate=${SAMPLE_RATE}:duration=${seg.durationSeconds}`,
      );
      stageFilters.push(`[${inputIndex}:a][${inputIndex + 1}:a]amix=inputs=2,volume=${seg.amplitude ?? 0.06}[${label}]`);
      inputIndex += 2;
    } else {
      inputArgs.push("-f", "lavfi", "-i", `anullsrc=sample_rate=${SAMPLE_RATE}:channel_layout=mono:duration=${seg.durationSeconds}`);
      stageFilters.push(`[${inputIndex}:a]anull[${label}]`);
      inputIndex += 1;
    }
    segmentLabels.push(`[${label}]`);
  });

  const concatStage = segments.length === 1 ? `${segmentLabels[0]}anull[outa]` : `${segmentLabels.join("")}concat=n=${segments.length}:v=0:a=1[outa]`;
  const filterComplex = `${stageFilters.join(";")};${concatStage}`;
  const args = [
    "-y",
    ...inputArgs,
    "-filter_complex",
    filterComplex,
    "-map",
    "[outa]",
    "-ac",
    "1",
    "-acodec",
    "pcm_s16le",
    "-f",
    "wav",
    outputPath,
  ];
  await execFileAsync(ffmpegPath, args, { env: ffmpegEnv, maxBuffer: 1024 * 1024 * 64 });
  const totalDurationSeconds = segments.reduce((sum, s) => sum + s.durationSeconds, 0);
  return { path: outputPath, totalDurationSeconds };
};

// --- Caso A: "Cameron Sepah" -- voz continua, SIN ninguna pausa real
// cerca del corte propuesto. El corte debe descartarse entero.
try {
  const fixture = await buildSyntheticFixture("caso-a-cameron-sepah", [{ kind: "voice", durationSeconds: 40 }]);
  const { cuts, cutIssues, pauseMap } = await refineCutsWithRealSilence({
    cuts: [{ id: "ai-cut-0", startSeconds: 29.68, endSeconds: 30.71 }],
    videoPath: fixture.path,
    videoDurationSeconds: fixture.totalDurationSeconds,
    ffmpegPath,
    ffmpegEnv,
  });
  check("caso A (Cameron Sepah): sin ninguna pausa real en todo el tramo -- mapa vacío", pauseMap.intervals.length === 0, `intervals=${JSON.stringify(pauseMap.intervals)}`);
  check("caso A (Cameron Sepah): el corte se descarta (voz continua, sin pausa real cerca)", cuts.length === 0, `cuts=${JSON.stringify(cuts)}`);
  check("caso A (Cameron Sepah): queda registrada la razón", cutIssues.some((i) => i.includes("ai-cut-0")));
} catch (err) {
  check(`caso A: fallo al ejecutar (ver si FFmpeg soporta los filtros usados)`, false, String(err.message ?? err));
}

// --- Caso B: "pues" -- hay una pausa real corta cerca del corte
// propuesto (impreciso). El corte se ajusta a la pausa real y sobrevive.
let casoBResult = null;
try {
  const fixture = await buildSyntheticFixture("caso-b-pues", [
    { kind: "voice", durationSeconds: 49.9 },
    { kind: "silence", durationSeconds: 0.35 },
    { kind: "voice", durationSeconds: 19.75 },
  ]);
  const result = await refineCutsWithRealSilence({
    cuts: [{ id: "ai-cut-1", startSeconds: 50.0, endSeconds: 50.6 }], // impreciso a propósito, como Whisper desfasado
    videoPath: fixture.path,
    videoDurationSeconds: fixture.totalDurationSeconds,
    ffmpegPath,
    ffmpegEnv,
  });
  casoBResult = { ...result, fixture };
  console.log(`[debug caso B] pauseMap.intervals=${JSON.stringify(result.pauseMap.intervals)}`);
  console.log(`[debug caso B] cutIssues=${JSON.stringify(result.cutIssues)}`);
  check("caso B (pues): hay exactamente 1 pausa real detectada", result.pauseMap.intervals.length === 1, `intervals=${JSON.stringify(result.pauseMap.intervals)}`);
  check("caso B (pues): el corte SOBREVIVE, ajustado a la pausa real", result.cuts.length === 1, `cuts=${JSON.stringify(result.cuts)}`);
  if (result.cuts.length === 1) {
    const adjusted = result.cuts[0];
    check(
      "caso B (pues): el corte ajustado cae dentro de la pausa real real (49.9-50.25)",
      adjusted.startSeconds >= 49.85 && adjusted.endSeconds <= 50.3,
      `ajustado=${adjusted.startSeconds.toFixed(3)}-${adjusted.endSeconds.toFixed(3)}`,
    );
  }
} catch (err) {
  check(`caso B: fallo al ejecutar (ver si FFmpeg soporta los filtros usados)`, false, String(err.message ?? err));
}

// --- Caso C: un borde cae en voz continua, la pausa real más cercana
// está demasiado lejos (fuera de la ventana de +-1s) -- se descarta.
try {
  const fixture = await buildSyntheticFixture("caso-c-voz-continua", [
    { kind: "voice", durationSeconds: 5.0 },
    { kind: "silence", durationSeconds: 0.2 }, // pausa real, pero lejos del corte propuesto
    { kind: "voice", durationSeconds: 4.8 },
  ]);
  // Corte propuesto: 5.4-5.8 -- el final (5.8) queda a mitad de la voz
  // continua, y la única pausa real (5.0-5.2) está a mas de 1s del borde final.
  const { cuts, cutIssues } = await refineCutsWithRealSilence({
    cuts: [{ id: "ai-cut-2", startSeconds: 6.6, endSeconds: 7.0 }],
    videoPath: fixture.path,
    videoDurationSeconds: fixture.totalDurationSeconds,
    ffmpegPath,
    ffmpegEnv,
  });
  check("caso C (borde en voz continua, pausa real lejana): el corte se descarta", cuts.length === 0, `cuts=${JSON.stringify(cuts)}`);
  check("caso C: queda registrada la razón", cutIssues.some((i) => i.includes("ai-cut-2")));
} catch (err) {
  check(`caso C: fallo al ejecutar (ver si FFmpeg soporta los filtros usados)`, false, String(err.message ?? err));
}

// --- Caso D (NUEVO, pedido por el dictamen): un corte colocado
// artificialmente DENTRO de una "palabra" (voz continua, sin ninguna
// pausa real en todo el tramo) -- el sistema debe detectar el riesgo y
// evitar aplicar el corte defectuoso, no inventar un punto de corte.
try {
  const fixture = await buildSyntheticFixture("caso-d-dentro-de-palabra", [{ kind: "voice", durationSeconds: 20 }]);
  const { cuts, cutIssues, pauseMap } = await refineCutsWithRealSilence({
    cuts: [{ id: "ai-cut-palabra", startSeconds: 10.0, endSeconds: 10.3 }], // justo en medio del tono continuo
    videoPath: fixture.path,
    videoDurationSeconds: fixture.totalDurationSeconds,
    ffmpegPath,
    ffmpegEnv,
  });
  check("caso D (corte dentro de una palabra): sin ninguna pausa real detectada", pauseMap.intervals.length === 0);
  check("caso D (corte dentro de una palabra): el corte se evita (nunca se inventa un punto)", cuts.length === 0, `cuts=${JSON.stringify(cuts)}`);
  check("caso D: ambos bordes quedan señalados como sin pausa real", cutIssues.some((i) => i.includes("ai-cut-palabra") && i.includes("ni cerca del final")));
} catch (err) {
  check(`caso D: fallo al ejecutar (ver si FFmpeg soporta los filtros usados)`, false, String(err.message ?? err));
}

// --- Caso E (robustez, sección 2 del dictamen): audio con ruido de
// fondo constante y SIN ninguna pausa realmente detectable -- el
// sistema no debe fallar ni inventar nada, solo descartar el corte.
try {
  const fixture = await buildSyntheticFixture("caso-e-ruido-de-fondo", [{ kind: "noise", durationSeconds: 15, amplitude: 0.08 }]);
  const { cuts, pauseMap } = await refineCutsWithRealSilence({
    cuts: [{ id: "ai-cut-ruido", startSeconds: 7.0, endSeconds: 7.5 }],
    videoPath: fixture.path,
    videoDurationSeconds: fixture.totalDurationSeconds,
    ffmpegPath,
    ffmpegEnv,
  });
  check("caso E (ruido de fondo constante): no se cae, corre igual", true);
  check("caso E (ruido de fondo constante): sin pausas reales detectables -- mapa vacío", pauseMap.intervals.length === 0, `intervals=${JSON.stringify(pauseMap.intervals)}`);
  check("caso E (ruido de fondo constante): el corte se descarta en vez de inventar un punto", cuts.length === 0);
} catch (err) {
  check(`caso E: fallo al ejecutar (ver si FFmpeg soporta los filtros usados)`, false, String(err.message ?? err));
}

// --- Caso F: la puerta de calidad end-to-end, con el resultado REAL
// del caso B -- arma la pista editada de verdad y la verifica.
try {
  if (casoBResult && casoBResult.cuts.length === 1) {
    const gateResult = await runQualityGateWithRemediation({
      ffmpegPath,
      ffmpegEnv,
      videoPath: casoBResult.fixture.path,
      cuts: casoBResult.cuts,
      videoDurationSeconds: casoBResult.fixture.totalDurationSeconds,
    });
    const expectedTimeline = buildTimeline(casoBResult.fixture.totalDurationSeconds, gateResult.cuts);
    check("caso F (puerta de calidad end-to-end, FFmpeg real): ok=true", gateResult.ok === true, JSON.stringify(gateResult.qualityReport?.issues));
    check("caso F: el corte del caso B sigue sobreviviendo tras la puerta de calidad", gateResult.cuts.length === 1);
    check(
      "caso F: la duración de la pista editada coincide con la línea de tiempo esperada",
      gateResult.qualityReport && Math.abs(gateResult.qualityReport.durationCheck.actualDurationSeconds - expectedTimeline.outputDurationInSeconds) < 0.05,
    );
  } else {
    check("caso F (puerta de calidad end-to-end): se omite -- el caso B no produjo un corte sobreviviente", false, "revisar caso B primero");
  }
} catch (err) {
  check(`caso F: fallo al ejecutar (ver si FFmpeg soporta los filtros usados)`, false, String(err.message ?? err));
}

await fs.rm(tmpDir, { recursive: true, force: true });

console.log(failures === 0 ? "\nTODOS LOS TESTS DE REGRESIÓN (AUDIO REAL) PASARON" : `\n${failures} TEST(S) DE REGRESIÓN FALLARON`);
process.exit(failures === 0 ? 0 : 1);
