// IA editorial (Etapa 2): a partir de la transcripción ya agrupada en
// líneas (server/captions.mjs) y la guía editorial del canal, le pide a
// Claude un plan de edición estructurado (cortes + zooms) y lo valida
// antes de dejarlo tocar el trabajo. Nunca inventa lo que no puede
// construir todavía (B-roll/gráficos externos) — eso es de una etapa
// posterior y las guías de cada canal ya se lo dicen al modelo.
import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { buildTimeline, mapOutputToSource } from "./timeline.mjs";

const DEFAULT_MODEL = process.env.EDITORIAL_MODEL ?? "claude-sonnet-5";
// Bug real en producción: con la transcripción palabra por palabra de un
// video de 12 min (mucho más texto que la versión agrupada en líneas),
// el modelo devolvió una respuesta vacía -- consistente con haber
// agotado max_tokens (4096 era demasiado poco para un plan editorial
// con muchos cortes, cada uno con su razón). Subido bastante y con un
// reintento con más margen todavía si hace falta (ver planEdit).
const FIRST_MAX_TOKENS = Number(process.env.EDITORIAL_MAX_TOKENS ?? 16000);
const RETRY_MAX_TOKENS = Number(process.env.EDITORIAL_RETRY_MAX_TOKENS ?? 32000);
// Específico de cortes -- no toca el EPSILON genérico de server/timeline.mjs
// (ese es para fusionar rangos que ya se tocan, no para juzgar si un corte
// propuesto vale la pena). Un corte más corto que esto casi nunca aísla
// una muletilla/palabra completa -- es ruido de redondeo del modelo.
const MIN_CUT_SECONDS = Number(process.env.EDITORIAL_MIN_CUT_SECONDS ?? 0.15);
// Gaps entre dos cortes propuestos por el modelo que sean MENORES a esto
// se fusionan (si no hay una palabra real en el medio) -- ver
// mergeNearbyGaplessCuts(). Mismo valor que MIN_CUT_SECONDS por ahora,
// pero es una constante aparte a propósito: miden cosas distintas.
const CUT_MERGE_GAP_SECONDS = Number(process.env.EDITORIAL_CUT_MERGE_GAP_SECONDS ?? 0.15);
// Tope de duración para los 3 CTA obligatorios (corrida real sobre el
// job ff69b475, layout screen-share): el modelo propuso CTA de 53-54s
// -- todo el tramo del discurso, no el llamado puntual -- en vez de los
// 2-15s de corridas anteriores. El prompt ya pedía brevedad y no bastó
// (ver buildPrompt/buildMiddleCtaPrompt); este tope en código es la
// garantía determinística de que la duración del CTA sea siempre
// verificable sin depender de que el modelo lo respete.
const CTA_MAX_DURATION_SECONDS = { start: 15, end: 15, middle: 8 };

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
const RESOURCE_TYPES = [
  "broll",
  "image",
  "graphic",
  "document-reference",
  "text-highlight",
  "transition",
  "music",
  "sfx",
];
const EDITORIAL_GOALS = ["evidence", "comprehension", "context", "emotion", "emphasis", "transition"];
const SEGMENTS = ["intro", "development", "demonstration", "transition", "closing"];
const INTENSITIES = ["subtle", "moderate", "prominent"];
const VERACITY_REQUIREMENTS = ["must-be-real", "illustrative-ok"];

