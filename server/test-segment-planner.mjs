// PRUEBA SIMULADA (nivel 2 de honestidad de evidencia, CLAUDE.md) --
// server/segment-planner.mjs: pura, con jobs construidos a mano y
// aritmética conocida de antemano (no depende de ningún video real).
// La confirmación de que esto sirve con jobs REALES persistidos
// (1fd239de y otros) es la puerta G0 -- solo se puede correr en el
// VPS, ver el informe de esta tarea para los pasos exactos.

import { planSegments, planChunks } from "./segment-planner.mjs";

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

console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
process.exit(failures === 0 ? 0 : 1);
