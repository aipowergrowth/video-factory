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
  snapCutsToWordBoundaries,
  buildSnapCutsDiagnostic,
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
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

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
  // 4 llamadas: intento + reintento del plan principal, más la llamada
  // aparte (siempre ocurre) del CTA obligatorio de mitad de video, más
  // la del CTA de inicio (ocurre porque el plan principal -- vacío en
  // este test -- no incluyó ningún recurso "start").
  check("respuesta vacía por max_tokens: reintenta exactamente una vez (4 llamadas: intento + reintento + CTA de mitad + CTA de inicio)", calls.length === 4);
  check("respuesta vacía por max_tokens: el reintento pide más max_tokens que el primer intento", calls[1].maxTokens > calls[0].maxTokens);
  // Bug real: el razonamiento interno competía por el mismo presupuesto
  // que max_tokens y a veces se lo comía entero (respuesta vacía en
  // producción). Confirmado con la API real que desactivarlo arregla
  // esto sin perder calidad editorial -- este chequeo evita que alguien
  // lo reactive sin querer en el futuro.
  check("las 4 llamadas piden el razonamiento desactivado", calls.every((c) => c.thinking?.type === "disabled"));
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
          // Plan principal: sin recurso "start" -> dispara también la
          // llamada aparte de CTA de inicio (callIndex 3), que en este
          // test no es lo que se está verificando -- responde vacío.
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
        if (callIndex === 3) {
          return {
            content: [{ type: "text", text: JSON.stringify({ cuts: [], zooms: [], resources: [], notes: "" }) }],
            stop_reason: "end_turn",
            usage: { input_tokens: 5, output_tokens: 2 },
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
  check("CTA de mitad: sus tokens se suman al total del plan (incluye también la llamada aparte de inicio)", plan.metrics.inputTokens === 125 && plan.metrics.outputTokens === 62);
  check("CTA de mitad: queda registrado aparte en metrics.middleCta", plan.metrics.middleCta?.inputTokens === 20);
}

// Corrección del dictamen de cierre de talking-head (30-oct-2026,
// precisión A): el CTA de inicio reutiliza el mecanismo de planMiddleCta
// (ventana sobre la línea editada + llamada aparte), pero es
// CONDICIONAL -- solo se dispara si la llamada principal NO ya puso un
// recurso "start" (es decir, no hubo invitación verbal real).
{
  // Caso 1: la llamada principal SÍ tiene un "start" sincronizado con
  // invitación verbal -- la llamada aparte de inicio NO debe dispararse.
  let callCount = 0;
  __setAnthropicClientForTesting({
    messages: {
      create: async () => {
        callCount += 1;
        if (callCount === 1) {
          return {
            content: [{ type: "text", text: JSON.stringify({
              cuts: [],
              zooms: [],
              resources: [{
                startSeconds: 2, endSeconds: 6,
                type: "text-highlight", description: "síganme en Instagram",
                editorialGoal: "emphasis", segment: "intro",
                ctaPosition: "start",
              }],
              notes: "",
            }) }],
            stop_reason: "end_turn",
            usage: { input_tokens: 50, output_tokens: 20 },
          };
        }
        // callCount===2 debería ser SOLO la de mitad -- si hay una
        // tercera llamada, es la de inicio que no debería haber ocurrido.
        return { content: [{ type: "text", text: JSON.stringify({ cuts: [], zooms: [], resources: [], notes: "" }) }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 2 } };
      },
    },
  });
  await planEdit({ captions: fakeCaptions, guidelines: "guía", durationInSeconds: 10, destination: "youtube-16-9" });
  check("CTA de inicio con invitación verbal real: NO dispara la llamada aparte (solo 2 llamadas: principal + mitad)", callCount === 2);
}

{
  // Caso 2: sin invitación verbal -- se dispara la llamada aparte, con
  // una VENTANA (no un punto único) calculada sobre la línea editada.
  // Mismo video de prueba que el caso del "7.00s" (10s con un corte
  // 0-4s -> línea editada de 6s, menor al tope de ventana de 45s, así
  // que la ventana es el video editado completo): source 4-10 mapea a
  // output 0-6 -> la ventana de inicio cae en output 0-6.00 -> de vuelta
  // al original, source 4.00-10.00.
  let callCount = 0;
  let startCtaPrompt = "";
  __setAnthropicClientForTesting({
    messages: {
      create: async (params) => {
        callCount += 1;
        if (callCount === 1) {
          return {
            content: [{ type: "text", text: JSON.stringify({
              cuts: [{ startSeconds: 0, endSeconds: 4, reason: "silencio inicial" }],
              zooms: [], resources: [], notes: "",
            }) }],
            stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 50 },
          };
        }
        if (callCount === 2) {
          // CTA de mitad: responde vacío, no es lo que se está probando.
          return { content: [{ type: "text", text: JSON.stringify({ cuts: [], zooms: [], resources: [], notes: "" }) }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 2 } };
        }
        startCtaPrompt = params.messages[0].content;
        return {
          content: [{ type: "text", text: JSON.stringify({
            cuts: [], zooms: [],
            resources: [{
              startSeconds: 5, endSeconds: 7,
              type: "graphic", description: "recordatorio de suscripción",
              editorialGoal: "emphasis", segment: "intro",
              intensity: "subtle", veracityRequirement: "illustrative-ok", essential: false,
            }],
            notes: "",
          }) }],
          stop_reason: "end_turn", usage: { input_tokens: 30, output_tokens: 15 },
        };
      },
    },
  });
  const plan = await planEdit({ captions: fakeCaptions, guidelines: "guía", durationInSeconds: 10, destination: "youtube-16-9" });
  check("CTA de inicio sin invitación verbal: SÍ dispara la llamada aparte (3 llamadas)", callCount === 3);
  check("CTA de inicio sin invitación verbal: la ventana pasada al modelo usa tiempo ORIGINAL (4.00s-10.00s), no el editado", startCtaPrompt.includes("4.00s") && startCtaPrompt.includes("10.00s"));
  const startCta = plan.resources.find((r) => r.ctaPosition === "start");
  check("CTA de inicio sin invitación verbal: el recurso se suma al plan, tageado 'start'", startCta !== undefined && startCta.description === "recordatorio de suscripción");
}