const buildPrompt = ({
  guidelines,
  resourceProfile,
  correctionsHistory,
  transcript,
  granularity,
  durationInSeconds,
  destination,
}) => {
  const cutPrecisionInstruction =
    granularity === "word"
      ? "Los cortes deben caer EXACTAMENTE en el límite entre dos palabras consecutivas de la transcripción (el final de una palabra o el inicio de la siguiente) -- nunca a la mitad de una palabra. Como la transcripción es palabra por palabra, puedes cortar un titubeo o una repetición puntual aunque esté en medio de una frase."
      : "Los cortes deben caer EXACTAMENTE en los límites entre líneas de la transcripción (el final de una línea o el inicio de la siguiente) -- nunca a la mitad de una línea. Esta transcripción solo viene agrupada en líneas (no palabra por palabra), así que un titubeo o repetición a mitad de una línea no se puede aislar: en ese caso no lo cortes.";

  const resourceProfileText = resourceProfile
    ? `Tipos de recurso permitidos en este canal: ${resourceProfile.allowedResourceTypes?.join(", ") ?? "(todos)"}.` +
      (resourceProfile.neverFabricate?.length
        ? ` NUNCA inventes ni presentes como real: ${resourceProfile.neverFabricate.join(", ")}.`
        : "")
    : "";

  const correctionsText =
    Array.isArray(correctionsHistory) && correctionsHistory.length > 0
      ? `## Correcciones editoriales previas aprobadas por Alex (referencia, no reglas obligatorias)\n\n` +
        correctionsHistory
          .map((c) => `- [${c.segment ?? "?"}/${c.resourceType ?? "?"}] ${c.reason}${c.example ? ` (ejemplo: ${c.example})` : ""}`)
          .join("\n") +
        "\n\nEstas son observaciones humanas pasadas, no reglas maestras del canal -- úsalas como orientación de criterio, no como mandato absoluto.\n"
      : "";

  return `Eres un editor de video profesional. Analiza esta transcripción real (con tiempos en segundos) y decide cortes, zooms y recursos audiovisuales con criterio editorial genuino — no los apliques mecánicamente, piensa como lo haría un editor humano cuidadoso.

Duración total del video original: ${durationInSeconds.toFixed(2)} segundos.
Formato de salida: ${destination}.

## Guía editorial de este canal

${guidelines}

${resourceProfileText}

${correctionsText}
## Precisión de los cortes

${cutPrecisionInstruction}

## Bloques completos sin valor (problemas técnicos, no muletillas sueltas)

A veces un tramo ENTERO no aporta nada al espectador, no por tener una
muletilla aquí y otra allá, sino porque todo el tramo es ruido: problemas
para compartir pantalla, interrupciones de conexión, intentos repetidos
de configurar Zoom u otra herramienta, conversación técnica que no toca
el tema del video, y las pausas/repeticiones que esos problemas generan.
Cuando identifiques uno de estos tramos, proponé UN SOLO corte que cubra
todo el bloque de punta a punta -- no generes decenas de micro-cortes
tratando de salvar palabra por palabra dentro de ese tramo. La pregunta
es simple: "¿este tramo completo, de principio a fin, aporta algo al
tema del video?" -- si la respuesta es no, se va entero.

Al mismo tiempo, no asumas que un tramo ruidoso se extiende más de lo
que realmente dura: si una parte del audio ya tiene contenido relevante
al tema (aunque esté cerca de un tramo técnico), no la incluyas en el
corte. Cada corte grande debe justificarse con lo que realmente contiene
ese rango, no con el tramo vecino.

## Transcripción (${granularity === "word" ? "una palabra" : "una línea"} por entrada, con su rango de tiempo)

${transcriptAsText(transcript)}

## Recursos audiovisuales (B-roll, imágenes, gráficos, resaltados, transiciones, música, efectos)

Decide qué recursos incorporar, si corresponde. Principio central: NO insertes recursos por intervalos fijos ni para aparentar dinamismo -- cada uno debe aportar valor real (evidencia, comprensión, contexto, emoción, énfasis o transición). Mantener la cámara estable o prescindir de un efecto es una decisión editorial tan válida como insertarlo. Un array "resources" vacío es un resultado perfectamente válido si el video no lo necesita -- no hay cantidad mínima ni máxima que cumplir.

Para cada recurso, identifica a qué segmento del video pertenece (intro/development/demonstration/transition/closing) y sigue las reglas que la guía editorial de arriba da para ese segmento específico.

Piensa los tiempos de cada recurso en el tiempo del video ORIGINAL, igual que los cortes y zooms -- no intentes calcular tú la línea temporal final, el sistema se encarga de eso después de aplicar los cortes.

"must-be-real" en "veracityRequirement" es una instrucción para quien busque y valide el recurso después (debe ser auténtico, no generado) -- NO es una afirmación tuya de que ya lo verificaste, y tampoco implica automáticamente que el recurso sea obligatorio para el video: usa el campo "essential" para eso, por separado.

"essential" tiene una consecuencia real: si un recurso esencial no se consigue, el sistema DETIENE el video entero en vez de continuar sin él -- por eso tiene que reflejar la verdad, ni más ni menos. La pregunta correcta es una sola, por cada recurso: "¿sin este recurso específico, el argumento del video pierde sentido o se vuelve engañoso?". Si sí, essential=true -- no lo evites por precaución, esa es justamente la situación para la que existe el campo. Si la respuesta es no (el recurso ayuda, ilustra, o es una captura real de algo ya mostrado, pero el argumento se sostiene igual sin él), essential=false. No apuntes a ningún número en particular -- ni "casi nunca" ni "varios por video" -- juzga cada recurso por separado con esa pregunta.

## Llamados a la acción (CTA): tu responsabilidad es inicio y cierre, NADA de mitad

Regla global, para todos los canales: todo video debe llevar un llamado a
la acción (like/suscripción/compartir, o seguir al presentador en otra
red) en TRES momentos -- inicio, mitad y cierre. De esos tres, en este
paso SOLO te pido inicio y cierre. El de mitad lo genera un paso
completamente aparte, automático, DESPUÉS de este -- no es tarea tuya:
no propongas ningún recurso para cubrirlo, ni siquiera un recordatorio
genérico "por si acaso". Si lo hacés, se duplica con el que genera ese
otro paso y el sistema lo descarta.

- **Inicio**: si el presentador hace el llamado verbalmente cerca del
  inicio, acompañalo con un recurso sincronizado con ese momento exacto,
  con "ctaPosition": "start". Que dure solo lo que dura la invitación
  verbal (unos pocos segundos) -- nunca el resto del discurso que sigue
  después.
- **Cierre**: proponé un recurso de CTA cerca del final SIEMPRE, exista o
  no una invitación verbal ahí -- si existe, sincronizalo con ella y que
  dure lo que dura esa invitación; si no existe, que sea un recordatorio
  visual breve (unos pocos segundos), nunca un recurso que cubra todo el
  cierre del video. Marcalo con "ctaPosition": "end".

El campo "ctaPosition" (string: "start" | "end", opcional) identifica
cuál de los CTA obligatorios es cada recurso -- se usa después para
garantizar que nunca desaparezcan en silencio. Los demás recursos
(evidencia, contexto, etc.) no llevan este campo.

Si el presentador hace un llamado a la acción en CUALQUIER otro momento
del video (no solo inicio/cierre), tratalo igual que siempre: acompañalo
si corresponde, en cualquier ubicación temporal -- no lo rechaces ni lo
reubiques solo por dónde cae.

Para estos recursos, usa ÚNICAMENTE nombres de plataforma, usuarios, enlaces o datos de contacto que el presentador haya dicho explícitamente en la transcripción. NUNCA inventes un @usuario, un enlace o un nombre de perfil que no esté en la transcripción -- si el presentador dice "síganme en redes" sin especificar más, el recurso debe quedarse en lo genérico que sí dijo (el nombre de la plataforma, si la nombró), nunca completar el dato faltante. Si no hay información suficiente en la transcripción para generar el recurso correctamente, omítelo.

## Formato de respuesta

Responde ÚNICAMENTE con un objeto JSON válido, sin texto antes ni después, sin bloque de código markdown. Forma exacta:

{
  "cuts": [
    { "startSeconds": number, "endSeconds": number, "reason": "máximo 12 palabras" }
  ],
  "zooms": [
    { "startSeconds": number, "endSeconds": number, "fromScale": number, "toScale": number, "origin": { "x": number, "y": number }, "reason": "máximo 12 palabras" }
  ],
  "resources": [
    {
      "startSeconds": number, "endSeconds": number,
      "type": "${RESOURCE_TYPES.join('" | "')}",
      "description": "qué buscar o generar, concreto, máximo 20 palabras",
      "justification": "fragmento breve del discurso que lo justifica",
      "editorialGoal": "${EDITORIAL_GOALS.join('" | "')}",
      "segment": "${SEGMENTS.join('" | "')}",
      "intensity": "${INTENSITIES.join('" | "')}",
      "veracityRequirement": "${VERACITY_REQUIREMENTS.join('" | "')}",
      "essential": boolean,
      "provenanceNotes": "qué tipo de licencia hace falta, máximo 15 palabras",
      "ctaPosition": "start" | "end" | null
    }
  ],
  "notes": "resumen breve de tu criterio editorial para que un humano lo revise"
}

Si no hay nada que cortar, ningún momento que merezca zoom, o ningún recurso que aporte valor real, devuelve arrays vacíos — no inventes ediciones ni recursos solo por rellenar.`;
};

