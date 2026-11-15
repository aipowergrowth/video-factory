// PRUEBA SIMULADA (nivel 2 de honestidad de evidencia, CLAUDE.md) --
// server/render-diagnose-hybrid.mjs: solo las partes puras (cálculo de
// regiones de línea base, estimación de tiempo, composición de la
// ventana representativa). La corrida real del diagnóstico (FFmpeg/
// Remotion reales) es VPS-only -- Alex es quien la ejecuta.
//
// Adenda 15-nov-2026 (corrección del timeout real en el VPS, hallado
// por el operador al revisar 0b54615): esta es la primera prueba
// propia de este archivo -- antes no tenía ninguna, porque antes era
// puro pegamento sin funciones puras propias.

import { estimateRenderMs, buildBaselineRegions, estimateHybridDiagnosticMs, planHybridDiagnosticWindow, MEASURED_PLAIN_REENCODE_FPS, MEASURED_COMPOSITE_FPS, DEFAULT_TIMEOUT_MARGIN_MULTIPLIER, BASELINE_REGION_MARGIN_FRAMES } from "./render-diagnose-hybrid.mjs";

let failures = 0;
const check = (label, cond, detail = "") => {
  if (!cond) {
    failures++;
    console.log(`FAIL: ${label}${detail ? ` -- ${detail}` : ""}`);
  } else {
    console.log(`ok: ${label}`);
  }
};

const baseJob = (overrides = {}) => ({
  channel: "a-mi-no-me-cuadra",
  destination: "youtube-16-9",
  input: { type: "recorded-video", baseVideo: "x.mp4", durationInSeconds: 10 },
  overlays: [],
  captions: [],
  cuts: [],
  zooms: [],
  resources: [],
  ...overrides,
});

// --- estimateRenderMs ---

{
  check("estimateRenderMs: 300 cuadros a 30fps = 10000ms exactos", estimateRenderMs(300, 30) === 10000);
  check("estimateRenderMs: 0 cuadros -- 0ms, nunca lanza", estimateRenderMs(0, 30) === 0);
  check("estimateRenderMs: fps 0 -- 0ms, nunca Infinity/NaN", estimateRenderMs(100, 0) === 0);
  check("estimateRenderMs: frameCount negativo -- 0ms", estimateRenderMs(-5, 30) === 0);
}

// --- buildBaselineRegions ---

{
  const chunks = [
    { type: "plain", outputStartFrame: 0, outputEndFrame: 1000 },
    { type: "composite", outputStartFrame: 1000, outputEndFrame: 1060 },
    { type: "plain", outputStartFrame: 1060, outputEndFrame: 3000 },
  ];
  const regions = buildBaselineRegions(chunks, { marginFrames: 15, windowStartFrame: 0, windowEndFrame: 3000 });
  check("buildBaselineRegions: un solo tramo compuesto -- una sola región", regions.length === 1, JSON.stringify(regions));
  check("buildBaselineRegions: la región se extiende el margen hacia cada lado (985-1075, cae en los tramos planos vecinos)", regions[0].start === 985 && regions[0].end === 1075, JSON.stringify(regions));
}

{
  // Sin ningún tramo compuesto -- ninguna región (ventana 100% plana, no hace falta ninguna línea base de Remotion).
  const chunks = [{ type: "plain", outputStartFrame: 0, outputEndFrame: 3000 }];
  const regions = buildBaselineRegions(chunks, { marginFrames: 15, windowStartFrame: 0, windowEndFrame: 3000 });
  check("buildBaselineRegions: sin tramos compuestos -- [] (ninguna línea base necesaria)", Array.isArray(regions) && regions.length === 0);
}

{
  // Composite pegado al borde de la ventana -- el margen se recorta, nunca se sale de [windowStartFrame, windowEndFrame).
  const chunks = [{ type: "composite", outputStartFrame: 0, outputEndFrame: 50 }];
  const regions = buildBaselineRegions(chunks, { marginFrames: 15, windowStartFrame: 0, windowEndFrame: 3000 });
  check("buildBaselineRegions: composite pegado al inicio -- el margen se recorta al límite de la ventana (start=0, no -15)", regions[0].start === 0, JSON.stringify(regions));
  check("buildBaselineRegions: el otro lado SÍ lleva el margen completo (50+15=65)", regions[0].end === 65, JSON.stringify(regions));
}

