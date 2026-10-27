// IA editorial (Etapa 2): a partir de la transcripción ya agrupada en
// líneas (server/captions.mjs) y la guía editorial del canal, le pide a
// Claude un plan de edición estructurado (cortes + zooms) y lo valida
// antes de dejarlo tocar el trabajo. Nunca inventa lo que no puede
// construir todavía (B-roll/gráficos externos) — eso es de una etapa
// posterior y las guías de cada canal ya se lo dicen al modelo.
import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";

const DEFAULT_MODEL = process.env.EDITORIAL_MODEL ?? "claude-sonnet-5";
const MAX_OUTPUT_TOKENS = 4096;

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

const transcriptAsText = (captions) =>
  captions
    .map(
      (c) =>
        `[${(c.startMs / 1000).toFixed(2)}-${(c.endMs / 1000).toFixed(2)}] ${c.text}`,
    )
    .join("\n");

const buildPrompt = ({ guidelines, captions, durationInSeconds, destination }) => `Eres un editor de video profesional. Analiza esta transcripción real (con tiempos en segundos) y decide cortes y zooms con criterio editorial genuino — no los apliques mecánicamente, piensa como lo haría un editor humano cuidadoso.

Duración total del video original: ${durationInSeconds.toFixed(2)} segundos.
Formato de salida: ${destination}.

## Guía editorial de este canal

${guidelines}

## Transcripción (una línea por entrada, con su rango de tiempo)

${transcriptAsText(captions)}

## Formato de respuesta

Responde ÚNICAMENTE con un objeto JSON válido, sin texto antes ni después, sin bloque de código markdown. Forma exacta:

{
  "cuts": [
    { "startSeconds": number, "endSeconds": number, "reason": "string breve" }
  ],
  "zooms": [
    { "startSeconds": number, "endSeconds": number, "fromScale": number, "toScale": number, "origin": { "x": number, "y": number }, "reason": "string breve" }
  ],
  "notes": "resumen breve de tu criterio editorial para que un humano lo revise"
}

Si no hay nada que cortar o ningún momento que merezca zoom, devuelve arrays vacíos — no inventes ediciones solo por rellenar.`;

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

/**
 * Le pide a Claude un plan de edición para este trabajo. No toca el job
 * directamente — quien llama decide si aplica `cuts`/`zooms` al job.
 */
export const planEdit = async ({
  captions,
  guidelines,
  durationInSeconds,
  destination,
  model = DEFAULT_MODEL,
  onLog = () => {},
}) => {
  const prompt = buildPrompt({ guidelines, captions, durationInSeconds, destination });

  onLog(`pidiendo plan de edición a ${model}...`);
  const startedAt = Date.now();
  const anthropic = getClient();
  const response = await anthropic.messages.create({
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    messages: [{ role: "user", content: prompt }],
  });
  const elapsedMs = Date.now() - startedAt;

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

  const plan = parseEditorialResponse(text, durationInSeconds);

  return {
    ...plan,
    metrics: {
      elapsedMs,
      model,
      inputTokens: response.usage?.input_tokens ?? null,
      outputTokens: response.usage?.output_tokens ?? null,
    },
  };
};
