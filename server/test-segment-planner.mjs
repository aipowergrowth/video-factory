// PRUEBA SIMULADA (nivel 2 de honestidad de evidencia, CLAUDE.md) --
// server/segment-planner.mjs: pura, con jobs construidos a mano y
// aritmética conocida de antemano (no depende de ningún video real).
// La confirmación de que esto sirve con jobs REALES persistidos
// (1fd239de y otros) es la puerta G0 -- solo se puede correr en el
// VPS, ver el informe de esta tarea para los pasos exactos.

import { planSegments, planChunks, fuseCompositeRanges, summarizeChunkPlan, decideRenderMode, chooseRepresentativeWindow, clipChunksToRange, clipTimelineToOutputRange } from "./segment-planner.mjs";
import { buildTimeline } from "./timeline.mjs";

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

// --- 10s a 30fps = 300 cuadros, sin ningún elemento: 100% plano ---
{
  const plan = planSegments(baseJob());
  check("sin elementos: totalFrames=300 (10s @ 30fps)", plan.totalFrames === 300);
  check("sin elementos: 100% plano, 0% compuesto", plan.plainFrames === 300 && plan.compositeFrames === 0 && plan.plainPercent === 100 && plan.compositePercent === 0);
  check("sin elementos: 0 corridas compuestas", plan.compositeRuns === 0);
}

// --- Un zoom de 2s a 4s (sin cortes, tiempo original = tiempo de salida): cuadros 60-119 ---
{
  const plan = planSegments(baseJob({ zooms: [{ id: "z1", startSeconds: 2, endSeconds: 4, fromScale: 1, toScale: 1.2 }] }));
  check("un zoom de 2s a 4s: 60 cuadros compuestos (2s * 30fps)", plan.compositeFrames === 60, `compositeFrames=${plan.compositeFrames}`);
  check("un zoom: se cuentan en byType.zoomFrames, no en overlayFrames", plan.byType.zoomFrames === 60 && plan.byType.overlayFrames === 0);
  check("un zoom: 1 sola corrida compuesta", plan.compositeRuns === 1);
  check("un zoom: el resto queda plano (240 cuadros)", plan.plainFrames === 240);
}

// --- Un overlay de 1s empezando en el segundo 5: cuadros 150-179 ---
{
  const plan = planSegments(baseJob({ overlays: [{ id: "o1", type: "text", text: "hola", startSeconds: 5, durationSeconds: 1 }] }));
  check("un overlay de 1s: 30 cuadros compuestos", plan.compositeFrames === 30, `compositeFrames=${plan.compositeFrames}`);
  check("un overlay: se cuenta en byType.overlayFrames", plan.byType.overlayFrames === 30 && plan.byType.zoomFrames === 0);
}

// --- Un recurso ya en tiempo de SALIDA (CTA, siempre renderable vía ctaPosition) de 1s a 2s ---
{
  const ctaResource = {
    id: "r1",
    startSeconds: 1,
    endSeconds: 2,
    type: "text-highlight",
    description: "cta inicial",
    editorialGoal: "emphasis",
    segment: "intro",
    intensity: "moderate",
    veracityRequirement: "illustrative-ok",
    essential: true,
    ctaPosition: "start",
    displayText: "Suscríbete",
  };
  const plan = planSegments(baseJob({ resources: [ctaResource] }));
  check("un recurso CTA de 1s: 30 cuadros compuestos (en tiempo de SALIDA, sin remapear)", plan.compositeFrames === 30, `compositeFrames=${plan.compositeFrames}`);
  check("un recurso: se cuenta en byType.resourceFrames", plan.byType.resourceFrames === 30);
}

// --- Un recurso NO renderable (text-highlight sin displayText) -- isRenderableByEngine lo descarta, no debe contar ---
{
  const nonRenderable = {
    id: "r2",
    startSeconds: 1,
    endSeconds: 2,
    type: "text-highlight",
    description: "sin texto exacto",
    editorialGoal: "emphasis",
    segment: "intro",
    intensity: "moderate",
    veracityRequirement: "illustrative-ok",
    essential: false,
    // sin displayText -- isRenderableByEngine devuelve false
  };
  const plan = planSegments(baseJob({ resources: [nonRenderable] }));
  check("recurso NO renderable (sin displayText): no cuenta como compuesto", plan.compositeFrames === 0 && plan.byType.resourceFrames === 0);
}