{
  // Si tampoco la llamada aparte propone nada, queda como ctaIssue
  // visible -- igual que el de mitad, nunca se omite en silencio.
  let callIndex = 0;
  __setAnthropicClientForTesting({
    messages: {
      create: async () => {
        callIndex += 1;
        return { content: [{ type: "text", text: JSON.stringify({ cuts: [], zooms: [], resources: [], notes: "" }) }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 2 } };
      },
    },
  });
  const plan = await planEdit({ captions: fakeCaptions, guidelines: "guía", durationInSeconds: 10, destination: "youtube-16-9" });
  check("sin CTA de inicio en ningún lado: queda como ctaIssue visible", plan.ctaIssues.some((i) => i.includes('"start"')));
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

// --- snapCutsToWordBoundaries: defecto real del render de dopamina
// (job ff69b475/a416b0e) -- un corte terminaba a mitad de "Cameron" (la
// repetición corregida que sí sobrevive) y se comía sus primeras
// sílabas. El sonido final era "...ron Sepah" en vez de "...Cameron
// Sepah". ---

const w = (text, startSec, endSec) => ({ text, startMs: startSec * 1000, endMs: endSec * 1000, timestampMs: null, confidence: null });

{
  // Reproduce la forma exacta del defecto real: el FINAL del corte cae
  // dentro de la palabra "cameron2" (la que sí sobrevive).
  const words = [
    w("doctor", 28.0, 28.5),
    w("cameron1", 28.6, 29.2), // falso comienzo, se va a eliminar
    w("sepa", 29.3, 29.6),
    w("de", 29.65, 29.8),
    w("la", 29.85, 30.1),
    w("cameron2", 30.2, 30.8), // la que sobrevive -- NO se puede clipear
    w("sepah", 30.9, 31.4),
  ];
  const cuts = [{ id: "c1", startSeconds: 29.25, endSeconds: 30.3 }]; // 30.3 cae DENTRO de cameron2
  const result = snapCutsToWordBoundaries(cuts, words);
  check("final que cae dentro de una palabra: se adelanta a antes de que empiece esa palabra", result.cuts.length === 1 && approx(result.cuts[0].endSeconds, 30.1));
  check("final ajustado: respeta el margen de 0.1s antes de la palabra protegida (30.2 - 0.1)", approx(result.cuts[0].endSeconds, 30.2 - 0.1));
  check("inicio del corte: sin cambios, no había ninguna palabra solapada ahí", result.cuts[0].startSeconds === 29.25);
  check("sin cutIssues: el corte se pudo ajustar sin descartarlo", result.cutIssues.length === 0);
}

{
  // El INICIO del corte cae dentro de una palabra -- se empuja hacia
  // adelante, nunca se agranda el corte hacia atrás.
  const words = [w("palabra1", 5.0, 5.4), w("repetida", 5.5, 6.0), w("palabra3", 6.3, 6.7)];
  const cuts = [{ id: "c2", startSeconds: 5.35, endSeconds: 6.0 }]; // 5.35 cae DENTRO de "palabra1"
  const result = snapCutsToWordBoundaries(cuts, words);
  check("inicio que cae dentro de una palabra: se empuja a después de que termine esa palabra", result.cuts.length === 1 && approx(result.cuts[0].startSeconds, 5.4 + 0.1));
  check("final del corte: sin cambios", result.cuts[0].endSeconds === 6.0);
}

// --- Defecto real encontrado por el operador en el endpoint snap-cuts
// (ae40a93): con palabras PEGADAS (sin hueco real entre ellas), el
// margen de 0.1s empujaba el borde DENTRO de la palabra siguiente --
// exactamente el defecto que esta función existe para evitar, ahora
// producido por su propio margen. Casos reales del job 578818c7. ---

{
  // ai-cut-0: 29.5-30.71 (reportado). La palabra previa a "cameron2"
  // termina justo donde "cameron2" empieza (29.68, sin hueco) -- el
  // viejo código daba 29.68+0.1=29.78, DENTRO de cameron2 (29.68-30.24).
  // El final del corte (31.0) cae en un hueco amplio, lejos de toda
  // palabra, para aislar la prueba al borde de INICIO únicamente.
  const words = [
    w("previa", 29.3, 29.68),
    w("cameron2", 29.68, 30.24),
    w("sepah", 30.3, 30.7),
  ];
  const cuts = [{ id: "ai-cut-0", startSeconds: 29.5, endSeconds: 31.0 }];
  const result = snapCutsToWordBoundaries(cuts, words);
  check(
    "palabras pegadas (sin hueco): el margen efectivo es 0, el borde queda EXACTO en el límite (29.68), nunca dentro de 'cameron2'",
    result.cuts.length === 1 && approx(result.cuts[0].startSeconds, 29.68),
  );
  check("palabras pegadas: el borde ajustado NO cae dentro de cameron2 (29.68-30.24)", result.cuts[0].startSeconds <= 29.68);
}

{
  // ai-cut-1: 109.26-109.86 (reportado). Misma forma con "pues"
  // (109.40-109.84) pegada a la palabra anterior -- el viejo código
  // daba 109.40+0.1=109.5, DENTRO de "pues". Final lejos de toda
  // palabra, para aislar la prueba al borde de inicio.
  const words = [
    w("previa", 109.0, 109.4),
    w("pues", 109.4, 109.84),
    w("siguiente", 109.9, 110.3),
  ];
  const cuts = [{ id: "ai-cut-1", startSeconds: 109.26, endSeconds: 112.0 }];
  const result = snapCutsToWordBoundaries(cuts, words);
  check(
    "caso real de 'pues': el borde queda EXACTO en 109.40, nunca dentro de 'pues' (109.40-109.84)",
    result.cuts.length === 1 && approx(result.cuts[0].startSeconds, 109.4),
  );
}

{
  // El mismo defecto, pero en el borde FINAL de un corte (margen hacia
  // atrás contra la palabra anterior pegada).
  const words = [w("antes", 10.0, 10.5), w("pegada", 10.5, 11.0), w("despues", 11.3, 11.7)];
  // El final original (10.55) cae dentro de "pegada" (10.5-11.0). El
  // inicio (8.0) está lejos de toda palabra, para aislar la prueba al
  // borde final únicamente.
  const cuts = [{ id: "c-end", startSeconds: 8.0, endSeconds: 10.55 }];
  const result = snapCutsToWordBoundaries(cuts, words);
  check(
    "final contra palabras pegadas: queda EXACTO en 10.5 (inicio de 'pegada'), margen efectivo 0",
    result.cuts.length === 1 && approx(result.cuts[0].endSeconds, 10.5),
  );
}

{
  // Cuando SÍ hay hueco real (mayor al margen), el margen completo se
  // sigue aplicando como antes -- esto no debe regresionar.
  const words = [w("a", 1.0, 1.4), w("b", 2.0, 2.4)]; // hueco de 0.6s entre ellas
  // 1.3 cae dentro de "a"; el final (3.0) queda lejos de toda palabra.
  const cuts = [{ id: "c-gap", startSeconds: 1.3, endSeconds: 3.0 }];
  const result = snapCutsToWordBoundaries(cuts, words);
  check("con hueco real amplio: el margen completo de 0.1s se aplica igual que siempre", approx(result.cuts[0].startSeconds, 1.5));
}

{
  // edgeBounds: expone el rango seguro por borde para que el
  // refinamiento acústico sepa hasta dónde puede buscar sin arriesgar
  // nunca una palabra.
  const words = [w("previa", 29.3, 29.68), w("cameron2", 29.68, 30.24)];
  const cuts = [{ id: "ai-cut-0", startSeconds: 29.5, endSeconds: 31.0 }];
  const result = snapCutsToWordBoundaries(cuts, words);
  check("edgeBounds: el piso del inicio nunca es menor al límite seguro (29.68)", result.edgeBounds["ai-cut-0"].start.min === 29.68);
}

{
  // Corte ya limpio (ningún borde toca una palabra): queda intacto.
  const words = [w("a", 1.0, 1.5), w("b", 1.9, 2.3)];
  const cuts = [{ id: "c3", startSeconds: 1.5, endSeconds: 1.8 }];
  const result = snapCutsToWordBoundaries(cuts, words);
  check("corte limpio: no se toca", result.cuts.length === 1 && result.cuts[0].startSeconds === 1.5 && result.cuts[0].endSeconds === 1.8);
  check("corte limpio: sin cutIssues", result.cutIssues.length === 0);
}

{
  // Ambos bordes solapados y el margen de seguridad se come todo el
  // corte -- no hay forma de cumplir la regla sin arriesgar una
  // palabra, se descarta entero y queda registrado.
  const words = [w("straddleStart", 1.40, 1.55), w("straddleEnd", 1.58, 1.9)];
  const cuts = [{ id: "c4", startSeconds: 1.5, endSeconds: 1.65, reason: "corte de prueba" }];
  const result = snapCutsToWordBoundaries(cuts, words);
  check("corte imposible de ajustar: se descarta entero", result.cuts.length === 0);
  check("corte descartado: queda registrado en cutIssues, nunca se deja un borde inseguro", result.cutIssues.length === 1 && result.cutIssues[0].includes("c4"));
}

{
  // Sin transcriptWords: no hay forma de verificar, se devuelve igual
  // (mismo criterio conservador que mergeNearbyGaplessCuts).
  const cuts = [{ id: "c5", startSeconds: 10, endSeconds: 11 }];
  const result = snapCutsToWordBoundaries(cuts, undefined);
  check("sin transcriptWords: los cortes no se tocan", result.cuts.length === 1 && result.cuts[0].startSeconds === 10 && result.cuts[0].endSeconds === 11);
  check("sin transcriptWords: sin cutIssues", result.cutIssues.length === 0);
}

{
  // Varios cortes: solo el que de verdad tiene un borde comprometido se
  // ajusta, los demás quedan igual.
  const words = [w("x", 50.0, 50.4), w("y", 50.42, 50.9)];
  const cuts = [
    { id: "ok1", startSeconds: 0, endSeconds: 1 }, // lejos de cualquier palabra
    { id: "bad", startSeconds: 50.1, endSeconds: 50.5 }, // ambos bordes solapan x/y
  ];
  const result = snapCutsToWordBoundaries(cuts, words);
  check("varios cortes: el que no toca ninguna palabra queda igual", result.cuts.some((c) => c.id === "ok1" && c.startSeconds === 0 && c.endSeconds === 1));
}

// --- buildSnapCutsDiagnostic: para POST /jobs/:id/snap-cuts (diagnóstico
// de solo lectura, sin llamar al modelo, sin tocar el job) ---

{
  // Caso real: el final del corte cae dentro de "cameron2" -- el
  // diagnóstico tiene que mostrar exactamente esa palabra en la ventana
  // de +-2s del borde final, y reflejar el ajuste.
  const words = [
    w("doctor", 28.0, 28.5),
    w("cameron1", 28.6, 29.2),
    w("sepa", 29.3, 29.6),
    w("de", 29.65, 29.8),
    w("la", 29.85, 30.1),
    w("cameron2", 30.2, 30.8),
    w("sepah", 30.9, 31.4),
  ];
  const cuts = [{ id: "ai-cut-0", startSeconds: 29.25, endSeconds: 30.71 }];
  const result = buildSnapCutsDiagnostic(cuts, words);
  check("diagnóstico: ajustedCuts tiene el corte recortado (endSeconds antes de cameron2)", result.adjustedCuts.length === 1 && approx(result.adjustedCuts[0].endSeconds, 30.1));
  check("diagnóstico: sin cutIssues (el corte se pudo ajustar, no se descartó)", result.cutIssues.length === 0);

  const endEdge = result.wordsNearEdges.find((e) => e.cutId === "ai-cut-0" && e.edge === "end");
  check("diagnóstico: el borde final conserva el valor ORIGINAL pedido (30.71), no el ajustado", endEdge.originalSeconds === 30.71);
  check("diagnóstico: el borde final muestra el valor ajustado (antes de cameron2)", approx(endEdge.adjustedSeconds, 30.1));
  check("diagnóstico: no está marcado como descartado", endEdge.discarded === false);
  check("diagnóstico: la ventana de +-2s alrededor de 30.71 incluye 'cameron2' con sus tiempos exactos", endEdge.wordsNearby.some((w) => w.text === "cameron2" && w.startSeconds === 30.2 && w.endSeconds === 30.8));
  check("diagnóstico: la ventana también incluye 'sepah' (la palabra siguiente)", endEdge.wordsNearby.some((w) => w.text === "sepah"));

  const startEdge = result.wordsNearEdges.find((e) => e.cutId === "ai-cut-0" && e.edge === "start");
  check("diagnóstico: el borde de inicio no se tocó (29.25, sin palabra solapada ahí)", startEdge.originalSeconds === 29.25 && startEdge.adjustedSeconds === 29.25);
}

{
  // Corte que termina siendo descartado -- el diagnóstico lo marca
  // explícitamente, con adjustedSeconds en null (no inventa un valor).
  const words = [w("straddleStart", 1.40, 1.55), w("straddleEnd", 1.58, 1.9)];
  const cuts = [{ id: "c4", startSeconds: 1.5, endSeconds: 1.65 }];
  const result = buildSnapCutsDiagnostic(cuts, words);
  check("diagnóstico: corte descartado -> adjustedCuts vacío", result.adjustedCuts.length === 0);
  check("diagnóstico: corte descartado -> cutIssues con el motivo", result.cutIssues.length === 1);
  const edges = result.wordsNearEdges.filter((e) => e.cutId === "c4");
  check("diagnóstico: ambos bordes marcados discarded=true, adjustedSeconds=null", edges.every((e) => e.discarded === true && e.adjustedSeconds === null));
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

// 4b. Corrección del dictamen de cierre de talking-head (30-oct-2026):
// duración mínima de 2s para zooms -- se extiende hacia adelante dentro
// de los límites del video; si no hay espacio, se descarta y queda
// registrado, nunca en silencio (misma lógica que el mínimo de CTA).
{
  const shortZoom = JSON.stringify({
    cuts: [],
    zooms: [{ startSeconds: 10, endSeconds: 10.5, fromScale: 1, toScale: 1.2, reason: "énfasis breve" }],
    notes: "",
  });
  const plan = parseEditorialResponse(shortZoom, 200);
  check("zoom de 0.5s (bajo el mínimo): se extiende a 2s", plan.zooms.length === 1 && plan.zooms[0].endSeconds - plan.zooms[0].startSeconds === 2);
  check("zoom extendido: conserva su startSeconds (10), se extiende hacia adelante", plan.zooms[0].startSeconds === 10);
  check("zoom extendido: queda registrado en zoomIssues", plan.zoomIssues.some((i) => i.includes("extendido")));
}

{
  // Zoom pegado al final del video, sin espacio para extender hacia
  // adelante ni usando el resto del video -- se descarta, registrado.
  const impossible = JSON.stringify({
    cuts: [],
    zooms: [{ startSeconds: 199, endSeconds: 199.5, fromScale: 1, toScale: 1.2, reason: "énfasis al cierre" }],
    notes: "",
  });
  const plan = parseEditorialResponse(impossible, 200);
  check("zoom sin espacio para extender (pegado al final): se descarta", plan.zooms.length === 0);
  check("zoom descartado por mínimo: queda registrado en zoomIssues, nunca en silencio", plan.zoomIssues.some((i) => i.includes("descartado")));
}

{
  // Zoom ya dentro del mínimo: no se toca.
  const fine = JSON.stringify({
    cuts: [],
    zooms: [{ startSeconds: 10, endSeconds: 13, fromScale: 1, toScale: 1.2, reason: "énfasis" }],
    notes: "",
  });
  const plan = parseEditorialResponse(fine, 200);
  check("zoom de 3s (ya sobre el mínimo): no se toca", plan.zooms.length === 1 && plan.zooms[0].endSeconds === 13 && plan.zoomIssues.length === 0);
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

// 4f. Defecto real corregido: el motor mostraba `description` (prosa
// para el editor) en pantalla en vez de `displayText` (el texto real).
// parseEditorialResponse debe tomar `displayText` del modelo tal cual,
// sin tocarlo, y nunca completarlo con `description` si falta.
{
  const withDisplayText = JSON.stringify({
    cuts: [], zooms: [],
    resources: [
      {
        startSeconds: 10, endSeconds: 15,
        type: "text-highlight",
        description: "Texto resaltado: 'cifra exacta que dijo el presentador'",
        displayText: "cifra exacta que dijo el presentador",
        editorialGoal: "comprehension", segment: "development",
      },
      {
        startSeconds: 20, endSeconds: 25,
        type: "graphic",
        description: "Botón de CTA de cierre",
        editorialGoal: "emphasis", segment: "closing",
        ctaPosition: "end",
        displayText: "Dale like y suscríbete",
      },
    ],
    notes: "",
  });
  const plan = parseEditorialResponse(withDisplayText, 200);
  const th = plan.resources.find((r) => r.type === "text-highlight");
  const cta = plan.resources.find((r) => r.ctaPosition === "end");
  check("text-highlight: displayText se parsea tal cual", th && th.displayText === "cifra exacta que dijo el presentador");
  check("text-highlight: description se conserva aparte, nunca se mezcla con displayText", th && th.description === "Texto resaltado: 'cifra exacta que dijo el presentador'");
  check("CTA con displayText propio: se conserva", cta && cta.displayText === "Dale like y suscríbete");
}

{
  // Sin displayText en absoluto: queda undefined, nunca se completa con description.
  const withoutDisplayText = JSON.stringify({
    cuts: [], zooms: [],
    resources: [
      {
        startSeconds: 10, endSeconds: 15,
        type: "text-highlight",
        description: "Texto resaltado: 'algo'",
        editorialGoal: "comprehension", segment: "development",
      },
    ],
    notes: "",
  });
  const plan = parseEditorialResponse(withoutDisplayText, 200);
  check("sin displayText: queda undefined (nunca se usa description como reemplazo)", plan.resources[0].displayText === undefined);
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