{
  // Dos tramos compuestos CERCA uno del otro -- sus regiones extendidas se solapan y se FUSIONAN en una sola (nunca dos renders de Remotion sobre el mismo cuadro).
  const chunks = [
    { type: "composite", outputStartFrame: 100, outputEndFrame: 150 },
    { type: "composite", outputStartFrame: 170, outputEndFrame: 200 },
  ];
  const regions = buildBaselineRegions(chunks, { marginFrames: 15, windowStartFrame: 0, windowEndFrame: 3000 });
  check("buildBaselineRegions: dos compuestos cercanos (sus márgenes se tocan: 150+15=165 >= 170-15=155) -- se fusionan en UNA región", regions.length === 1, JSON.stringify(regions));
  check("buildBaselineRegions: la región fusionada cubre desde el inicio del primero hasta el fin del segundo (con margen)", regions[0].start === 85 && regions[0].end === 215, JSON.stringify(regions));
}

{
  // Dos tramos compuestos LEJOS uno del otro -- quedan como DOS regiones separadas.
  const chunks = [
    { type: "composite", outputStartFrame: 100, outputEndFrame: 150 },
    { type: "composite", outputStartFrame: 2000, outputEndFrame: 2050 },
  ];
  const regions = buildBaselineRegions(chunks, { marginFrames: 15, windowStartFrame: 0, windowEndFrame: 3000 });
  check("buildBaselineRegions: dos compuestos lejanos -- DOS regiones separadas, no se fusionan de más", regions.length === 2, JSON.stringify(regions));
}

// --- planHybridDiagnosticWindow + estimateHybridDiagnosticMs (composición end-to-end con el job sintético ya usado en test-segment-planner.mjs) ---

