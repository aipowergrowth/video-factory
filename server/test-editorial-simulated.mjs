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
  __setAnthropicClientForTesting,
} from "./editorial.mjs";

const fakeCaptions = [
  { text: "Hola, bienvenidos al canal.", startMs: 0, endMs: 2000, timestampMs: null, confidence: null },
  { text: "Eh, este, hoy vamos a hablar de...", startMs: 2000, endMs: 5000, timestampMs: null, confidence: null },
  { text: "hoy vamos a hablar de un tema importante.", startMs: 5000, endMs: 8000, timestampMs: null, confidence: null },
];

const makeFakeClient = (responseText) => ({
  messages: {
    create: async () => ({
      content: [{ type: "text", text: responseText }],
      usage: { input_tokens: 123, output_tokens: 45 },
    }),
  },
});

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
  __setAnthropicClientForTesting({
    messages: {
      create: async (params) => {
        capturedPrompt = params.messages[0].content;
        return {
          content: [{ type: "text", text: JSON.stringify({ cuts: [], zooms: [], notes: "" }) }],
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
  __setAnthropicClientForTesting({
    messages: {
      create: async (params) => {
        capturedPrompt = params.messages[0].content;
        return {
          content: [{ type: "text", text: JSON.stringify({ cuts: [], zooms: [], notes: "" }) }],
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