// --- Subtítulos quemados: destino vertical-9-16 (quema por defecto) con una línea de 1s ---
{
  const verticalJob = baseJob({
    destination: "vertical-9-16",
    captions: [{ text: "hola mundo", startMs: 3000, endMs: 4000, timestampMs: null, confidence: null }],
  });
  const plan = planSegments(verticalJob);
  check("vertical-9-16 (quema por defecto): la línea de 1s cuenta como compuesta (30 cuadros)", plan.byType.captionFrames === 30, `captionFrames=${plan.byType.captionFrames}`);
  check("vertical-9-16: burnsCaptions=true en el resultado", plan.burnsCaptions === true);
}

// --- Mismos subtítulos, pero youtube-16-9 (NO quema por defecto): no deben contar ---
{
  const horizontalJob = baseJob({
    destination: "youtube-16-9",
    captions: [{ text: "hola mundo", startMs: 3000, endMs: 4000, timestampMs: null, confidence: null }],
  });
  const plan = planSegments(horizontalJob);
  check("youtube-16-9 (NO quema por defecto): la misma línea de subtítulo NO cuenta como compuesta", plan.byType.captionFrames === 0 && plan.compositeFrames === 0);
  check("youtube-16-9: burnsCaptions=false en el resultado", plan.burnsCaptions === false);
}

// --- burnCaptions:true fuerza la quema incluso en youtube-16-9 ---
{
  const forcedBurnJob = baseJob({
    destination: "youtube-16-9",
    burnCaptions: true,
    captions: [{ text: "hola mundo", startMs: 3000, endMs: 4000, timestampMs: null, confidence: null }],
  });
  const plan = planSegments(forcedBurnJob);
  check("burnCaptions:true fuerza la quema incluso en youtube-16-9", plan.byType.captionFrames === 30 && plan.burnsCaptions === true);
}

// --- Un corte elimina un tramo del original: un overlay DENTRO del corte desaparece de la salida ---
{
  const jobWithCut = baseJob({
    cuts: [{ id: "c1", startSeconds: 4, endSeconds: 6 }], // elimina 4-6s -> salida queda en 8s = 240 cuadros
    overlays: [{ id: "o1", type: "text", text: "dentro del corte", startSeconds: 4.5, durationSeconds: 1 }], // 4.5-5.5s, ENTERO dentro del corte
  });
  const plan = planSegments(jobWithCut);
  check("corte de 2s: totalFrames = 240 (10s - 2s cortados = 8s @ 30fps)", plan.totalFrames === 240, `totalFrames=${plan.totalFrames}`);
  check("overlay ENTERO dentro de un corte: desaparece de la salida, 0 cuadros compuestos", plan.compositeFrames === 0, `compositeFrames=${plan.compositeFrames}`);
}

// --- Un corte CORTO dentro del rango de un overlay: la salida es continua (el corte empalma sin dejar hueco), así que sigue siendo UNA sola corrida, solo más corta ---
{
  const jobSplitOverlay = baseJob({
    cuts: [{ id: "c1", startSeconds: 5, endSeconds: 5.4 }], // corte muy corto DENTRO del rango del overlay
    overlays: [{ id: "o1", type: "text", text: "partido", startSeconds: 4.5, durationSeconds: 1.5 }], // 4.5s a 6s, el corte cae en medio
  });
  const plan = planSegments(jobSplitOverlay);
  // tramo 1 (SALIDA): 4.5s-5s (0.5s=15 cuadros); tramo 2 (SALIDA): empieza justo en 5s (donde el corte empalma) y sigue 0.6s más (18 cuadros) -- CONTIGUOS en tiempo de salida, no un hueco: el corte vuelve seamless la edición, como se espera.
  check(
    "overlay con un corte corto en medio: en tiempo de SALIDA queda CONTIGUO (el corte empalma sin hueco) -- 1 sola corrida, más corta",
    plan.compositeRuns === 1,
    `compositeRuns=${plan.compositeRuns}`,
  );
  check("overlay con un corte en medio: duración efectiva = 1.5s - 0.4s cortados = 1.1s = 33 cuadros (no se pierde ni se duplica nada)", plan.byType.overlayFrames === 33, `overlayFrames=${plan.byType.overlayFrames}`);
}

