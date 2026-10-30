// PRUEBA SIMULADA — no llama a la API real de Claude. Inyecta un cliente
// falso para probar la lógica real de construcción de prompt, parseo y
// validación de server/editorial.mjs contra varias respuestas de modelo
// (una buena, una con JSON envuelto en bloque de código, una con un corte
// inválido mezclado con uno válido, una que no es JSON en absoluto, y que
// el prompt pida la precisión de corte correcta según si hay tiempos por
// palabra o solo por línea agrupada).
import assert from "node:assert/strict";
import {
  planEdit,
  parseEditorialResponse,
  mergeNearbyGaplessCuts,
  clampCtaDuration,
  __setAnthropicClientForTesting,
} from "./editorial.mjs";
import { buildTimeline } from "./timeline.mjs";

const fakeCaptions = [
  { text: "Hola, bienvenidos al canal.", startMs: 0, endMs: 2000, timestampMs: null, confidence: null },
  { text: "Eh, este, hoy vamos a hablar de...", startMs: 2000, endMs: 5000, timestampMs: null, confidence: null },
  { text: "hoy vamos a hablar de un tema importante.", startMs: 5000, endMs: 8000, timestampMs: null, confidence: null },
];

// planEdit() ahora siempre hace una segunda llamada chica para el CTA
// obligatorio de mitad de video (Decisión 6). Para no interferir con
// pruebas que no son específicamente sobre esa función, la 2da llamada
// en adelante devuelve "sin recurso, costo cero" -- el plan principal
// queda exactamente como antes.
const makeFakeClient = (responseText) => {
  let callIndex = 0;
  return {
    messages: {
      create: async () => {
        callIndex += 1;
        if (callIndex === 1) {
          return {
            content: [{ type: "text", text: responseText }],
            usage: { input_tokens: 123, output_tokens: 45 },
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify({ cuts: [], zooms: [], resources: [], notes: "" }) }],
          usage: { input_tokens: 0, output_tokens: 0 },
        };
      },
    },
  };
};

let failures = 0;
const check = (label, cond) => {
  if (!cond) {
    failures++;
    console.log(`FAIL: ${label}`);
  } else {
    console.log(`ok: ${label}`);
  }
};

// 1. Respuesta válida y limpia.
{
  const good = JSON.stringify({
    cuts: [{ startSeconds: 2, endSeconds: 5, reason: "titubeo, repite la frase después" }],
    zooms: [{ startSeconds: 5, endSeconds: 8, fromScale: 1, toScale: 1.2, origin: { x: 0.5, y: 0.35 }, reason: "énfasis" }],
    notes: "Corté el titubeo inicial; el presentador repite la idea completa justo después.",
  });
  __setAnthropicClientForTesting(makeFakeClient(good));
  const plan = await planEdit({
    captions: fakeCaptions,
    guidelines: "guía de prueba",
    durationInSeconds: 8,
    destination: "youtube-16-9",
  });
  check("respuesta válida: 1 corte", plan.cuts.length === 1);
  check("respuesta válida: 1 zoom", plan.zooms.length === 1);
  check("respuesta válida: notes presente", plan.notes.length > 0);
  check("respuesta válida: métricas con tokens", plan.metrics.inputTokens === 123 && plan.metrics.outputTokens === 45);
}

