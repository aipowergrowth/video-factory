// PRUEBA SIMULADA (nivel 2 de honestidad de evidencia, CLAUDE.md) --
// server/render-diagnose.mjs: solo `buildDiagnosticFrameRanges` (pura,
// sin ejecutar nada). La confirmación de que `runDiagnosticRender`
// funciona de verdad contra Remotion/Chrome reales (hitos detectados,
// 0 huérfanos tras el corte, no escribe en el output real) vive en
// test-render-observability.mjs (CI, Linux real) -- no se puede
// ejecutar un render real en esta máquina de desarrollo (ver
// README.md).

import { buildDiagnosticFrameRanges } from "./render-diagnose.mjs";

let failures = 0;
const check = (label, cond, detail = "") => {
  if (!cond) {
    failures++;
    console.log(`FAIL: ${label}${detail ? ` -- ${detail}` : ""}`);
  } else {
    console.log(`ok: ${label}`);
  }
};

check(
  "video largo (41331 cuadros, el job real): primeros 30 cuadros + ventana de 30 en la mitad exacta",
  buildDiagnosticFrameRanges(41331, { initialFrameCount: 30, middleWindowFrameCount: 30 }) === "0-29,20665-20694",
);

check(
  "video corto (10 cuadros, menos que initialFrameCount): un solo rango, recortado al total real, sin ventana intermedia",
  buildDiagnosticFrameRanges(10, { initialFrameCount: 30, middleWindowFrameCount: 30 }) === "0-9",
);

check(
  "video mediano donde la ventana intermedia se superpondría con el inicio: se omite la ventana (nunca un rango inválido/duplicado)",
  buildDiagnosticFrameRanges(35, { initialFrameCount: 30, middleWindowFrameCount: 30 }) === "0-29",
);

check(
  "video exactamente del tamaño de initialFrameCount: un solo rango, sin ventana intermedia",
  buildDiagnosticFrameRanges(30, { initialFrameCount: 30, middleWindowFrameCount: 30 }) === "0-29",
);

check("totalFrames inválido (0, negativo, no numérico): devuelve null, nunca un rango inventado", buildDiagnosticFrameRanges(0) === null && buildDiagnosticFrameRanges(-5) === null && buildDiagnosticFrameRanges(NaN) === null);

check(
  "ventana intermedia nunca excede el total de cuadros reales (se recorta al último cuadro real)",
  buildDiagnosticFrameRanges(100, { initialFrameCount: 10, middleWindowFrameCount: 30 }) === "0-9,50-79",
);

console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
process.exit(failures === 0 ? 0 : 1);