// --- Zoom y overlay superpuestos en el mismo rango: se fusionan, NO se cuentan dos veces en compositeFrames (pero sí cada uno en su byType) ---
{
  const overlapJob = baseJob({
    zooms: [{ id: "z1", startSeconds: 2, endSeconds: 4, fromScale: 1, toScale: 1.3 }],
    overlays: [{ id: "o1", type: "text", text: "superpuesto", startSeconds: 3, durationSeconds: 2 }], // 3-5s, se solapa con el zoom en 3-4s
  });
  const plan = planSegments(overlapJob);
  check("zoom (2-4s) + overlay (3-5s) superpuestos: compositeFrames = 90 (unión 2-5s), no 120 (suma simple)", plan.compositeFrames === 90, `compositeFrames=${plan.compositeFrames}`);
  check("zoom+overlay superpuestos: byType SÍ cuenta cada uno por separado (60 y 60)", plan.byType.zoomFrames === 60 && plan.byType.overlayFrames === 60);
  check("zoom+overlay superpuestos: 1 sola corrida compuesta (se fusionaron)", plan.compositeRuns === 1);
}

// --- Dos regiones compuestas bien separadas: 2 corridas ---
{
  const twoRunsJob = baseJob({
    overlays: [
      { id: "o1", type: "text", text: "primero", startSeconds: 1, durationSeconds: 1 },
      { id: "o2", type: "text", text: "segundo", startSeconds: 7, durationSeconds: 1 },
    ],
  });
  const plan = planSegments(twoRunsJob);
  check("dos overlays bien separados: 2 corridas compuestas distintas", plan.compositeRuns === 2, `compositeRuns=${plan.compositeRuns}`);
  check("dos overlays de 1s cada uno: 60 cuadros compuestos en total", plan.compositeFrames === 60);
}

// --- Job vacío (duración 0): no revienta, todo en 0 ---
{
  const emptyJob = baseJob({ input: { type: "recorded-video", baseVideo: "x.mp4", durationInSeconds: 0 } });
  const plan = planSegments(emptyJob);
  check("duración 0: totalFrames=0, porcentajes en 0 (nunca NaN ni división por cero sin controlar)", plan.totalFrames === 0 && plan.plainPercent === 0 && plan.compositePercent === 0);
}

// --- planChunks: lista ORDENADA de tramos plano/compuesto para el render selectivo (criterio 6) ---

// Sin ningún elemento, sin cortes: 1 solo chunk plano, todo el video.
{
  const plan = planChunks(baseJob());
  check("sin elementos: 1 solo chunk, plano, todo el video (0-300, src 0-10s)", plan.chunks.length === 1 && plan.chunks[0].type === "plain" && plan.chunks[0].outputStartFrame === 0 && plan.chunks[0].outputEndFrame === 300);
  check("sin elementos: el chunk plano mapea al video fuente completo (0s a 10s, sin cortes)", plan.chunks[0].sourceStartSeconds === 0 && plan.chunks[0].sourceEndSeconds === 10);
}

// Un overlay de 2s a 4s, sin cortes: 3 chunks -- plano/compuesto/plano.
{
  const plan = planChunks(baseJob({ overlays: [{ id: "o1", type: "text", text: "x", startSeconds: 2, durationSeconds: 2 }] }));
  check("un overlay de 2-4s: 3 chunks (plano, compuesto, plano)", plan.chunks.map((c) => c.type).join(",") === "plain,composite,plain", JSON.stringify(plan.chunks));
  check("chunk plano inicial: cuadros 0-60, fuente 0-2s", plan.chunks[0].outputStartFrame === 0 && plan.chunks[0].outputEndFrame === 60 && plan.chunks[0].sourceStartSeconds === 0 && plan.chunks[0].sourceEndSeconds === 2);
  check("chunk compuesto: cuadros 60-120, fuente 2-4s", plan.chunks[1].outputStartFrame === 60 && plan.chunks[1].outputEndFrame === 120 && plan.chunks[1].sourceStartSeconds === 2 && plan.chunks[1].sourceEndSeconds === 4);
  check("chunk plano final: cuadros 120-300, fuente 4-10s", plan.chunks[2].outputStartFrame === 120 && plan.chunks[2].outputEndFrame === 300 && plan.chunks[2].sourceStartSeconds === 4 && plan.chunks[2].sourceEndSeconds === 10);
}