const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);

/**
 * Recorta un recurso de CTA que se excedió del tope de duración de
 * CTA_MAX_DURATION_SECONDS (ver constante arriba) -- nunca lo descarta,
 * solo acorta su `endSeconds` conservando el `startSeconds` (el momento
 * en que empieza el llamado es lo que importa, no cuánto siga hablando
 * el presentador de otra cosa después). Se usa tanto para "start"/"end"
 * (autoetiquetados por el modelo en la llamada principal) como para
 * "middle" (forzado por planMiddleCta después de parsear).
 */
export const clampCtaDuration = (resource) => {
  if (!resource.ctaPosition) return { resource, adjusted: false };
  const cap = CTA_MAX_DURATION_SECONDS[resource.ctaPosition];
  const duration = resource.endSeconds - resource.startSeconds;
  if (duration <= cap) return { resource, adjusted: false };
  return {
    resource: { ...resource, endSeconds: resource.startSeconds + cap },
    adjusted: true,
    originalDuration: duration,
    cappedDuration: cap,
  };
};

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

  // Bug real: una corrida real propuso 91 cortes, varios de 10-70ms --
  // más cortos que casi cualquier palabra hablada, sin valor editorial
  // propio (no aíslan una muletilla completa, son ruido de redondeo del
  // modelo). Se descartan, con su motivo registrado -- igual que los
  // recursos inválidos, nunca en silencio.
  const cutIssues = [];
  const rawCuts = Array.isArray(parsed.cuts) ? parsed.cuts : [];
  const cuts = [];
  rawCuts.forEach((cut, index) => {
    const label = `corte #${index + 1}`;
    if (
      !cut ||
      !isFiniteNumber(cut.startSeconds) ||
      !isFiniteNumber(cut.endSeconds) ||
      cut.endSeconds <= cut.startSeconds ||
      cut.startSeconds < 0 ||
      cut.endSeconds > durationInSeconds + 0.5 // pequeño margen por redondeo
    ) {
      cutIssues.push(`${label}: tiempos inválidos (${cut?.startSeconds}-${cut?.endSeconds}) -- descartado.`);
      return;
    }
    if (cut.endSeconds - cut.startSeconds < MIN_CUT_SECONDS) {
      cutIssues.push(
        `${label}: duración ${((cut.endSeconds - cut.startSeconds) * 1000).toFixed(0)}ms, menor al mínimo editorial de ${(MIN_CUT_SECONDS * 1000).toFixed(0)}ms -- descartado (microcorte sin valor editorial propio).`,
      );
      return;
    }
    cuts.push({
      id: `ai-cut-${index}`,
      startSeconds: cut.startSeconds,
      endSeconds: cut.endSeconds,
      reason: typeof cut.reason === "string" ? cut.reason : undefined,
    });
  });

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

  const resourceIssues = [];
  const ctaDurationAdjustments = [];
  const rawResources = Array.isArray(parsed.resources) ? parsed.resources : [];
  const resources = [];
  rawResources.forEach((resource, index) => {
    const label = `recurso #${index + 1}`;
    if (!resource || typeof resource !== "object") {
      resourceIssues.push(`${label}: no es un objeto -- descartado.`);
      return;
    }
    if (
      !isFiniteNumber(resource.startSeconds) ||
      !isFiniteNumber(resource.endSeconds) ||
      resource.endSeconds <= resource.startSeconds ||
      resource.startSeconds < 0 ||
      resource.endSeconds > durationInSeconds + 0.5
    ) {
      resourceIssues.push(`${label}: tiempos inválidos (${resource.startSeconds}-${resource.endSeconds}) -- descartado.`);
      return;
    }
    if (!RESOURCE_TYPES.includes(resource.type)) {
      resourceIssues.push(`${label}: tipo "${resource.type}" no reconocido -- descartado.`);
      return;
    }
    if (typeof resource.description !== "string" || resource.description.trim().length === 0) {
      resourceIssues.push(`${label}: sin descripción -- descartado.`);
      return;
    }
    const segment = SEGMENTS.includes(resource.segment) ? resource.segment : null;
    const editorialGoal = EDITORIAL_GOALS.includes(resource.editorialGoal) ? resource.editorialGoal : null;
    const intensity = INTENSITIES.includes(resource.intensity) ? resource.intensity : "moderate";
    const veracityRequirement = VERACITY_REQUIREMENTS.includes(resource.veracityRequirement)
      ? resource.veracityRequirement
      : "illustrative-ok";
    if (!segment || !editorialGoal) {
      resourceIssues.push(
        `${label}: segmento u objetivo editorial inválido (segment="${resource.segment}", editorialGoal="${resource.editorialGoal}") -- descartado.`,
      );
      return;
    }
    const { resource: clamped, adjusted, originalDuration, cappedDuration } = clampCtaDuration({
      id: `ai-resource-${index}`,
      startSeconds: resource.startSeconds,
      endSeconds: resource.endSeconds,
      type: resource.type,
      description: resource.description,
      justification: typeof resource.justification === "string" ? resource.justification : undefined,
      editorialGoal,
      segment,
      intensity,
      veracityRequirement,
      // must-be-real NO implica esencial -- son dos preguntas distintas
      // (¿tiene que ser auténtico? vs. ¿el video se detiene si falta?).
      // Por defecto false: la mayoría de los recursos son prescindibles.
      essential: resource.essential === true,
      provenanceNotes: typeof resource.provenanceNotes === "string" ? resource.provenanceNotes : undefined,
      // Identifica cuál de los CTA obligatorios es (si lo es) -- se usa
      // después para garantizar que nunca desaparezcan en silencio.
      ctaPosition: ["start", "end", "middle"].includes(resource.ctaPosition) ? resource.ctaPosition : undefined,
    });
    if (adjusted) {
      ctaDurationAdjustments.push(
        `CTA de "${clamped.ctaPosition}" recortado: duraba ${originalDuration.toFixed(2)}s, se acortó a ${cappedDuration.toFixed(2)}s (tope editorial, conservando el inicio en ${clamped.startSeconds.toFixed(2)}s).`,
      );
    }
    resources.push(clamped);
  });

  return {
    cuts,
    cutIssues,
    zooms,
    resources,
    resourceIssues,
    ctaDurationAdjustments,
    notes: typeof parsed.notes === "string" ? parsed.notes : "",
  };
};

