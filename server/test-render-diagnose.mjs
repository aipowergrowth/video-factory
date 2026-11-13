// PRUEBA SIMULADA (nivel 2 de honestidad de evidencia, CLAUDE.md) --
// server/render-diagnose.mjs: `buildDiagnosticWindows`/
// `buildDiagnosticFrameRanges`/`computeWindowTimings` (puras, sin
// ejecutar nada). La confirmación de que `runDiagnosticRender`
// funciona de verdad contra Remotion/Chrome reales (hitos detectados,
// ms/cuadro reales por ventana, 0 huérfanos tras el corte, no escribe
// en el output real) vive en test-render-observability.mjs (CI, Linux
// real) -- no se puede ejecutar un render real en esta máquina de
// desarrollo (ver README.md).

import { buildDiagnosticWindows, buildDiagnosticFrameRanges, computeWindowTimings } from "./render-diagnose.mjs";

let failures = 0;
const check = (label, cond, detail = "") => {
  if (!cond) {
    failures++;
    console.log(`FAIL: ${label}${detail ? ` -- ${detail}` : ""}`);
  } else {
    console.log(`ok: ${label}`);
  }
};

// --- buildDiagnosticFrameRanges / buildDiagnosticWindows ---

check(
  "video largo (41331 cuadros, el job real): inicio + medio + final, las 3 ventanas (criterio 1)",
  buildDiagnosticFrameRanges(41331, { initialFrameCount: 30, middleWindowFrameCount: 30, endFrameCount: 30 }) === "0-29,20665-20694,41301-41330",
);

check(
  "video corto (10 cuadros, menos que initialFrameCount): un solo rango, recortado al total real, sin ventana intermedia ni final",
  buildDiagnosticFrameRanges(10, { initialFrameCount: 30, middleWindowFrameCount: 30 }) === "0-9",
);

check(
  "video mediano donde medio/final se superpondrían con el inicio: se omiten (nunca un rango inválido/duplicado)",
  buildDiagnosticFrameRanges(35, { initialFrameCount: 30, middleWindowFrameCount: 30 }) === "0-29",
);

check(
  "video exactamente del tamaño de initialFrameCount: un solo rango",
  buildDiagnosticFrameRanges(30, { initialFrameCount: 30, middleWindowFrameCount: 30 }) === "0-29",
);

check("totalFrames inválido (0, negativo, no numérico): devuelve null, nunca un rango inventado", buildDiagnosticFrameRanges(0) === null && buildDiagnosticFrameRanges(-5) === null && buildDiagnosticFrameRanges(NaN) === null);

check(
  "medio cabe pero el final se superpondría con el medio: el final se omite, quedan inicio+medio",
  buildDiagnosticFrameRanges(100, { initialFrameCount: 10, middleWindowFrameCount: 30, endFrameCount: 30 }) === "0-9,50-79",
);

check(
  "video largo con margen de sobra entre las 3 ventanas: las 3 aparecen, sin solaparse",
  buildDiagnosticFrameRanges(10000, { initialFrameCount: 10, middleWindowFrameCount: 10, endFrameCount: 10 }) === "0-9,5000-5009,9990-9999",
);

// --- buildDiagnosticWindows: posición dentro de la selección COMBINADA (lo que Remotion reporta como N en "Rendered N/TOTAL") ---

{
  const windows = buildDiagnosticWindows(41331, { initialFrameCount: 30, middleWindowFrameCount: 30, endFrameCount: 30 });
  check("3 ventanas detectadas, en orden inicio/medio/final", windows.length === 3 && windows.map((w) => w.label).join(",") === "inicio,medio,final");
  check(
    "índices COMBINADOS corridos: inicio 0-29, medio 30-59, final 60-89 (lo que Remotion reporta como N, no los índices reales del video)",
    windows[0].combinedStart === 0 && windows[0].combinedEnd === 29 && windows[1].combinedStart === 30 && windows[1].combinedEnd === 59 && windows[2].combinedStart === 60 && windows[2].combinedEnd === 89,
    JSON.stringify(windows),
  );
  check(
    "índices REALES del video (start/end) siguen siendo los del video completo, no los combinados",
    windows[1].start === 20665 && windows[1].end === 20694,
  );
}

check("totalFrames inválido: buildDiagnosticWindows devuelve array vacío, nunca lanza", Array.isArray(buildDiagnosticWindows(0)) && buildDiagnosticWindows(0).length === 0 && buildDiagnosticWindows(NaN).length === 0);

// --- computeWindowTimings: ms/cuadro real por ventana, con datos de ticks simulados ---

{
  const windows = buildDiagnosticWindows(41331, { initialFrameCount: 30, middleWindowFrameCount: 30, endFrameCount: 30 });
  // Ventana "inicio" (combinado 0-29): primer tick a los 2000ms (arranque de navegador/bundling, se descarta como baseline), tick en combinado=5 a los 2500ms, tick en combinado=29 a los 3900ms -> delta (29-5) cuadros en (3900-2500)ms = 1400/24 = 58.33ms/cuadro.
  const ticks = [
    { renderedFrames: 0, elapsedMs: 2000 },
    { renderedFrames: 5, elapsedMs: 2500 },
    { renderedFrames: 29, elapsedMs: 3900 },
    // Ventana "medio" (combinado 30-59): solo 1 tick visto -> null, nunca un promedio con un solo dato.
    { renderedFrames: 35, elapsedMs: 10000 },
    // Ventana "final" (combinado 60-89): 2 ticks -> timing real.
    { renderedFrames: 60, elapsedMs: 20000 },
    { renderedFrames: 90, elapsedMs: 21500 }, // nota: 90 queda fuera de combinedEnd=89, no se cuenta en este tick
    { renderedFrames: 89, elapsedMs: 21450 },
  ];
  const timings = computeWindowTimings(ticks, windows);
  check("3 resultados, uno por ventana, en el mismo orden", timings.length === 3 && timings.map((t) => t.label).join(",") === "inicio,medio,final");
  check(
    "ventana 'inicio': usa el DELTA entre el primer tick visto (combinado=0, 2000ms) y el último (combinado=29, 3900ms) -- 29 cuadros en 1900ms",
    timings[0].avgMsPerFrame === Math.round(((3900 - 2000) / (29 - 0)) * 100) / 100,
    `avgMsPerFrame=${timings[0].avgMsPerFrame}`,
  );
  check("ventana 'medio': solo 1 tick visto -> avgMsPerFrame=null, nunca un promedio inventado", timings[1].avgMsPerFrame === null && timings[1].sampledTicks === 1);
  check(
    "ventana 'final': 2 ticks reales (60 y 89, el de 90 queda fuera del rango combinado) -> timing calculado",
    timings[2].sampledTicks === 2 && timings[2].avgMsPerFrame === Math.round(((21450 - 20000) / (89 - 60)) * 100) / 100,
    `sampledTicks=${timings[2].sampledTicks} avgMsPerFrame=${timings[2].avgMsPerFrame}`,
  );
}

check("computeWindowTimings sin ventanas: devuelve array vacío, nunca lanza", computeWindowTimings([{ renderedFrames: 0, elapsedMs: 100 }], []).length === 0);
check("computeWindowTimings sin ningún tick: cada ventana queda en null (0 ticks vistos), nunca lanza", computeWindowTimings([], buildDiagnosticWindows(100, { initialFrameCount: 10 })).every((t) => t.avgMsPerFrame === null));

console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
process.exit(failures === 0 ? 0 : 1);