// Un corte sin NINGÚN elemento compuesto: igual así, el corte debe PARTIR el único tramo plano en DOS chunks (fuente discontinua -- una sola llamada a FFmpeg no puede saltar de 4s a 6s del original).
{
  const plan = planChunks(baseJob({ cuts: [{ id: "c1", startSeconds: 4, endSeconds: 6 }] }));
  check(
    "corte sin elementos compuestos: 2 chunks PLANOS separados (nunca uno solo que cruce el corte)",
    plan.chunks.length === 2 && plan.chunks.every((c) => c.type === "plain"),
    JSON.stringify(plan.chunks),
  );
  check("chunk plano 1: cuadros 0-120 (salida), fuente 0-4s", plan.chunks[0].outputStartFrame === 0 && plan.chunks[0].outputEndFrame === 120 && plan.chunks[0].sourceStartSeconds === 0 && plan.chunks[0].sourceEndSeconds === 4);
  check("chunk plano 2: cuadros 120-240 (salida, CONTIGUA), fuente 6-10s (discontinua -- por eso no se fusiona con el chunk 1)", plan.chunks[1].outputStartFrame === 120 && plan.chunks[1].outputEndFrame === 240 && plan.chunks[1].sourceStartSeconds === 6 && plan.chunks[1].sourceEndSeconds === 10);
}

// Combinado: un corte de 4-6s MÁS un overlay antes del corte (1-2s) y otro después (7-8s) -- 6 chunks en total, sin fusionar nunca a través del corte.
{
  const plan = planChunks(
    baseJob({
      cuts: [{ id: "c1", startSeconds: 4, endSeconds: 6 }],
      overlays: [
        { id: "o1", type: "text", text: "antes", startSeconds: 1, durationSeconds: 1 },
        { id: "o2", type: "text", text: "despues", startSeconds: 7, durationSeconds: 1 },
      ],
    }),
  );
  check(
    "corte + 2 overlays (uno antes, uno después): 6 chunks -- plano,compuesto,plano,plano,compuesto,plano",
    plan.chunks.map((c) => c.type).join(",") === "plain,composite,plain,plain,composite,plain",
    JSON.stringify(plan.chunks.map((c) => c.type)),
  );
  check(
    "el corte SIGUE partiendo los dos chunks planos adyacentes al corte (índices 2 y 3), aunque ambos sean 'plain'",
    plan.chunks[2].sourceEndSeconds === 4 && plan.chunks[3].sourceStartSeconds === 6 && plan.chunks[2].outputEndFrame === plan.chunks[3].outputStartFrame,
    JSON.stringify([plan.chunks[2], plan.chunks[3]]),
  );
  check("el overlay de después mapea a fuente 7-8s (tiempo ORIGINAL, no afectado por el corte -- el corte es ANTES de él)", plan.chunks[4].sourceStartSeconds === 7 && plan.chunks[4].sourceEndSeconds === 8);
}

check("job de duración 0: planChunks devuelve 0 chunks, nunca lanza", planChunks(baseJob({ input: { type: "recorded-video", baseVideo: "x.mp4", durationInSeconds: 0 } })).chunks.length === 0);

// --- planChunks con fuseGapFrames: dos overlays cercanos se fusionan en UNA invocación de Remotion (criterio 4) ---
{
  // overlays en 1-2s y 2.5-3.5s -- hueco plano de 0.5s = 15 cuadros entre ellos.
  const twoCloseOverlaysJob = baseJob({
    overlays: [
      { id: "o1", type: "text", text: "uno", startSeconds: 1, durationSeconds: 1 },
      { id: "o2", type: "text", text: "dos", startSeconds: 2.5, durationSeconds: 1 },
    ],
  });
  const noFusion = planChunks(twoCloseOverlaysJob, { fuseGapFrames: 0 });
  check("sin fuseGapFrames: 5 chunks (plano,compuesto,plano,compuesto,plano) -- no se fusiona nada", noFusion.chunks.map((c) => c.type).join(",") === "plain,composite,plain,composite,plain", JSON.stringify(noFusion.chunks.map((c) => c.type)));
  check("sin fuseGapFrames: 2 corridas compuestas antes Y después de fusionar (no hubo fusión)", noFusion.compositeRunsBeforeFusion === 2 && noFusion.compositeRunsAfterFusion === 2);

  const fused = planChunks(twoCloseOverlaysJob, { fuseGapFrames: 20 }); // hueco de 15 cuadros <= 20
  check("con fuseGapFrames=20 (hueco real de 15): 3 chunks -- plano,compuesto,plano (las 2 corridas se fusionaron en 1)", fused.chunks.map((c) => c.type).join(",") === "plain,composite,plain", JSON.stringify(fused.chunks.map((c) => c.type)));
  check("fusión: compositeRunsBeforeFusion=2, compositeRunsAfterFusion=1", fused.compositeRunsBeforeFusion === 2 && fused.compositeRunsAfterFusion === 1);
  check("fusión: fusedGapFrames=15 (el hueco real que se absorbió)", fused.fusedGapFrames === 15, `fusedGapFrames=${fused.fusedGapFrames}`);
  check("el chunk compuesto fusionado queda marcado spansCut=false (no hay corte real, solo un hueco plano absorbido)", fused.chunks[1].spansCut === false);
}