// 1b. Con `transcriptWords` (palabra por palabra), el prompt debe pedir
// precisión de PALABRA, no de línea -- y usar las palabras, no las líneas
// agrupadas, como transcripción.
{
  const fakeWords = [
    { text: "Hola", startMs: 0, endMs: 300, timestampMs: null, confidence: null },
    { text: "cuerpo", startMs: 300, endMs: 600, timestampMs: null, confidence: null },
    { text: "cuerpo", startMs: 600, endMs: 900, timestampMs: null, confidence: null },
  ];
  let capturedPrompt = "";
  let callIndex = 0;
  __setAnthropicClientForTesting({
    messages: {
      create: async (params) => {
        callIndex += 1;
        if (callIndex === 1) capturedPrompt = params.messages[0].content;
        return {
          content: [{ type: "text", text: JSON.stringify({ cuts: [], zooms: [], resources: [], notes: "" }) }],
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    },
  });
  await planEdit({
    captions: fakeCaptions,
    transcriptWords: fakeWords,
    guidelines: "guía de prueba",
    durationInSeconds: 8,
    destination: "youtube-16-9",
  });
  check("con transcriptWords: el prompt pide precisión de palabra", capturedPrompt.includes("límite entre dos palabras consecutivas"));
  check("con transcriptWords: usa las palabras, no las líneas agrupadas", capturedPrompt.includes("[0.30-0.60] cuerpo") && !capturedPrompt.includes("Eh, este, hoy vamos a hablar"));
}

// 1c. Sin `transcriptWords` (job con captions manuales, sin transcripción automática): vuelve al modo línea, honesto sobre su propia precisión.
{
  let capturedPrompt = "";
  let callIndex = 0;
  __setAnthropicClientForTesting({
    messages: {
      create: async (params) => {
        callIndex += 1;
        if (callIndex === 1) capturedPrompt = params.messages[0].content;
        return {
          content: [{ type: "text", text: JSON.stringify({ cuts: [], zooms: [], resources: [], notes: "" }) }],
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    },
  });
  await planEdit({
    captions: fakeCaptions,
    guidelines: "guía de prueba",
    durationInSeconds: 8,
    destination: "youtube-16-9",
  });
  check("sin transcriptWords: el prompt pide precisión de línea", capturedPrompt.includes("límites entre líneas"));
  check("sin transcriptWords: usa las líneas agrupadas", capturedPrompt.includes("Eh, este, hoy vamos a hablar"));
}

// Bug real: con la transcripción palabra por palabra de un video largo,
// el modelo devolvió una respuesta VACÍA (consistente con haber agotado
// max_tokens antes de escribir el JSON). Estos casos reproducen eso sin
// necesitar un video real ni la API real.
const makeSequencedFakeClient = (responses) => {
  let callIndex = 0;
  const calls = [];
  return {
    calls,
    client: {
      messages: {
        create: async (params) => {
          calls.push({ maxTokens: params.max_tokens, thinking: params.thinking });
          const response = responses[Math.min(callIndex, responses.length - 1)];
          callIndex += 1;
          return response;
        },
      },
    },
  };
};

// 1d. Primera respuesta vacía con stop_reason="max_tokens" -> reintenta UNA vez con más max_tokens, y esa segunda sí sirve.
{
  const { client, calls } = makeSequencedFakeClient([
    { content: [], stop_reason: "max_tokens", usage: { input_tokens: 9000, output_tokens: 4096 } },
    {
      content: [{ type: "text", text: JSON.stringify({ cuts: [], zooms: [], notes: "ok en el reintento" }) }],
      stop_reason: "end_turn",
      usage: { input_tokens: 9000, output_tokens: 300 },
    },
  ]);
  __setAnthropicClientForTesting(client);
  const plan = await planEdit({
    captions: fakeCaptions,
    guidelines: "guía de prueba",
    durationInSeconds: 8,
    destination: "youtube-16-9",
  });
  // 3 llamadas: intento + reintento del plan principal, más la llamada
  // aparte (siempre ocurre) del CTA obligatorio de mitad de video.
  check("respuesta vacía por max_tokens: reintenta exactamente una vez (3 llamadas: intento + reintento + CTA de mitad)", calls.length === 3);
  check("respuesta vacía por max_tokens: el reintento pide más max_tokens que el primer intento", calls[1].maxTokens > calls[0].maxTokens);
  // Bug real: el razonamiento interno competía por el mismo presupuesto
  // que max_tokens y a veces se lo comía entero (respuesta vacía en
  // producción). Confirmado con la API real que desactivarlo arregla
  // esto sin perder calidad editorial -- este chequeo evita que alguien
  // lo reactive sin querer en el futuro.
  check("las 3 llamadas piden el razonamiento desactivado", calls.every((c) => c.thinking?.type === "disabled"));
  check("respuesta vacía por max_tokens: el plan final es el del reintento", plan.notes === "ok en el reintento");
  check("respuesta vacía por max_tokens: metrics.retried=true", plan.metrics.retried === true);
  check("respuesta vacía por max_tokens: metrics.stopReason es del último intento", plan.metrics.stopReason === "end_turn");
}

// 1e. Si el reintento TAMBIÉN sale vacío, no hay un tercer intento -- falla con un error claro (no silencioso).
{
  const { client, calls } = makeSequencedFakeClient([
    { content: [], stop_reason: "max_tokens", usage: { input_tokens: 9000, output_tokens: 4096 } },
    { content: [], stop_reason: "max_tokens", usage: { input_tokens: 9000, output_tokens: 32000 } },
  ]);
  __setAnthropicClientForTesting(client);
  let threw = false;
  try {
    await planEdit({
      captions: fakeCaptions,
      guidelines: "guía de prueba",
      durationInSeconds: 8,
      destination: "youtube-16-9",
    });
  } catch {
    threw = true;
  }
  check("reintento también vacío: no hay un tercer intento (solo 2 llamadas en total)", calls.length === 2);
  check("reintento también vacío: planEdit lanza error en vez de devolver un plan vacío silenciosamente", threw);
}

// Fase 2: planificación de recursos audiovisuales.

// 1f. resources:[] es un resultado válido -- no se fuerza ningún mínimo.
{
  const empty = JSON.stringify({ cuts: [], zooms: [], resources: [], notes: "nada que agregar, el video funciona solo" });
  const plan = parseEditorialResponse(empty, 8);
  check("resources vacío: se acepta sin error", Array.isArray(plan.resources) && plan.resources.length === 0);
  check("resources vacío: sin issues", plan.resourceIssues.length === 0);
}

// 1g. Un recurso válido completo se parsea con todos sus campos.
{
  const good = JSON.stringify({
    cuts: [],
    zooms: [],
    resources: [
      {
        startSeconds: 10,
        endSeconds: 14,
        type: "broll",
        description: "Captura de pantalla del paper original de Cameron Sepah",
        justification: "menciona el estudio de Sepah",
        editorialGoal: "evidence",
        segment: "development",
        intensity: "moderate",
        veracityRequirement: "must-be-real",
        essential: false,
        provenanceNotes: "licencia editorial o captura propia, no stock genérico",
      },
    ],
    notes: "",
  });
  const plan = parseEditorialResponse(good, 20);
  check("recurso válido: se acepta", plan.resources.length === 1);
  check("recurso válido: conserva el tipo", plan.resources[0].type === "broll");
  check("recurso válido: conserva segment/editorialGoal", plan.resources[0].segment === "development" && plan.resources[0].editorialGoal === "evidence");
  check("recurso válido: must-be-real no fuerza essential=true por sí solo", plan.resources[0].veracityRequirement === "must-be-real" && plan.resources[0].essential === false);
}

// 1h. essential=true se respeta cuando el modelo lo pide explícitamente (independiente de veracityRequirement).
{
  const essentialOne = JSON.stringify({
    cuts: [],
    zooms: [],
    resources: [
      {
        startSeconds: 1,
        endSeconds: 2,
        type: "graphic",
        description: "Gráfico con la cifra citada en el minuto 1",
        editorialGoal: "evidence",
        segment: "development",
        intensity: "moderate",
        veracityRequirement: "illustrative-ok",
        essential: true,
      },
    ],
    notes: "",
  });
  const plan = parseEditorialResponse(essentialOne, 8);
  check("essential=true se conserva aunque veracityRequirement sea illustrative-ok (son independientes)", plan.resources[0].essential === true);
}

// 1i. Un recurso inválido (tipo no reconocido) se descarta CON razón registrada, sin tirar el resto del plan.
{
  const mixed = JSON.stringify({
    cuts: [],
    zooms: [],
    resources: [
      { startSeconds: 1, endSeconds: 2, type: "holograma-3d", description: "inventado", editorialGoal: "emphasis", segment: "intro" },
      { startSeconds: 3, endSeconds: 4, type: "image", description: "foto real del lugar mencionado", editorialGoal: "context", segment: "development" },
    ],
    notes: "",
  });
  const plan = parseEditorialResponse(mixed, 8);
  check("recurso con tipo inválido: se descarta, el válido sobrevive", plan.resources.length === 1 && plan.resources[0].type === "image");
  check("recurso con tipo inválido: queda registrado en resourceIssues con su motivo", plan.resourceIssues.some((issue) => issue.includes("holograma-3d")));
}

// 1j. El perfil de recursos del canal (qué nunca fabricar) y el historial de correcciones llegan al prompt.
{
  let capturedPrompt = "";
  let callIndex = 0;
  __setAnthropicClientForTesting({
    messages: {
      create: async (params) => {
        callIndex += 1;
        if (callIndex === 1) capturedPrompt = params.messages[0].content;
        return {
          content: [{ type: "text", text: JSON.stringify({ cuts: [], zooms: [], resources: [], notes: "" }) }],
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    },
  });
  await planEdit({
    captions: fakeCaptions,
    guidelines: "guía de prueba",
    resourceProfile: { allowedResourceTypes: ["graphic"], neverFabricate: ["financial-data"] },
    correctionsHistory: [{ segment: "intro", resourceType: "broll", reason: "B-roll excesivo en la introducción", example: "canal A, cap 3" }],
    durationInSeconds: 8,
    destination: "youtube-16-9",
  });
  check("perfil de recursos: el prompt incluye la restricción de nunca fabricar", capturedPrompt.includes("NUNCA inventes ni presentes como real: financial-data"));
  check("historial de correcciones: el prompt lo incluye como referencia", capturedPrompt.includes("B-roll excesivo en la introducción"));
}

// Decisión 6 del auditor: CTA obligatorio de mitad de video, calculado
// sobre la línea temporal YA EDITADA (no la ingenua del original).
{
  // Video de 10s, un corte de 0-4s -> línea editada: source 4-10 mapea a
  // output 0-6 (6s de salida). Punto medio de la salida = 3s -> de vuelta
  // al original: 4 + (3-0) = 7s. Si se usara el punto medio INGENUO del
  // original (10/2=5s) estaría mal -- cae todavía dentro de lo cortado.
  let callIndex = 0;
  let middleCtaPrompt = "";
  __setAnthropicClientForTesting({
    messages: {
      create: async (params) => {
        callIndex += 1;
        if (callIndex === 1) {
          return {
            content: [{ type: "text", text: JSON.stringify({
              cuts: [{ startSeconds: 0, endSeconds: 4, reason: "intro descartada" }],
              zooms: [],
              resources: [],
              notes: "plan principal",
            }) }],
            stop_reason: "end_turn",
            usage: { input_tokens: 100, output_tokens: 50 },
          };
        }
        middleCtaPrompt = params.messages[0].content;
        return {
          content: [{ type: "text", text: JSON.stringify({
            cuts: [],
            zooms: [],
            resources: [{
              startSeconds: 7.0, endSeconds: 9.0,
              type: "text-highlight", description: "like y suscríbete",
              editorialGoal: "emphasis", segment: "development",
              intensity: "subtle", veracityRequirement: "illustrative-ok", essential: false,
            }],
            notes: "",
          }) }],
          stop_reason: "end_turn",
          usage: { input_tokens: 20, output_tokens: 10 },
        };
      },
    },
  });
  const plan = await planEdit({
    captions: fakeCaptions,
    guidelines: "guía de prueba",
    durationInSeconds: 10,
    destination: "youtube-16-9",
  });
  check("CTA de mitad: el punto medio pasado al modelo es el de la línea EDITADA (7.00s), no el ingenuo (5s)", middleCtaPrompt.includes("7.00 segundos") || middleCtaPrompt.includes("7.00s"));
  check("CTA de mitad: el recurso devuelto se suma al plan principal", plan.resources.length === 1 && plan.resources[0].description === "like y suscríbete");
  check("CTA de mitad: sus tokens se suman al total del plan", plan.metrics.inputTokens === 120 && plan.metrics.outputTokens === 60);
  check("CTA de mitad: queda registrado aparte en metrics.middleCta", plan.metrics.middleCta?.inputTokens === 20);
}

// CTA de mitad excedido de duración (defecto real de la corrida sobre
// ff69b475: 29s en vez de un recordatorio puntual) -- planMiddleCta()
// debe recortarlo al tope de 8s igual que si viniera de la llamada
// principal, y seguir tageándolo "middle" normalmente.
{
  let callIndex = 0;
  __setAnthropicClientForTesting({
    messages: {
      create: async () => {
        callIndex += 1;
        if (callIndex === 1) {
          return {
            content: [{ type: "text", text: JSON.stringify({ cuts: [], zooms: [], resources: [], notes: "" }) }],
            stop_reason: "end_turn",
            usage: { input_tokens: 100, output_tokens: 50 },
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify({
            cuts: [],
            zooms: [],
            // Duración 8.5s -- excede el tope de 8s pero sigue dentro de
            // los 10s totales del video de prueba (si no, se descartaría
            // antes de llegar al clamp por tiempos fuera de rango).
            resources: [{
              startSeconds: 1.0, endSeconds: 9.5,
              type: "text-highlight", description: "like y suscríbete, todo el bloque",
              editorialGoal: "emphasis", segment: "development",
              intensity: "subtle", veracityRequirement: "illustrative-ok", essential: false,
            }],
            notes: "",
          }) }],
          stop_reason: "end_turn",
          usage: { input_tokens: 20, output_tokens: 10 },
        };
      },
    },
  });
  const plan = await planEdit({ captions: fakeCaptions, guidelines: "guía", durationInSeconds: 10, destination: "youtube-16-9" });
  const middleCta = plan.resources.find((r) => r.ctaPosition === "middle");
  check("CTA de mitad excedido (8.5s) vía planMiddleCta: se recorta al tope de 8s", middleCta && middleCta.endSeconds - middleCta.startSeconds === 8);
  check("CTA de mitad recortado vía planMiddleCta: conserva su startSeconds (1.0)", middleCta && middleCta.startSeconds === 1.0);
}

// Si el modelo no propone ningún CTA de mitad (p.ej. no encaja en ese tramo), no se agrega nada y el resto del plan sigue intacto.
{
  let callIndex = 0;
  __setAnthropicClientForTesting({
    messages: {
      create: async () => {
        callIndex += 1;
        const text = callIndex === 1
          ? JSON.stringify({ cuts: [], zooms: [], resources: [{ startSeconds: 1, endSeconds: 2, type: "graphic", description: "x", editorialGoal: "context", segment: "development" }], notes: "" })
          : JSON.stringify({ cuts: [], zooms: [], resources: [], notes: "" });
        return { content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } };
      },
    },
  });
  const plan = await planEdit({ captions: fakeCaptions, guidelines: "guía", durationInSeconds: 8, destination: "youtube-16-9" });
  check("sin CTA de mitad propuesto: el plan principal no pierde sus propios recursos", plan.resources.length === 1);
}

// 2. JSON envuelto en bloque de código markdown (el modelo no debería hacerlo, pero puede pasar).
{
  const fenced = "```json\n" + JSON.stringify({ cuts: [], zooms: [], notes: "nada que cortar" }) + "\n```";
  const plan = parseEditorialResponse(fenced, 8);
  check("JSON en bloque de código: se parsea igual", plan.notes === "nada que cortar");
}

// 3. Un corte inválido (fuera de rango) mezclado con uno válido: se descarta solo el malo.
{
  const mixed = JSON.stringify({
    cuts: [
      { startSeconds: 2, endSeconds: 5, reason: "válido" },
      { startSeconds: 100, endSeconds: 200, reason: "fuera de la duración del video" },
      { startSeconds: 5, endSeconds: 3, reason: "fin antes que inicio, inválido" },
    ],
    zooms: [],
    notes: "",
  });
  const plan = parseEditorialResponse(mixed, 8);
  check("corte inválido descartado, válido se mantiene: queda 1", plan.cuts.length === 1);
  check("corte inválido descartado: el que queda es el correcto", plan.cuts[0].startSeconds === 2);
}

// Bug real: una corrida propuso 91 cortes, varios de 10-70ms -- ruido
// sin valor editorial propio. Se descartan con su motivo registrado.
{
  const withMicrocuts = JSON.stringify({
    cuts: [
      { startSeconds: 2, endSeconds: 5, reason: "corte real, 3s" },
      { startSeconds: 10, endSeconds: 10.04, reason: "microcorte de 40ms" },
      { startSeconds: 20, endSeconds: 20.3, reason: "justo en el límite, 0.3s, válido" },
    ],
    zooms: [],
    notes: "",
  });
  const plan = parseEditorialResponse(withMicrocuts, 30);
  check("microcorte (40ms) descartado, los demás sobreviven: quedan 2", plan.cuts.length === 2);
  check("microcorte descartado: queda registrado en cutIssues con su motivo", plan.cutIssues.some((i) => i.includes("40ms") || i.includes("microcorte sin valor editorial")));
}

// Fusión de cortes casi contiguos (Decisión 1 del auditor): un hueco
// menor al umbral SIN palabra real en el medio se fusiona; uno CON
// palabra real no se toca, aunque sea igual de chico.
{
  const cuts = [
    { id: "a", startSeconds: 125.82, endSeconds: 130.26 },
    { id: "b", startSeconds: 130.37, endSeconds: 183.38 }, // hueco de 0.11s, sin palabra
    { id: "c", startSeconds: 183.38, endSeconds: 207.83 }, // tocan exacto, siempre se fusiona
  ];
  const words = [
    { text: "hola", startMs: 0, endMs: 300, timestampMs: null, confidence: null },
    { text: "mundo", startMs: 300, endMs: 600, timestampMs: null, confidence: null },
  ];
  const { cuts: merged, mergeLog } = mergeNearbyGaplessCuts(cuts, words);
  check("fusión real (caso del auditor): 3 cortes quedan en 1", merged.length === 1);
  check("fusión real: cubre todo el rango 125.82-207.83", merged[0].startSeconds === 125.82 && merged[0].endSeconds === 207.83);
  check("fusión real: el log explica la fusión", mergeLog.length >= 1);

  // Ahora el mismo hueco de 0.11s, pero con una palabra real adentro -- NO debe fusionarse.
  const cutsWithWordInGap = [
    { id: "a", startSeconds: 125.82, endSeconds: 130.26 },
    { id: "b", startSeconds: 130.37, endSeconds: 183.38 },
  ];
  const wordsInGap = [{ text: "no", startMs: 130300, endMs: 130350, timestampMs: null, confidence: null }];
  const result2 = mergeNearbyGaplessCuts(cutsWithWordInGap, wordsInGap);
  check("hueco con palabra real adentro: NO se fusiona (se conservan 2 cortes)", result2.cuts.length === 2);
  check("hueco con palabra real: el log explica por qué no se fusionó", result2.mergeLog.some((l) => l.includes("NO fusionado")));

  // Sin transcriptWords (job con captions manuales): el hueco de 0.11s NO
  // se toca (no se puede verificar), pero b y c, que se TOCAN exacto
  // (hueco=0, no cabe ninguna palabra ahí posible), sí se fusionan
  // siempre -- con o sin datos por palabra.
  const result3 = mergeNearbyGaplessCuts(cuts, undefined);
  check("sin transcriptWords: el hueco de 0.11s no se toca, pero el que se tocan exacto sí se fusiona -> quedan 2", result3.cuts.length === 2);
}

// 3b. Corrección menor B del auditor (cierre de validación screen-share,
// 30-oct-2026): cortes anidados o solapados (gap NEGATIVO) deben
// unificarse en la lista final -- bug real encontrado: la condición
// original exigía `gap >= 0`, dejando un corte anidado listado aparte
// como si fueran dos cortes distintos, en vez de uno solo.
{
  // Anidado: b (20-30) cae entero dentro de a (10-50).
  const nested = [
    { id: "a", startSeconds: 10, endSeconds: 50 },
    { id: "b", startSeconds: 20, endSeconds: 30 },
  ];
  const resultNested = mergeNearbyGaplessCuts(nested, undefined);
  check("corte anidado: se unifica en 1 solo corte", resultNested.cuts.length === 1);
  check("corte anidado: el unificado cubre todo 10-50 (el rango externo, no se achica)", resultNested.cuts[0].startSeconds === 10 && resultNested.cuts[0].endSeconds === 50);
  check("corte anidado: queda registrado en el log", resultNested.mergeLog.some((l) => l.includes("solapado/anidado")));

  // Solapado parcial: a (10-30) y b (25-40) se cruzan sin que uno esté
  // adentro del otro -- el unificado debe cubrir la unión completa.
  const overlapping = [
    { id: "a", startSeconds: 10, endSeconds: 30 },
    { id: "b", startSeconds: 25, endSeconds: 40 },
  ];
  const resultOverlap = mergeNearbyGaplessCuts(overlapping, undefined);
  check("cortes solapados (parcial): se unifican en 1 solo corte", resultOverlap.cuts.length === 1);
  check("cortes solapados: el unificado cubre la unión completa (10-40)", resultOverlap.cuts[0].startSeconds === 10 && resultOverlap.cuts[0].endSeconds === 40);

  // Tres cortes: dos se solapan entre sí, el tercero está lejos -- solo
  // los dos solapados se unifican, el tercero queda separado.
  const mixed = [
    { id: "a", startSeconds: 10, endSeconds: 30 },
    { id: "b", startSeconds: 15, endSeconds: 20 }, // anidado en a
    { id: "c", startSeconds: 100, endSeconds: 110 }, // lejos, no se toca
  ];
  const resultMixed = mergeNearbyGaplessCuts(mixed, undefined);
  check("solapado + corte lejano: quedan 2 cortes (el unificado + el lejano)", resultMixed.cuts.length === 2);
  check("solapado + corte lejano: el corte lejano no se tocó", resultMixed.cuts.some((c) => c.startSeconds === 100 && c.endSeconds === 110));

  // La duración editada tiene que ser la MISMA se le pase a buildTimeline
  // la lista cruda (con el anidado listado aparte) o la ya unificada --
  // normalizeCuts (dentro de buildTimeline) ya resolvía esto internamente
  // incluso antes de esta corrección; lo que cambia es solo la prolijidad
  // de la lista final de cortes, nunca la duración calculada.
  const videoDuration = 200;
  const timelineFromRaw = buildTimeline(videoDuration, nested);
  const timelineFromMerged = buildTimeline(videoDuration, resultNested.cuts);
  check(
    "duración editada: igual con la lista cruda (anidada) o con la ya unificada",
    timelineFromRaw.outputDurationInSeconds === timelineFromMerged.outputDurationInSeconds,
  );
}

// 4. Zoom con escala fuera de límites de seguridad se recorta, no se descarta.
{
  const extreme = JSON.stringify({
    cuts: [],
    zooms: [{ startSeconds: 0, endSeconds: 2, fromScale: 1, toScale: 50, reason: "exagerado" }],
    notes: "",
  });
  const plan = parseEditorialResponse(extreme, 8);
  check("zoom extremo se recorta a 2x en vez de descartarse", plan.zooms.length === 1 && plan.zooms[0].toScale === 2);
}

// 4b. CTA que se excede del tope de duración se recorta, no se descarta
// (defecto real observado en la corrida sobre el job ff69b475: CTA de
// 53-54s en vez de un recordatorio puntual).
{
  const longCta = JSON.stringify({
    cuts: [],
    zooms: [],
    resources: [
      {
        startSeconds: 10,
        endSeconds: 63,
        type: "graphic",
        description: "recordatorio de suscripción",
        editorialGoal: "emphasis",
        segment: "intro",
        ctaPosition: "start",
      },
      {
        startSeconds: 100,
        endSeconds: 105,
        type: "graphic",
        description: "CTA de cierre ya breve",
        editorialGoal: "emphasis",
        segment: "closing",
        ctaPosition: "end",
      },
    ],
    notes: "",
  });
  const plan = parseEditorialResponse(longCta, 200);
  const startCta = plan.resources.find((r) => r.ctaPosition === "start");
  const endCta = plan.resources.find((r) => r.ctaPosition === "end");
  check("CTA de inicio excedido (53s): se recorta al tope de 15s", startCta && startCta.endSeconds - startCta.startSeconds === 15);
  check("CTA de inicio recortado: conserva su startSeconds original (10)", startCta && startCta.startSeconds === 10);
  check("CTA de cierre ya breve (5s): no se toca", endCta && endCta.endSeconds - endCta.startSeconds === 5);
  check("CTA de inicio excedido: queda registrado en ctaDurationAdjustments", plan.ctaDurationAdjustments.some((a) => a.includes('"start"')));
  check("CTA de cierre ya breve: no genera ajuste", !plan.ctaDurationAdjustments.some((a) => a.includes('"end"')));
}

// 4c. clampCtaDuration() en forma aislada -- incluye el caso "middle"
// (8s de tope), que no se autoetiqueta en la respuesta cruda del modelo
// sino que lo fuerza planMiddleCta() después de parsear.
{
  const result = clampCtaDuration({ startSeconds: 50, endSeconds: 79, ctaPosition: "middle" });
  check("CTA de mitad excedido (29s): se recorta al tope de 8s", result.adjusted && result.resource.endSeconds - result.resource.startSeconds === 8);
  check("CTA de mitad recortado: conserva su startSeconds (50)", result.resource.startSeconds === 50);

  const untouched = clampCtaDuration({ startSeconds: 50, endSeconds: 55, ctaPosition: "middle" });
  check("CTA de mitad dentro del tope (5s): no se toca", !untouched.adjusted && untouched.resource.endSeconds === 55);

  const noCta = clampCtaDuration({ startSeconds: 50, endSeconds: 200 });
  check("recurso sin ctaPosition: clampCtaDuration no lo toca aunque sea muy largo", !noCta.adjusted && noCta.resource.endSeconds === 200);
}

// 4d. Corrección menor A del auditor (cierre de validación screen-share,
// 30-oct-2026): duración mínima de 3s para los CTA, incluyendo
// planMiddleCta. Se extiende hacia ADELANTE (nunca se adelanta el
// inicio del llamado) salvo que no haya espacio porque el CTA cae
// pegado al final del video -- ahí se extiende hacia atrás sin pasar de 0.
{
  const tooShort = clampCtaDuration({ startSeconds: 10, endSeconds: 11, ctaPosition: "end" }, 200);
  check("CTA de 1s (bajo el mínimo): se extiende a 3s", tooShort.adjusted && tooShort.resource.endSeconds - tooShort.resource.startSeconds === 3);
  check("CTA de 1s extendido: se extiende hacia adelante, el inicio NO se mueve", tooShort.resource.startSeconds === 10);

  const nearEnd = clampCtaDuration({ startSeconds: 199, endSeconds: 199.5, ctaPosition: "end" }, 200);
  check("CTA pegado al final del video (sin espacio hacia adelante): se extiende hacia atrás", nearEnd.adjusted && nearEnd.resource.endSeconds === 200);
  check("CTA pegado al final: queda con exactamente 3s, sin pasarse de la duración del video", nearEnd.resource.endSeconds - nearEnd.resource.startSeconds === 3 && nearEnd.resource.startSeconds === 197);

  const exactlyMin = clampCtaDuration({ startSeconds: 10, endSeconds: 13, ctaPosition: "start" }, 200);
  check("CTA de exactamente 3s: no se toca", !exactlyMin.adjusted);

  const middleTooShort = clampCtaDuration({ startSeconds: 10, endSeconds: 11.5, ctaPosition: "middle" }, 200);
  check("CTA de mitad de 1.5s (bajo el mínimo): se extiende a 3s igual que start/end", middleTooShort.adjusted && middleTooShort.resource.endSeconds - middleTooShort.resource.startSeconds === 3);

  // Sin durationInSeconds conocido (nunca debería pasar en producción,
  // pero no debe romper): extiende hacia adelante sin chequear el límite.
  const noDuration = clampCtaDuration({ startSeconds: 10, endSeconds: 11, ctaPosition: "end" });
  check("CTA corto sin durationInSeconds: igual se extiende hacia adelante", noDuration.adjusted && noDuration.resource.endSeconds === 13);
}

// 4e. Duración mínima integrada en parseEditorialResponse y en
// planMiddleCta (vía planEdit) -- no solo en clampCtaDuration aislado.
{
  const shortCta = JSON.stringify({
    cuts: [],
    zooms: [],
    resources: [
      {
        startSeconds: 5, endSeconds: 6,
        type: "graphic", description: "recordatorio brevísimo",
        editorialGoal: "emphasis", segment: "intro",
        ctaPosition: "start",
      },
    ],
    notes: "",
  });
  const plan = parseEditorialResponse(shortCta, 200);
  const startCta = plan.resources.find((r) => r.ctaPosition === "start");
  check("CTA de inicio de 1s vía parseEditorialResponse: se extiende a 3s", startCta && startCta.endSeconds - startCta.startSeconds === 3);
  check("CTA de inicio extendido: queda registrado en ctaDurationAdjustments con 'extendido'", plan.ctaDurationAdjustments.some((a) => a.includes("extendido")));
}

// 5. Respuesta que no es JSON en absoluto: debe fallar con un error claro, no silenciosamente.
{
  let threw = false;
  try {
    parseEditorialResponse("Claro, aquí está mi análisis: no hay nada que cortar.", 8);
  } catch (err) {
    threw = true;
    check("error no-JSON menciona la causa", err.message.includes("JSON válido"));
  }
  check("respuesta no-JSON lanza error (no fallo silencioso)", threw);
}

// 6. Sin API key configurada y sin cliente inyectado: falla con mensaje claro, nunca con un error críptico del SDK.
{
  __setAnthropicClientForTesting(null);
  const previousKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  let threw = false;
  try {
    await planEdit({
      captions: fakeCaptions,
      guidelines: "guía de prueba",
      durationInSeconds: 8,
      destination: "youtube-16-9",
    });
  } catch (err) {
    threw = true;
    check("sin API key: mensaje menciona Portainer", err.message.includes("Portainer"));
  }
  check("sin API key: lanza error claro", threw);
  if (previousKey) process.env.ANTHROPIC_API_KEY = previousKey;
}

console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
process.exit(failures === 0 ? 0 : 1);
