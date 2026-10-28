// IA editorial (Etapa 2): a partir de la transcripción ya agrupada en
// líneas (server/captions.mjs) y la guía editorial del canal, le pide a
// Claude un plan de edición estructurado (cortes + zooms) y lo valida
// antes de dejarlo tocar el trabajo. Nunca inventa lo que no puede
// construir todavía (B-roll/gráficos externos) — eso es de una etapa
// posterior y las guías de cada canal ya se lo dicen al modelo.
import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";

const DEFAULT_MODEL = process.env.EDITORIAL_MODEL ?? "claude-sonnet-5";
// Bug real en producción: con la transcripción palabra por palabra de un
// video de 12 min (mucho más texto que la versión agrupada en líneas),
// el modelo devolvió una respuesta vacía -- consistente con haber
// agotado max_tokens (4096 era demasiado poco para un plan editorial
// con muchos cortes, cada uno con su razón). Subido bastante y con un
// reintento con más margen todavía si hace falta (ver planEdit).
const FIRST_MAX_TOKENS = Number(process.env.EDITORIAL_MAX_TOKENS ?? 16000);
const RETRY_MAX_TOKENS = Number(process.env.EDITORIAL_RETRY_MAX_TOKENS ?? 32000);

let client = null;

/**
 * Igual que la credencial de Drive: en producción la clave vive en un
 * secreto de Docker Swarm (archivo montado en /run/secrets/...), nunca en
 * una variable de entorno en texto plano. `ANTHROPIC_API_KEY` a secas
 * solo se usa para pruebas locales fuera de Docker.
 */
const readApiKey = () => {
  const keyFile = process.env.ANTHROPIC_API_KEY_FILE;
  if (keyFile) {
    return fs.readFileSync(keyFile, "utf8").trim();
  }
  return process.env.ANTHROPIC_API_KEY;
};

const getClient = () => {
  if (client) return client;
  const apiKey = readApiKey();
  if (!apiKey) {
    throw new Error(
      "Falta la clave de API de Claude (configúrala como secreto ANTHROPIC_API_KEY_FILE en Portainer, nunca en el repo ni en el chat).",
    );
  }
  client = new Anthropic({ apiKey });
  return client;
};

/** Solo para pruebas: inyecta un cliente falso en vez del real de Anthropic. */
export const __setAnthropicClientForTesting = (fakeClient) => {
  client = fakeClient;
};

const transcriptAsText = (entries) =>
  entries
    .map(
      (c) =>
        `[${(c.startMs / 1000).toFixed(2)}-${(c.endMs / 1000).toFixed(2)}] ${c.text}`,
    )
    .join("\n");

/**
 * Con `transcriptWords` (tiempos por PALABRA, de whisper) los cortes
 * pueden caer entre dos palabras cualesquiera -- precisión real. Sin eso
 * (un job con captions manuales, sin pasar por la transcripción
 * automática) solo hay límites entre líneas agrupadas, mucho más
 * gruesos: un titubeo o repetición a mitad de una línea ya no se puede
 * cortar. Se le dice al modelo la verdad sobre qué puede hacer en cada
 * caso -- nunca ofrecerle una precisión que no tiene.
 */
const buildPrompt = ({ guidelines, transcript, granularity, durationInSeconds, destination }) => {
  const cutPrecisionInstruction =
    granularity === "word"
      ? "Los cortes deben caer EXACTAMENTE en el límite entre dos palabras consecutivas de la transcripción (el final de una palabra o el inicio de la siguiente) -- nunca a la mitad de una palabra. Como la transcripción es palabra por palabra, puedes cortar un titubeo o una repetición puntual aunque esté en medio de una frase."
      : "Los cortes deben caer EXACTAMENTE en los límites entre líneas de la transcripción (el final de una línea o el inicio de la siguiente) -- nunca a la mitad de una línea. Esta transcripción solo viene agrupada en líneas (no palabra por palabra), así que un titubeo o repetición a mitad de una línea no se puede aislar: en ese caso no lo cortes.";

  return `Eres un editor de video profesional. Analiza esta transcripción real (con tiempos en segundos) y decide cortes y zooms con criterio editorial genuino — no los apliques mecánicamente, piensa como lo haría un editor humano cuidadoso.

Duración total del video original: ${durationInSeconds.toFixed(2)} segundos.
Formato de salida: ${destination}.

## Guía editorial de este canal

${guidelines}

## Precisión de los cortes

${cutPrecisionInstruction}

## Transcripción (${granularity === "word" ? "una palabra" : "una línea"} por entrada, con su rango de tiempo)

${transcriptAsText(transcript)}

## Formato de respuesta

Responde ÚNICAMENTE con un objeto JSON válido, sin texto antes ni después, sin bloque de código markdown. Forma exacta:

{
  "cuts": [
    { "startSeconds": number, "endSeconds": number, "reason": "máximo 12 palabras" }
  ],
  "zooms": [
    { "startSeconds": number, "endSeconds": number, "fromScale": number, "toScale": number, "origin": { "x": number, "y": number }, "reason": "máximo 12 palabras" }
  ],
  "notes": "resumen breve de tu criterio editorial para que un humano lo revise"
}

Si no hay nada que cortar o ningún momento que merezca zoom, devuelve arrays vacíos — no inventes ediciones solo por rellenar.`;
};