/**
 * Fusiona dos cortes propuestos por el modelo cuando el hueco entre ellos
 * es menor a CUT_MERGE_GAP_SECONDS y en ese hueco no hay ninguna palabra
 * real de la transcripción -- un hueco así es casi siempre un artefacto
 * de redondeo (dos cortes decididos por separado que no coincidieron
 * exacto en el límite), no contenido que valga la pena conservar. Si SÍ
 * hay una palabra ahí, no se fusiona -- se prioriza no perder contenido
 * por sobre prolijidad.
 *
 * No toca engine/timeline.ts ni server/timeline.mjs (esos son genéricos,
 * los usan también zooms/recursos/captions) -- esto es exclusivo de
 * cortes, con su propia constante y su propia lógica consciente de
 * palabras, que esos módulos no tienen.
 */
export const mergeNearbyGaplessCuts = (cuts, transcriptWords) => {
  const hasWords = Array.isArray(transcriptWords) && transcriptWords.length > 0;
  const sorted = [...cuts].sort((a, b) => a.startSeconds - b.startSeconds);
  const merged = [];
  const mergeLog = [];

  for (const cut of sorted) {
    const last = merged[merged.length - 1];
    const gap = last ? cut.startSeconds - last.endSeconds : Infinity;

    if (last && gap >= 0 && gap <= 1e-6) {
      // Se tocan exacto (o se superponen) -- no hay hueco donde pueda
      // caber una palabra, fusiona siempre, con o sin transcriptWords.
      last.endSeconds = Math.max(last.endSeconds, cut.endSeconds);
      continue;
    }

    if (last && gap > 1e-6 && gap <= CUT_MERGE_GAP_SECONDS) {
      if (!hasWords) {
        mergeLog.push(
          `NO fusionado: hueco de ${(gap * 1000).toFixed(0)}ms entre ${last.endSeconds.toFixed(2)}s y ${cut.startSeconds.toFixed(2)}s -- sin transcripción por palabra para verificar que no haya contenido ahí, así que no se toca.`,
        );
      } else {
        const wordInGap = transcriptWords.find(
          (w) => w.endMs / 1000 > last.endSeconds && w.startMs / 1000 < cut.startSeconds,
        );
        if (!wordInGap) {
          mergeLog.push(
            `fusionado: hueco de ${(gap * 1000).toFixed(0)}ms entre ${last.endSeconds.toFixed(2)}s y ${cut.startSeconds.toFixed(2)}s (sin palabra real en el medio).`,
          );
          last.endSeconds = Math.max(last.endSeconds, cut.endSeconds);
          continue;
        }
        mergeLog.push(
          `NO fusionado: hueco de ${(gap * 1000).toFixed(0)}ms entre ${last.endSeconds.toFixed(2)}s y ${cut.startSeconds.toFixed(2)}s contiene la palabra "${wordInGap.text}" -- se conserva.`,
        );
      }
    }
    merged.push({ ...cut });
  }

  return { cuts: merged, mergeLog };
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
const MIDDLE_CTA_EXCERPT_PADDING_SECONDS = 20;

/** Entradas de la transcripción (palabras o líneas) dentro de +-padding segundos de un punto. */
const extractExcerpt = (transcript, centerSeconds, paddingSeconds) =>
  transcript.filter(
    (entry) =>
      entry.endMs / 1000 >= centerSeconds - paddingSeconds &&
      entry.startMs / 1000 <= centerSeconds + paddingSeconds,
  );

const buildMiddleCtaPrompt = ({ guidelines, resourceProfile, midpointSourceSeconds, excerpt, granularity, destination }) => {
  const resourceProfileText = resourceProfile
    ? `Tipos de recurso permitidos en este canal: ${resourceProfile.allowedResourceTypes?.join(", ") ?? "(todos)"}.` +
      (resourceProfile.neverFabricate?.length
        ? ` NUNCA inventes ni presentes como real: ${resourceProfile.neverFabricate.join(", ")}.`
        : "")
    : "";

  return `Estás completando un plan de edición de video ya decidido -- los cortes y zooms de este video YA se definieron en un paso anterior. Tu única tarea ahora es el recurso de llamado a la acción (CTA) que va OBLIGATORIAMENTE cerca de la mitad del video ya editado.

Formato de salida: ${destination}.

## Guía editorial de este canal

${guidelines}

${resourceProfileText}

## Dónde cae la mitad

El punto medio del video YA EDITADO (con los cortes ya aplicados), traducido de vuelta al tiempo del video ORIGINAL, es ${midpointSourceSeconds.toFixed(2)} segundos. Acá tenés la transcripción real alrededor de ese punto (tiempo original, ${granularity === "word" ? "una palabra" : "una línea"} por entrada):

${transcriptAsText(excerpt)}

## Tu tarea

Proponé EXACTAMENTE UN recurso de CTA (like, suscripción, compartir, o seguir al presentador en otra red) ubicado en este fragmento, lo más cerca posible de ${midpointSourceSeconds.toFixed(2)}s sin interrumpir una explicación en curso -- podés moverlo unos segundos antes o después dentro de este fragmento si hace falta. Este CTA es obligatorio: el presentador no tiene que haberlo pedido verbalmente acá, el sistema lo agrega por decisión editorial, independiente de lo que se diga en este tramo puntual. Que sea breve y discreto: unos pocos segundos (no más de 8), un recordatorio puntual, nunca un tramo largo del discurso -- no tape información importante. NUNCA inventes un @usuario, enlace o nombre de perfil que no esté en la transcripción.

## Formato de respuesta

Responde ÚNICAMENTE con un objeto JSON válido, sin texto antes ni después, sin bloque de código markdown. Forma exacta (igual que siempre, pero "cuts" y "zooms" vacíos y "resources" con exactamente un elemento):

{
  "cuts": [],
  "zooms": [],
  "resources": [
    {
      "startSeconds": number, "endSeconds": number,
      "type": "${RESOURCE_TYPES.join('" | "')}",
      "description": "qué mostrar, concreto, máximo 20 palabras",
      "justification": "fragmento breve del discurso que lo justifica, si lo hay",
      "editorialGoal": "emphasis",
      "segment": "development",
      "intensity": "subtle",
      "veracityRequirement": "illustrative-ok",
      "essential": false,
      "provenanceNotes": "qué tipo de licencia hace falta, máximo 15 palabras"
    }
  ],
  "notes": ""
}`;
};

/**
 * Segunda llamada, chica y aparte, solo para el CTA obligatorio de
 * mitad de video (Decisión 6 del auditor). No se puede resolver en la
 * misma llamada que decide los cortes: la "mitad" tiene que calcularse
 * sobre la duración YA EDITADA, que no se conoce hasta que el modelo
 * terminó de decidir los cortes. Es una capa más sobre el render, no un
 * requisito -- si falla, se registra y se omite sin romper el resto del
 * plan (un video sin el CTA de mitad sigue siendo mejor que un job que
 * se detiene por esto).
 */
const planMiddleCta = async ({
  cuts,
  captions,
  transcriptWords,
  guidelines,
  resourceProfile,
  durationInSeconds,
  destination,
  model,
  onLog,
}) => {
  const timeline = buildTimeline(durationInSeconds, cuts);
  const midpointOutputSeconds = timeline.outputDurationInSeconds / 2;
  const midpointSourceSeconds = mapOutputToSource(timeline, midpointOutputSeconds);

  const useWords = Array.isArray(transcriptWords) && transcriptWords.length > 0;
  const fullTranscript = useWords ? transcriptWords : captions;
  const excerpt = extractExcerpt(fullTranscript, midpointSourceSeconds, MIDDLE_CTA_EXCERPT_PADDING_SECONDS);
  if (excerpt.length === 0) {
    throw new Error(
      `sin transcripción alrededor del punto medio (${midpointSourceSeconds.toFixed(2)}s) -- no se puede generar el CTA de mitad.`,
    );
  }

  const prompt = buildMiddleCtaPrompt({
    guidelines,
    resourceProfile,
    midpointSourceSeconds,
    excerpt,
    granularity: useWords ? "word" : "line",
    destination,
  });

  onLog(`CTA de mitad de video: punto medio editado=${midpointOutputSeconds.toFixed(2)}s -> original=${midpointSourceSeconds.toFixed(2)}s, pidiendo recurso...`);
  const anthropic = getClient();
  const attempt = await callModel({ anthropic, prompt, model, maxTokens: FIRST_MAX_TOKENS });
  onLog(
    `CTA de mitad de video: respuesta stop_reason=${attempt.stopReason}, tokens=${attempt.inputTokens}in/${attempt.outputTokens}out (razonamiento=${attempt.thinkingTokens ?? "?"})`,
  );

  const parsed = parseEditorialResponse(attempt.text, durationInSeconds);
  if (parsed.resources.length === 0) {
    onLog("CTA de mitad de video: el modelo no propuso ninguno en este fragmento -- se omite.");
    return { resource: null, metrics: attempt };
  }
  const { resource: clamped, adjusted, originalDuration, cappedDuration } = clampCtaDuration({
    ...parsed.resources[0],
    id: "ai-resource-middle-cta",
    ctaPosition: "middle",
  });
  if (adjusted) {
    onLog(
      `CTA de mitad de video recortado: duraba ${originalDuration.toFixed(2)}s, se acortó a ${cappedDuration.toFixed(2)}s (tope editorial, conservando el inicio en ${clamped.startSeconds.toFixed(2)}s).`,
    );
  }
  return {
    resource: clamped,
    metrics: attempt,
  };
};

export const planEdit = async ({
  captions,
  // Opcional: tiempos por palabra (de whisper). Si viene, se usa en vez
  // de `captions` para poder cortar en cualquier palabra, no solo entre
  // líneas agrupadas -- ver buildPrompt.
  transcriptWords,
  guidelines,
  // Opcional: contenido de editorial-profile.json del canal (tipos de
  // recurso permitidos, qué nunca fabricar).
  resourceProfile,
  // Opcional: contenido de editorial-corrections.json del canal --
  // observaciones humanas pasadas, nunca reglas que el sistema reescriba
  // solo. Ver server/index.mjs.
  correctionsHistory,
  durationInSeconds,
  destination,
  model = DEFAULT_MODEL,
  onLog = () => {},
}) => {
  const useWords = Array.isArray(transcriptWords) && transcriptWords.length > 0;
  const prompt = buildPrompt({
    guidelines,
    resourceProfile,
    correctionsHistory,
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

  if (plan.resourceIssues.length > 0) {
    onLog(`${plan.resourceIssues.length} recurso(s) propuesto(s) se descartaron:`);
    for (const issue of plan.resourceIssues) {
      onLog(`  ${issue}`);
    }
  }

  if (plan.ctaDurationAdjustments.length > 0) {
    for (const adjustment of plan.ctaDurationAdjustments) {
      onLog(adjustment);
    }
  }

  // Defecto real en una corrida sobre job ff69b475: la llamada principal
  // propuso su propio recurso (sin ctaPosition) como recordatorio de
  // mitad de video, duplicando el que genera planMiddleCta más abajo.
  // No hay forma confiable de distinguir ese duplicado de un recurso
  // legítimo sin la etiqueta -- adivinar arriesga descartar algo real en
  // silencio, justo lo que esta garantía quiere evitar. La corrección es
  // en el prompt (ver buildPrompt): ya no se le pide nada sobre la
  // mitad, así que no debería volver a proponer uno.

  // CTA obligatorio de mitad de video (Decisión 6 del auditor) -- capa
  // aparte sobre el plan principal, nunca bloquea el resto si falla.
  // El auditor fue explícito: el plan NUNCA puede salir sin el CTA de
  // mitad sin que quede registrado de forma visible -- nunca una
  // omisión en silencio, ni siquiera cuando la causa es que la llamada
  // falló o el modelo decidió no proponer nada.
  const ctaIssues = [];
  let middleCtaMetrics = null;
  try {
    const { resource, metrics } = await planMiddleCta({
      cuts: plan.cuts,
      captions,
      transcriptWords,
      guidelines,
      resourceProfile,
      durationInSeconds,
      destination,
      model,
      onLog,
    });
    middleCtaMetrics = metrics;
    if (resource) {
      plan.resources.push(resource);
    } else {
      ctaIssues.push(
        "Falta el CTA obligatorio de \"middle\": el modelo no propuso ninguno en el fragmento alrededor del punto medio.",
      );
    }
  } catch (err) {
    onLog(`CTA de mitad de video falló (${err.message ?? err}) -- se omite, no bloquea el resto del plan.`);
    ctaIssues.push(`Falta el CTA obligatorio de "middle": la llamada falló (${err.message ?? err}).`);
  }

  return {
    ...plan,
    ctaIssues,
    metrics: {
      elapsedMs,
      model,
      stopReason: attempt.stopReason,
      inputTokens: attempt.inputTokens + (middleCtaMetrics?.inputTokens ?? 0),
      outputTokens: attempt.outputTokens + (middleCtaMetrics?.outputTokens ?? 0),
      thinkingTokens: attempt.thinkingTokens,
      maxTokens: maxTokensUsed,
      retried,
      middleCta: middleCtaMetrics
        ? {
            stopReason: middleCtaMetrics.stopReason,
            inputTokens: middleCtaMetrics.inputTokens,
            outputTokens: middleCtaMetrics.outputTokens,
          }
        : null,
    },
  };
};
