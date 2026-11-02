import fs from "node:fs";

// Generación de imágenes con IA (02-nov-2026, autorizado por Alex tras
// la propuesta del modelo combinado): último recurso cuando Pixabay
// (Capa A+B+C de resource-acquisition.mjs) no encuentra nada
// pertinente Y el planificador marcó el recurso como
// `veracityRequirement: "illustrative-ok"` -- un recurso
// "must-be-real" NUNCA pasa por acá (ver resource-acquisition.mjs).
//
// Decisiones cerradas de Alex (no se reabren en este módulo):
// - Un solo proveedor: Gemini API, nivel de pago.
// - Estilo SIEMPRE ilustrativo/esquemático, nunca fotorrealista.
//
// Modelo y precio, confirmados contra la documentación oficial vigente
// de Google (https://ai.google.dev/gemini-api/docs/pricing,
// 02-nov-2026, no asumidos): el modelo de imagen más barato que sigue
// disponible (no deprecado) es "Gemini 3.1 Flash Lite Image" --
// id de modelo `gemini-3.1-flash-lite-image` -- a $0.0336 por imagen de
// 1K (1024x1024px). La misma página también lista un alias/codename
// "gemini-nano-banana-2.1" al mismo precio -- se eligió el nombre
// versionado (más predecible, mismo patrón que el resto de la familia
// "gemini-3.1-*") para el código; si Alex confirma en la consola de
// Google AI Studio que el alias es el que de verdad acepta la cuenta,
// es un solo valor para cambiar. NO VERIFICADO todavía contra una
// llamada real (sin clave) -- eso es la Etapa 2.
export const GEMINI_IMAGE_MODEL = "gemini-3.1-flash-lite-image";
// Tarifa plana confirmada por imagen a 1K -- NO se calcula a partir de
// `usageMetadata` (a diferencia de la Capa B/C de Anthropic, que sí
// cobra por token): Google cotiza este modelo por imagen generada, no
// por token de salida, así que la tarifa verificada es la fuente de
// costo real, no una inferencia a partir de un conteo de tokens que no
// se documenta como base de facturación para este modelo.
export const GEMINI_IMAGE_PRICE_USD = 0.0336;

const SUPPORTED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/**
 * Misma convención que Pixabay/Anthropic/Drive: en producción vive en
 * un secreto de Docker Swarm (archivo montado en /run/secrets/...),
 * nunca en una variable de entorno en texto plano. `GEMINI_API_KEY` a
 * secas es solo para pruebas locales fuera de Docker.
 */
export const readGeminiApiKey = () => {
  const keyFile = process.env.GEMINI_API_KEY_FILE;
  if (keyFile) {
    return fs.readFileSync(keyFile, "utf8").trim();
  }
  return process.env.GEMINI_API_KEY;
};

/**
 * El prompt que de verdad se le manda a Gemini -- decisión cerrada de
 * Alex: SIEMPRE ilustrativo/esquemático, nunca fotorrealista, nunca
 * con texto/letras dentro de la imagen (evita que el motor tenga que
 * lidiar con texto generado en un idioma o con errores tipográficos).
 * `visualStyle` es opcional (del perfil del canal, ver
 * resource-acquisition.mjs) -- sin él, se usa un estilo genérico
 * razonable, nunca se deja el prompt sin ninguna guía de estilo.
 */
export const buildImageGenerationPrompt = (visualQuery, visualStyle) =>
  `Ilustración ${visualStyle ? `en el siguiente estilo: ${visualStyle}` : "esquemática, plana, de aspecto editorial/infográfico"} que muestre: ${visualQuery}

Reglas obligatorias:
- NUNCA fotorrealista -- es una ilustración/esquema, no una fotografía ni una recreación realista de una escena.
- NUNCA incluyas texto, letras, números ni rótulos dentro de la imagen.
- Sin marcas de agua visibles, sin logos, sin firmas.
- Composición simple y clara, un solo sujeto o escena central.`;

const realGenerateImage = async ({ apiKey, prompt }) => {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gemini respondió HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const payload = await res.json();
  const parts = payload.candidates?.[0]?.content?.parts ?? [];
  const imagePart = parts.find((p) => p.inlineData || p.inline_data);
  const inlineData = imagePart?.inlineData ?? imagePart?.inline_data;
  if (!inlineData?.data) {
    const finishReason = payload.candidates?.[0]?.finishReason ?? payload.candidates?.[0]?.finish_reason ?? "desconocido";
    const partTypes = parts.map((p) => Object.keys(p).join("+")).join(", ") || "ninguno";
    throw new Error(`Gemini no devolvió ninguna imagen -- finishReason="${finishReason}", partes de la respuesta=[${partTypes}].`);
  }
  const mimeType = inlineData.mimeType ?? inlineData.mime_type ?? "image/png";
  if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
    throw new Error(`Gemini devolvió una imagen con un tipo no soportado ("${mimeType}").`);
  }
  return {
    buffer: Buffer.from(inlineData.data, "base64"),
    mimeType,
    costUsd: GEMINI_IMAGE_PRICE_USD,
    usage: payload.usageMetadata ?? null,
  };
};
let generateImage = realGenerateImage;
/** Solo para pruebas: nunca llama a la API real de Gemini. */
export const __setImageGeneratorForTesting = (fn) => {
  generateImage = fn ?? realGenerateImage;
};

/**
 * Envoltorio con UN reintento automático ante un fallo TÉCNICO (mismo
 * criterio que la Capa B/C de resource-acquisition.mjs) -- registra el
 * costo de CADA intento que de verdad devolvió una imagen facturable
 * (un error HTTP/de red antes de recibir nada no se cobra, igual que
 * el resto de las APIs de este proyecto).
 */
export const generateImageWithRetry = async ({ apiKey, prompt, resourceId, log = () => {} }) => {
  let lastErr;
  let spentOnFailedAttemptsUsd = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await generateImage({ apiKey, prompt });
    } catch (err) {
      lastErr = err;
      const attemptCostUsd = err.costUsd ?? 0;
      spentOnFailedAttemptsUsd += attemptCostUsd;
      log(
        `Generación con IA -- intento ${attempt}/2 para "${resourceId}" falló (${err.message ?? err}) -- costo de ese intento: $${attemptCostUsd.toFixed(6)}.` +
          (attempt < 2 ? " Reintentando una vez." : ""),
      );
    }
  }
  lastErr.spentOnFailedAttemptsUsd = spentOnFailedAttemptsUsd;
  throw lastErr;
};