// --- planChunks: un chunk compuesto que SÍ cruza un corte real queda marcado spansCut=true y nunca se parte ---
{
  const overlaySpanningCut = baseJob({
    cuts: [{ id: "c1", startSeconds: 4.4, endSeconds: 4.6 }], // corte de 0.2s, DENTRO del rango del overlay
    overlays: [{ id: "o1", type: "text", text: "cruza el corte", startSeconds: 4, durationSeconds: 1 }], // 4-5s, el corte cae en medio
  });
  const plan = planChunks(overlaySpanningCut, { fuseGapFrames: 0 });
  check("overlay con un corte real en medio: sigue siendo 1 sola corrida compuesta (nunca se parte por un corte)", plan.chunks.filter((c) => c.type === "composite").length === 1, JSON.stringify(plan.chunks));
  const compositeChunk = plan.chunks.find((c) => c.type === "composite");
  check("ese chunk compuesto queda marcado spansCut=true (SÍ hay un corte real adentro)", compositeChunk?.spansCut === true);
}

// --- summarizeChunkPlan: cuenta invocaciones reales de Remotion y cuadros por tipo ---
{
  const plan = planChunks(baseJob({ overlays: [{ id: "o1", type: "text", text: "x", startSeconds: 2, durationSeconds: 2 }] }));
  const summary = summarizeChunkPlan(plan);
  check("summarizeChunkPlan: 1 invocación de Remotion (1 chunk compuesto)", summary.remotionInvocations === 1 && summary.compositeChunks === 1);
  check("summarizeChunkPlan: plainFrames=240, compositeFrames=60", summary.plainFrames === 240 && summary.compositeFrames === 60);
}

// --- decideRenderMode: apagado por defecto (producción sin cambios) ---
{
  const job = baseJob();
  const plan = planSegments(job);
  const decision = decideRenderMode({ configuredMode: "full", job, plan });
  check("configuredMode='full' (valor por defecto del servidor): siempre 'full', nunca híbrido aunque el job califique", decision.mode === "full");
}

// --- decideRenderMode: híbrido activado, dentro del umbral ---
{
  const job = baseJob({ overlays: [{ id: "o1", type: "text", text: "x", startSeconds: 1, durationSeconds: 1 }] }); // 10% compuesto
  const plan = planSegments(job);
  const decision = decideRenderMode({ configuredMode: "hybrid", job, plan, maxCompositePercent: 70 });
  check("híbrido activado, 10% compuesto <= 70%: modo 'hybrid'", decision.mode === "hybrid", decision.reason);
}