const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);

const stripCodeFence = (text) => {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1] : trimmed;
};

/**
 * Valida y normaliza la respuesta del modelo. Tira cualquier corte/zoom
 * con forma inválida en vez de dejar pasar algo que rompa el render —
 * pero NO descarta el resto del plan por un elemento malo.
 */
export const parseEditorialResponse = (rawText, durationInSeconds) => {
  let parsed;
  try {
    parsed = JSON.parse(stripCodeFence(rawText));
  } catch (err) {
    throw new Error(
      `La IA editorial no devolvió JSON válido: ${err.message}. Respuesta cruda: ${rawText.slice(0, 500)}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("La IA editorial no devolvió un objeto JSON.");
  }

  const cuts = (Array.isArray(parsed.cuts) ? parsed.cuts : [])
    .filter(
      (cut) =>
        cut &&
        isFiniteNumber(cut.startSeconds) &&
        isFiniteNumber(cut.endSeconds) &&
        cut.endSeconds > cut.startSeconds &&
        cut.startSeconds >= 0 &&
        cut.endSeconds <= durationInSeconds + 0.5, // pequeño margen por redondeo
    )
    .map((cut, index) => ({
      id: `ai-cut-${index}`,
      startSeconds: cut.startSeconds,
      endSeconds: cut.endSeconds,
      reason: typeof cut.reason === "string" ? cut.reason : undefined,
    }));

  const zooms = (Array.isArray(parsed.zooms) ? parsed.zooms : [])
    .filter(
      (zoom) =>
        zoom &&
        isFiniteNumber(zoom.startSeconds) &&
        isFiniteNumber(zoom.endSeconds) &&
        zoom.endSeconds > zoom.startSeconds &&
        isFiniteNumber(zoom.fromScale) &&
        isFiniteNumber(zoom.toScale) &&
        zoom.fromScale > 0 &&
        zoom.toScale > 0,
    )
    .map((zoom, index) => ({
      id: `ai-zoom-${index}`,
      startSeconds: zoom.startSeconds,
      endSeconds: zoom.endSeconds,
      // Límite de seguridad: nunca más de 2x, por si el modelo se pasa.
      fromScale: Math.min(2, Math.max(0.5, zoom.fromScale)),
      toScale: Math.min(2, Math.max(0.5, zoom.toScale)),
      origin:
        zoom.origin &&
        isFiniteNumber(zoom.origin.x) &&
        isFiniteNumber(zoom.origin.y)
          ? {
              x: Math.min(1, Math.max(0, zoom.origin.x)),
              y: Math.min(1, Math.max(0, zoom.origin.y)),
            }
          : undefined,
      reason: typeof zoom.reason === "string" ? zoom.reason : undefined,
    }));

  return {
    cuts,
    zooms,
    notes: typeof parsed.notes === "string" ? parsed.notes : "",
  };
};

const callModel = async ({ anthropic, prompt, model, maxTokens }) => {
  const response = await anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    // Confirmado con una llamada real: el razonamiento interno compite
    // por el mismo presupuesto que `max_tokens` y su tamaño varía de una
    // llamada a otra -- en una prueba se comió 12368 de 16000 tokens
    // (quedó justo), y en el VPS se comió los 16000 enteros (texto
    // vacío). La tarea (devolver un plan JSON con reglas ya explícitas en
    // el prompt) no necesita razonamiento extendido para salir bien;
    // desactivarlo elimina esta fuente de fallos no determinista en vez
    // de solo subir el presupuesto y confiar en tener suerte.
    thinking: { type: "disabled" },
    messages: [{ role: "user", content: prompt }],
  });
  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  return {
    text,
    stopReason: response.stop_reason ?? null,
    inputTokens: response.usage?.input_tokens ?? null,
    outputTokens: response.usage?.output_tokens ?? null,
    // Cuánto de output_tokens se fue en razonamiento interno (no texto
    // visible) -- es la pieza que explicó el bug real: con el razonamiento
    // activado por defecto, podía comerse TODO el presupuesto antes de
    // escribir una sola palabra del JSON.
    thinkingTokens: response.usage?.output_tokens_details?.thinking_tokens ?? null,
  };
};

/**
 * Le pide a Claude un plan de edición para este trabajo. No toca el job
 * directamente — quien llama decide si aplica `cuts`/`zooms` al job.
 *
 * Si la respuesta viene vacía o cortada (stop_reason="max_tokens" --
 * típicamente el modelo agotó el presupuesto pensando, antes de llegar a
 * escribir el JSON), reintenta UNA vez con bastante más margen antes de
 * darse por vencido. Registra siempre stop_reason y tokens de
 * entrada/salida, incluso cuando todo sale bien -- así un fallo similar
 * se diagnostica de inmediato la próxima vez, sin adivinar.
 */
export const planEdit = async ({
  captions,
  // Opcional: tiempos por palabra (de whisper). Si viene, se usa en vez
  // de `captions` para poder cortar en cualquier palabra, no solo entre
  // líneas agrupadas -- ver buildPrompt.
  transcriptWords,
  guidelines,
  durationInSeconds,
  destination,
  model = DEFAULT_MODEL,
  onLog = () => {},
}) => {
  const useWords = Array.isArray(transcriptWords) && transcriptWords.length > 0;
  const prompt = buildPrompt({
    guidelines,
    transcript: useWords ? transcriptWords : captions,
    granularity: useWords ? "word" : "line",
    durationInSeconds,
    destination,
  });

  const anthropic = getClient();
  const startedAt = Date.now();

  onLog(`pidiendo plan de edición a ${model} (max_tokens=${FIRST_MAX_TOKENS})...`);
  let attempt = await callModel({ anthropic, prompt, model, maxTokens: FIRST_MAX_TOKENS });
  let maxTokensUsed = FIRST_MAX_TOKENS;
  let retried = false;
  onLog(
    `respuesta: stop_reason=${attempt.stopReason}, tokens=${attempt.inputTokens}in/${attempt.outputTokens}out ` +
      `(razonamiento=${attempt.thinkingTokens ?? "?"}), max_tokens=${maxTokensUsed}, ` +
      `texto=${attempt.text.trim().length} caracteres`,
  );

  const seemsTruncated = attempt.stopReason === "max_tokens" || attempt.text.trim().length === 0;
  if (seemsTruncated) {
    retried = true;
    maxTokensUsed = RETRY_MAX_TOKENS;
    onLog(
      `la respuesta parece cortada -- reintentando una vez con más margen (max_tokens=${RETRY_MAX_TOKENS})...`,
    );
    attempt = await callModel({ anthropic, prompt, model, maxTokens: RETRY_MAX_TOKENS });
    onLog(
      `respuesta del reintento: stop_reason=${attempt.stopReason}, tokens=${attempt.inputTokens}in/${attempt.outputTokens}out ` +
        `(razonamiento=${attempt.thinkingTokens ?? "?"}), max_tokens=${maxTokensUsed}, ` +
        `texto=${attempt.text.trim().length} caracteres`,
    );
  }

  const elapsedMs = Date.now() - startedAt;
  const plan = parseEditorialResponse(attempt.text, durationInSeconds);

  return {
    ...plan,
    metrics: {
      elapsedMs,
      model,
      stopReason: attempt.stopReason,
      inputTokens: attempt.inputTokens,
      outputTokens: attempt.outputTokens,
      thinkingTokens: attempt.thinkingTokens,
      maxTokens: maxTokensUsed,
      retried,
    },
  };
};
