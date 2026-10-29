// Mismos casos que ya se verificaron para src/engine/timeline.ts --
// server/timeline.mjs es un puerto exacto a JS plano, así que se prueba
// con los mismos casos para confirmar que no se desvió.
import { buildTimeline, remapRangeToOutput, normalizeCuts, mapOutputToSource } from "./timeline.mjs";

let failures = 0;
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const check = (label, cond) => {
  if (!cond) {
    failures++;
    console.log(`FAIL: ${label}`);
  } else {
    console.log(`ok: ${label}`);
  }
};

{
  const t = buildTimeline(100, []);
  check("sin cortes: 1 segmento", t.segments.length === 1);
  check("sin cortes: duración igual", approx(t.outputDurationInSeconds, 100));
}

{
  const t = buildTimeline(100, [{ startSeconds: 40, endSeconds: 50 }]);
  check("corte en medio: 2 segmentos", t.segments.length === 2);
  check("corte en medio: duración de salida = 90", approx(t.outputDurationInSeconds, 90));
  check(
    "corte en medio: seg2 source 50-100 -> output 40-90",
    approx(t.segments[1].sourceStart, 50) && approx(t.segments[1].outputStart, 40) && approx(t.segments[1].outputEnd, 90),
  );
}

{
  const merged = normalizeCuts([{ startSeconds: 10, endSeconds: 20 }, { startSeconds: 18, endSeconds: 30 }], 100);
  check("fusión de solapados: 1 solo rango", merged.length === 1);
  check("fusión de solapados: 10-30", approx(merged[0].startSeconds, 10) && approx(merged[0].endSeconds, 30));
}

{
  const t = buildTimeline(100, [{ startSeconds: 40, endSeconds: 50 }]);
  const r1 = remapRangeToOutput(t, { startSeconds: 5, endSeconds: 10 });
  check("rango antes del corte: sin cambios", r1.length === 1 && approx(r1[0].startSeconds, 5) && approx(r1[0].endSeconds, 10));

  const r2 = remapRangeToOutput(t, { startSeconds: 42, endSeconds: 48 });
  check("rango dentro del corte: 0 rangos (se descarta)", r2.length === 0);

  const r3 = remapRangeToOutput(t, { startSeconds: 35, endSeconds: 55 });
  check("rango que atraviesa el corte: 2 pedazos", r3.length === 2);
  check("pedazo 1: 35-40", r3.length === 2 && approx(r3[0].startSeconds, 35) && approx(r3[0].endSeconds, 40));
  check("pedazo 2: 40-45 (50-55 desplazado -10)", r3.length === 2 && approx(r3[1].startSeconds, 40) && approx(r3[1].endSeconds, 45));
}

// mapOutputToSource: el inverso, para el CTA obligatorio de mitad de video.
{
  const t = buildTimeline(100, [{ startSeconds: 40, endSeconds: 50 }]);
  // output 0-40 es source 0-40 sin cambios.
  check("mapOutputToSource antes del corte: sin cambios", approx(mapOutputToSource(t, 20), 20));
  // output 40-90 es source 50-100 (desplazado +10).
  check("mapOutputToSource después del corte: +10s", approx(mapOutputToSource(t, 45), 55));
  // el punto medio real de la salida (90/2=45) cae en source 55, no en el ingenuo 50.
  check("punto medio de la salida (45) no es el punto medio ingenuo del original (50)", approx(mapOutputToSource(t, t.outputDurationInSeconds / 2), 55));
}

console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
process.exit(failures === 0 ? 0 : 1);