// --- decideRenderMode: con un plan de planChunks (la forma REAL que usan los dos llamadores de producción, NUNCA planSegments) -- defecto real confirmado en el VPS, 14-nov-2026: salía "undefined corrida(s)" porque planChunks no tiene compositeRuns ---
{
  const job = baseJob({ overlays: [{ id: "o1", type: "text", text: "x", startSeconds: 1, durationSeconds: 1 }] }); // 10% compuesto, 1 corrida
  const chunkPlan = planChunks(job);
  const compositeFrames = chunkPlan.chunks.filter((c) => c.type === "composite").reduce((s, c) => s + c.frames, 0);
  const planWithPercent = { ...chunkPlan, compositePercent: (compositeFrames / chunkPlan.totalFrames) * 100 };
  const decision = decideRenderMode({ configuredMode: "hybrid", job, plan: planWithPercent, maxCompositePercent: 70 });
  check("decideRenderMode con un plan de planChunks: modo 'hybrid'", decision.mode === "hybrid", decision.reason);
  check("decideRenderMode con un plan de planChunks: el mensaje NUNCA dice 'undefined corrida(s)' (cuenta directo de plan.chunks, no de un campo que no existe ahí)", !decision.reason.includes("undefined"), decision.reason);
  check("decideRenderMode con un plan de planChunks: el mensaje dice '1 corrida(s) compuesta(s)' (el número real, no undefined)", decision.reason.includes("1 corrida(s) compuesta(s)"), decision.reason);
}

// --- decideRenderMode: híbrido activado pero el job supera el umbral de % compuesto -- cae a 'full' ---
{
  const job = baseJob({ zooms: [{ id: "z1", startSeconds: 0, endSeconds: 9, fromScale: 1, toScale: 1.1 }] }); // 90% compuesto
  const plan = planSegments(job);
  const decision = decideRenderMode({ configuredMode: "hybrid", job, plan, maxCompositePercent: 70 });
  check("híbrido activado, 90% compuesto > 70%: cae a 'full' (el híbrido ya no conviene)", decision.mode === "full", decision.reason);
}

// --- decideRenderMode: solo aplica a video grabado con baseVideo resuelto ---
{
  const notRecordedJob = { ...baseJob(), input: { type: "ai-generated", durationInSeconds: 10 } };
  const plan = planSegments(notRecordedJob);
  const decision = decideRenderMode({ configuredMode: "hybrid", job: notRecordedJob, plan });
  check("híbrido activado pero el job no es video grabado: cae a 'full'", decision.mode === "full", decision.reason);
}

// --- decideRenderMode: un reintento puede forzar 'full' explícitamente aunque el servidor tenga RENDER_MODE=hybrid ---
{
  const job = baseJob();
  const plan = planSegments(job);
  const decision = decideRenderMode({ configuredMode: "hybrid", override: "full", job, plan });
  check("override='full' en el reintento: fuerza 'full' aunque el servidor tenga RENDER_MODE=hybrid", decision.mode === "full" && /pedido explícitamente/.test(decision.reason));
}

// --- chooseRepresentativeWindow (adenda del auditor, 14-nov-2026, criterio 7): la ventana se dimensiona a partir del tramo compuesto REAL para que quede por debajo de targetCompositeFraction, no "cubrir el compuesto + un margen fijo" (eso dio 63% compuesto en el VPS real, nada representativo) ---
{
  // Job de 60s @ 30fps = 1800 cuadros; un overlay de 2s (60 cuadros) empezando a los 20s (cuadro 600) -- margen plano de sobra antes Y después.
  const job = baseJob({ input: { type: "recorded-video", baseVideo: "x.mp4", durationInSeconds: 60 }, overlays: [{ id: "o1", type: "text", text: "x", startSeconds: 20, durationSeconds: 2 }] });
  const plan = planChunks(job);
  const { windowStartFrame, windowFrames, achievedCompositeFraction } = chooseRepresentativeWindow(plan, { targetCompositeFraction: 0.15, minWindowFrames: 30, maxWindowFrames: 1000, fps: 30 });
  check("chooseRepresentativeWindow: windowFrames = compositeFrames/targetCompositeFraction = 60/0.15 = 400 (no un margen fijo)", windowFrames === 400, `windowFrames=${windowFrames}`);
  check("chooseRepresentativeWindow: logra EXACTO el 15% objetivo cuando hay margen plano de sobra", achievedCompositeFraction === 0.15, `achievedCompositeFraction=${achievedCompositeFraction}`);
  check("chooseRepresentativeWindow: windowStartFrame es DISTINTO de 0 -- la ventana queda CENTRADA sobre el tramo compuesto (170 cuadros de margen antes, 600-170=430), no forzada a arrancar desde el principio del video", windowStartFrame === 430, `windowStartFrame=${windowStartFrame}`);

  const clipped = clipChunksToRange(plan, windowStartFrame, windowStartFrame + windowFrames, { fps: 30 });
  check("clipChunksToRange: totalFrames = el tamaño de la ventana (400), no el del job completo", clipped.totalFrames === 400);
  check("clipChunksToRange: el chunk compuesto sigue con sus cuadros ABSOLUTOS (600-660) -- Remotion los necesita así para --frames de la composición COMPLETA, no reindexados a la ventana", clipped.chunks.some((c) => c.type === "composite" && c.outputStartFrame === 600 && c.outputEndFrame === 660), JSON.stringify(clipped.chunks));
  check("clipChunksToRange: el primer chunk (plano) se recorta EXACTO al borde de la ventana (empieza en el cuadro 430, absoluto)", clipped.chunks[0].outputStartFrame === 430);
}