{
  // Job de 60s @ 30fps = 1800 cuadros; overlay de 2s (60 cuadros) a los 20s (cuadro 600) -- mismo fixture que la prueba de chooseRepresentativeWindow en test-segment-planner.mjs, para confirmar que el ENSAMBLADO de funciones puras en planHybridDiagnosticWindow da los mismos números.
  const job = baseJob({ input: { type: "recorded-video", baseVideo: "x.mp4", durationInSeconds: 60 }, overlays: [{ id: "o1", type: "text", text: "x", startSeconds: 20, durationSeconds: 2 }] });
  const { windowStartFrame, windowFrames, windowEndFrame, achievedCompositeFraction, plan } = planHybridDiagnosticWindow(job, { minWindowFrames: 30, maxWindowFrames: 1000, targetCompositeFraction: 0.15, fps: 30 });
  check("planHybridDiagnosticWindow: mismos números que chooseRepresentativeWindow sola (windowFrames=400)", windowFrames === 400, `windowFrames=${windowFrames}`);
  check("planHybridDiagnosticWindow: windowStartFrame=430 (ventana centrada, no forzada a 0)", windowStartFrame === 430, `windowStartFrame=${windowStartFrame}`);
  check("planHybridDiagnosticWindow: achievedCompositeFraction=0.15 (objetivo logrado exacto)", achievedCompositeFraction === 0.15);
  check("planHybridDiagnosticWindow: el plan recortado tiene 3 chunks (plano, compuesto, plano)", plan.chunks.length === 3, JSON.stringify(plan.chunks.map((c) => c.type)));

  const estimate = estimateHybridDiagnosticMs(plan, { windowStartFrame, windowEndFrame });
  check("estimateHybridDiagnosticMs: plainFrames = 170+170 = 340 (los dos tramos planos de la ventana)", estimate.plainFrames === 340, `plainFrames=${estimate.plainFrames}`);
  check("estimateHybridDiagnosticMs: compositeFrames = 60 (el tramo compuesto)", estimate.compositeFrames === 60, `compositeFrames=${estimate.compositeFrames}`);
  check("estimateHybridDiagnosticMs: baselineFrames = 90 (60 + 15 de margen por lado) -- MUCHO menos que los 400 de la ventana completa", estimate.baselineFrames === 90, `baselineFrames=${estimate.baselineFrames}`);
  check(
    "estimateHybridDiagnosticMs: totalConservativeMs es la suma exacta de sus partes (sin solapamiento de paralelismo)",
    estimate.totalConservativeMs === estimate.hybridChunksMsConservative + estimate.baselineMs + estimate.plainCompareMs + estimate.miscOverheadMs,
  );
  check(
    "estimateHybridDiagnosticMs: totalOptimisticMs <= totalConservativeMs (el paralelismo nunca puede tardar MÁS que la suma sin solapar)",
    estimate.totalOptimisticMs <= estimate.totalConservativeMs,
    `optimistic=${estimate.totalOptimisticMs} conservative=${estimate.totalConservativeMs}`,
  );

  // Criterio 4 (adenda 15-nov-2026): verificar por simulación que el
  // timeout de CADA operación (calculado con la MISMA fórmula que usa
  // runHybridDiagnostic, con margen) nunca queda por debajo de lo que
  // esa operación debería tardar según la estimación SIN margen.
  const largestChunkFrames = Math.max(...plan.chunks.map((c) => c.frames ?? c.outputEndFrame - c.outputStartFrame));
  check("simulación de timeouts: el tramo más grande del plan es el plano de 170 cuadros, no el compuesto de 60", largestChunkFrames === 170, `largestChunkFrames=${largestChunkFrames}`);
  const chunkTimeoutMs = estimateRenderMs(largestChunkFrames, MEASURED_COMPOSITE_FPS) * DEFAULT_TIMEOUT_MARGIN_MULTIPLIER;
  const worstCasePlainChunkMs = estimateRenderMs(largestChunkFrames, MEASURED_PLAIN_REENCODE_FPS);
  check(
    "simulación de timeouts: el timeout por tramo (calculado con la velocidad COMPUESTA, más lenta, y margen) cubre con margen de sobra hasta un tramo PLANO del mismo tamaño (más rápido)",
    chunkTimeoutMs > worstCasePlainChunkMs,
    `chunkTimeoutMs=${chunkTimeoutMs} worstCasePlainChunkMs=${worstCasePlainChunkMs}`,
  );

  const regions = buildBaselineRegions(plan.chunks, { marginFrames: BASELINE_REGION_MARGIN_FRAMES, windowStartFrame, windowEndFrame });
  for (const region of regions) {
    const regionFrames = region.end - region.start;
    const regionEstimateMs = estimateRenderMs(regionFrames, MEASURED_COMPOSITE_FPS);
    const regionTimeoutMs = regionEstimateMs * DEFAULT_TIMEOUT_MARGIN_MULTIPLIER;
    check(`simulación de timeouts: la región de línea base ${region.start}-${region.end} tiene timeout (${regionTimeoutMs}ms) por encima de su propia estimación (${regionEstimateMs}ms)`, regionTimeoutMs > regionEstimateMs);
  }
  check("simulación de timeouts: ninguna región de línea base necesita más cuadros que toda la ventana (90 < 400) -- el diseño está acotado por el tamaño del compuesto, no de la ventana", regions.every((r) => r.end - r.start < windowFrames));
}

{
  // Ventana SIN ningún tramo compuesto (job 100% plano) -- estimateHybridDiagnosticMs no debe lanzar ni dar baselineFrames/compositeFrames distintos de 0.
  const job = baseJob({ input: { type: "recorded-video", baseVideo: "x.mp4", durationInSeconds: 10 } });
  const { windowStartFrame, windowEndFrame, plan } = planHybridDiagnosticWindow(job, { minWindowFrames: 30, maxWindowFrames: 1000, targetCompositeFraction: 0.15, fps: 30 });
  const estimate = estimateHybridDiagnosticMs(plan, { windowStartFrame, windowEndFrame });
  check("estimateHybridDiagnosticMs: job 100% plano -- compositeFrames=0 y baselineFrames=0 (ninguna línea base de Remotion necesaria)", estimate.compositeFrames === 0 && estimate.baselineFrames === 0, JSON.stringify(estimate));
  check("estimateHybridDiagnosticMs: job 100% plano -- totalConservativeMs sigue siendo un número finito, nunca NaN/Infinity", Number.isFinite(estimate.totalConservativeMs));
}

if (failures > 0) {
  console.log(`\n${failures} TEST(S) FALLARON`);
  process.exit(1);
}
console.log("\nTODOS LOS TESTS PASARON");