{
  // Mismo job, pero maxWindowFrames muy chico (100): no alcanza el 15% -- la función lo dice con evidencia (achievedCompositeFraction), nunca lo esconde.
  const job = baseJob({ input: { type: "recorded-video", baseVideo: "x.mp4", durationInSeconds: 60 }, overlays: [{ id: "o1", type: "text", text: "x", startSeconds: 20, durationSeconds: 2 }] });
  const plan = planChunks(job);
  const { windowFrames, achievedCompositeFraction } = chooseRepresentativeWindow(plan, { targetCompositeFraction: 0.15, minWindowFrames: 30, maxWindowFrames: 100, fps: 30 });
  check("chooseRepresentativeWindow: con maxWindowFrames=100, la ventana queda acotada a 100 (nunca se pasa del tope por alcanzar el objetivo)", windowFrames === 100, `windowFrames=${windowFrames}`);
  check("chooseRepresentativeWindow: el % compuesto REAL logrado (60%) queda por ENCIMA del objetivo -- se reporta con el número real, nunca se oculta ni se finge 15%", achievedCompositeFraction === 0.6, `achievedCompositeFraction=${achievedCompositeFraction}`);
}

{
  // Sin ningún tramo compuesto: ventana simple desde el cuadro 0, del tamaño mínimo.
  const job = baseJob({ input: { type: "recorded-video", baseVideo: "x.mp4", durationInSeconds: 60 } });
  const plan = planChunks(job);
  const { windowStartFrame, windowFrames, achievedCompositeFraction } = chooseRepresentativeWindow(plan, { targetCompositeFraction: 0.15, minWindowFrames: 150, maxWindowFrames: 1000, fps: 30 });
  check("chooseRepresentativeWindow sin tramos compuestos: arranca en 0, tamaño minWindowFrames, 0% compuesto", windowStartFrame === 0 && windowFrames === 150 && achievedCompositeFraction === 0);
}

// --- clipTimelineToOutputRange: recorta una línea de tiempo (con cortes) a un RANGO [inicio, fin) de SALIDA (no solo desde el segundo 0) ---
{
  const timeline = buildTimeline(10, [{ startSeconds: 4, endSeconds: 6 }]); // salida: 0-4s (de 0-4 original) + 4-8s (de 6-10 original)
  const clipped = clipTimelineToOutputRange(timeline, 1, 5); // ventana de SALIDA 1s-5s (NO desde 0)
  check("clipTimelineToOutputRange: outputDurationInSeconds = fin-inicio = 4", clipped.outputDurationInSeconds === 4, JSON.stringify(clipped));
  check("clipTimelineToOutputRange: 2 tramos (el corte sigue aplicado dentro de la ventana)", clipped.segments.length === 2, JSON.stringify(clipped.segments));
  check("clipTimelineToOutputRange: el primer tramo se reindexa a outputStart=0 (la ventana es su propio archivo, empieza en su propio tiempo 0), pero su sourceStart ABSOLUTO se recorta a 1 (se saltó el primer segundo de fuente)", clipped.segments[0].outputStart === 0 && clipped.segments[0].sourceStart === 1, JSON.stringify(clipped.segments[0]));
  check("clipTimelineToOutputRange: el segundo tramo se acorta a su fin real de ventana (outputEnd=4, relativo), fuente ABSOLUTA 6-7s (el corte sigue aplicado, nunca se recalcula distinto)", clipped.segments[1].outputEnd === 4 && clipped.segments[1].sourceStart === 6 && clipped.segments[1].sourceEnd === 7, JSON.stringify(clipped.segments[1]));
}

console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
process.exit(failures === 0 ? 0 : 1);
