// Fase 3B (31-oct-2026, dictamen "integración mínima de imágenes y
// B-roll"; corregido 01-nov-2026 tras un falso positivo real -- ver
// "Capa A"/"Capa B" abajo): resuelve recursos `broll`/`image` que el
// planificador ya decidió (tipo, intervalo, `visualQuery`) contra
// Pixabay -- la IA editorial sigue decidiendo QUÉ/CUÁNDO/CUÁNTO DURA;
// este módulo solo responde DÓNDE conseguir el archivo, legalmente, con
// su licencia registrada, Y si de verdad corresponde al sujeto de la
// consulta.
//
// Cumplimiento de los términos de Pixabay (https://pixabay.com/api/docs/),
// verificados en la investigación previa (31-oct-2026):
// - Caché de 24h por consulta (obligatoria en sus términos) -- nunca se
//   repite la misma búsqueda dentro de esa ventana.
// - Un solo pedido de búsqueda por consulta nueva (no se reintenta en
//   bucle); un 429 o un error de red se trata como fallo de ESE
//   recurso, nunca tumba el job completo.
// - Solo se descarga el archivo elegido, nunca todos los candidatos de
//   una búsqueda ("sin descargas masivas").
//
// RELEVANCIA, en tres capas (Capa C añadida el 01-nov-2026, autorizada
// por Alex, tras un segundo incidente real: la Capa B aprobó un
// candidato por sus etiquetas -- "macbook", "escritorio", "oficina en
// casa" -- para "laptop sobre un escritorio de oficina moderno", pero
// la foto real era un CELULAR sobre un cuaderno. Las etiquetas de un
// banco pueden describir mal el contenido real; solo ver la imagen lo
// detecta):
//
// - Capa A (palabras clave, sin IA, abajo): exige que el candidato
//   cubra una fracción mínima de las palabras SIGNIFICATIVAS de la
//   consulta (no solo una), y un mínimo absoluto de coincidencias.
//   Gratis, determinista, pero no entiende significado -- un candidato
//   puede cubrir el 100% de las palabras y aun así ser el sujeto
//   equivocado (un perro con las etiquetas "persona, corriendo,
//   amanecer, parque" puestas por quien subió la foto, por ejemplo).
// - Capa B (validación con IA, Claude Haiku, SOLO texto -- id, tipo,
//   etiquetas, NUNCA la imagen): sobre los finalistas que sobrevivan la
//   Capa A, un modelo barato juzga si el SUJETO real corresponde a la
//   consulta, no solo si las palabras coinciden. Esto SÍ puede
//   reconocer que "cachorro"/"perro" contradice "persona" aunque las
//   etiquetas comiencen compartiendo varias palabras -- pero sigue
//   siendo un juicio sobre lo que el banco escribió en las etiquetas,
//   NUNCA una verificación visual de la imagen real.
// - Capa C (validación VISUAL con IA, mismo modelo, sobre la miniatura
//   REAL -- nunca las etiquetas): confirma, viendo de verdad la
//   miniatura del candidato que la Capa B aprobó, que el sujeto
//   corresponde. Si lo rechaza, prueba -- en el mismo orden de puntaje
//   de la Capa A -- los demás finalistas, hasta un máximo acotado.
//   Esto SÍ ve la imagen real, pero sigue siendo una miniatura chica,
//   de un solo fotograma en el caso de video -- no es una garantía
//   absoluta, es la mejor evidencia visual barata disponible.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { getClient } from "./editorial.mjs";

/**
 * Misma convención que la clave de Anthropic (editorial.mjs#readApiKey) y
 * la credencial de Drive: en producción vive en un secreto de Docker
 * Swarm (archivo montado en /run/secrets/...), nunca en una variable de
 * entorno en texto plano. `PIXABAY_API_KEY` a secas es solo para
 * pruebas locales fuera de Docker.
 */
export const readPixabayApiKey = () => {
  const keyFile = process.env.PIXABAY_API_KEY_FILE;
  if (keyFile) {
    return fs.readFileSync(keyFile, "utf8").trim();
  }
  return process.env.PIXABAY_API_KEY;
};

const PIXABAY_LICENSE_URL = "https://pixabay.com/service/license-summary/";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h, exigido por los términos de Pixabay

// --- Capa A: palabras clave --------------------------------------------

// Umbrales elegidos para que los tres falsos positivos reales del
// 01-nov-2026 (score=1 sobre 4-6 palabras significativas, 17-25% de
// cobertura) queden rechazados con cualquiera de los dos criterios por
// separado, no solo combinados.
const MIN_ABSOLUTE_OVERLAP = 2;
const MIN_COVERAGE_RATIO = 0.5;
// Cuántos finalistas como mucho se le mandan a la Capa B -- acotado
// para que el costo y el tamaño del prompt no crezcan con la cantidad
// de candidatos que devuelva Pixabay.
const MAX_FINALISTS = 3;

// Palabras demasiado comunes para decir algo sobre relevancia visual.
// "sin" se agregó el 01-nov-2026 tras el incidente real: coincidía con
// la etiqueta "sin fondo" (sin relación con el contenido visual) y
// bastaba para que una consulta sin sentido pasara el filtro.
const STOPWORDS = new Set([
  "de", "la", "el", "los", "las", "un", "una", "unos", "unas", "y", "o", "en", "con", "para", "por", "del", "al",
  "a", "que", "su", "sus", "sin", "sobre", "entre", "desde", "hasta", "muy", "mas", "esta", "este", "estos", "estas",
  "the", "an", "of", "in", "on", "with", "for", "and", "or", "to",
]);

const normalizeToken = (token) =>
  token
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, ""); // quita acentos (á->a, ñ->n, etc.)

/** Tokeniza texto libre en un set de palabras significativas (sin stopwords, sin acentos). */
export const tokenize = (text) =>
  new Set(
    (text ?? "")
      .split(/[^a-zA-Z0-9áéíóúñÁÉÍÓÚÑ]+/)
      .map(normalizeToken)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  );

/** Qué tokens de la consulta aparecen realmente en las etiquetas -- para el log, no solo el número. */
export const matchedTokens = (query, tagsString) => {
  const queryTokens = tokenize(query);
  const tagTokens = tokenize((tagsString ?? "").replace(/,/g, " "));
  return [...queryTokens].filter((t) => tagTokens.has(t));
};

/**
 * Comprobación de relevancia por PALABRAS CLAVE, sin llamar a ningún
 * modelo -- cuenta cuántos tokens de la consulta aparecen en las
 * etiquetas que Pixabay ya le puso al archivo. Es menos preciso que
 * una verificación semántica (ver Capa B); es intencional: cualquier
 * candidato que no llegue ni a este piso léxico ni vale la pena
 * mandarlo a la Capa B (ahorra esa llamada).
 */
export const scoreKeywordOverlap = (query, tagsString) => matchedTokens(query, tagsString).length;

/**
 * Ordena TODOS los candidatos por coincidencia léxica, con su
 * cobertura (score / cantidad de palabras significativas de la
 * consulta) -- la cobertura es la que de verdad decide si pasa la
 * Capa A, no el score absoluto solo.
 */
export const rankCandidates = (hits, query) => {
  const queryTokenCount = tokenize(query).size;
  return (hits ?? [])
    .map((hit) => {
      const score = scoreKeywordOverlap(query, hit.tags);
      return { hit, score, coverage: queryTokenCount > 0 ? score / queryTokenCount : 0 };
    })
    .sort((a, b) => b.score - a.score);
};

/**
 * Capa A: de los candidatos ya ordenados, los que de verdad valen la
 * pena mandar a la Capa B -- deben cumplir el mínimo absoluto DE
 * COINCIDENCIAS y el mínimo de COBERTURA relativa a la consulta, los
 * dos a la vez (ver comentario grande arriba del archivo con los
 * números reales de los tres falsos positivos que esto corrige).
 */
export const filterFinalists = (ranked, { minAbsolute = MIN_ABSOLUTE_OVERLAP, minCoverage = MIN_COVERAGE_RATIO, maxFinalists = MAX_FINALISTS } = {}) =>
  ranked.filter((r) => r.score >= minAbsolute && r.coverage >= minCoverage).slice(0, maxFinalists);

/** Candidatos (id + score + cobertura) para el log -- nunca la clave de la API. */
const describeRankedForLog = (ranked) =>
  ranked.map((r) => `#${r.hit.id}(score=${r.score}, cobertura=${(r.coverage * 100).toFixed(0)}%)`).join(", ") || "ninguno";

const slugifyForCacheKey = (text) => [...tokenize(text)].sort().join("-");

const cacheFilePath = (cacheDir, mediaType, query) =>
  path.join(cacheDir, `${mediaType}-${slugifyForCacheKey(query) || "vacio"}.json`);

/**
 * Caché obligatoria de 24h por consulta (término de uso de la API de
 * Pixabay: "debes cachear los resultados por al menos 24 horas"). Un
 * archivo por consulta normalizada -- nunca vuelve a llamar a la API
 * para la misma búsqueda dentro de la ventana, en ningún job.
 */
const readCache = async (cacheDir, mediaType, query) => {
  try {
    const raw = await fsp.readFile(cacheFilePath(cacheDir, mediaType, query), "utf8");
    const entry = JSON.parse(raw);
    if (Date.now() - entry.cachedAt < CACHE_TTL_MS) {
      return entry.hits;
    }
    return null; // venció -- se vuelve a consultar
  } catch {
    return null;
  }
};

const writeCache = async (cacheDir, mediaType, query, hits) => {
  await fsp.mkdir(cacheDir, { recursive: true });
  await fsp.writeFile(
    cacheFilePath(cacheDir, mediaType, query),
    JSON.stringify({ cachedAt: Date.now(), query, hits }, null, 2),
  );
};

const realFetchJson = async (url) => {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Pixabay respondió ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
};
let fetchJson = realFetchJson;
/** Solo para pruebas: nunca llama a la red real de Pixabay. */
export const __setFetchJsonForTesting = (fn) => {
  fetchJson = fn ?? realFetchJson;
};

const realDownloadToFile = async (url, destPath) => {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`No se pudo descargar ${url}: HTTP ${res.status}`);
  }
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  const buffer = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(destPath, buffer);
};
let downloadToFile = realDownloadToFile;
/** Solo para pruebas: nunca descarga nada real. */
export const __setDownloadToFileForTesting = (fn) => {
  downloadToFile = fn ?? realDownloadToFile;
};

/**
 * Busca en Pixabay (imágenes o videos) UNA sola vez por consulta nueva
 * -- si ya hay una entrada de caché vigente (<24h), la usa y no llama a
 * la API. `per_page` chico a propósito: solo se piden candidatos para
 * elegir el mejor, nunca para descargarlos todos.
 */
export const searchPixabay = async ({ apiKey, query, mediaType, lang = "es", cacheDir, log = () => {} }) => {
  const cached = await readCache(cacheDir, mediaType, query);
  if (cached) {
    log(`Pixabay (${mediaType}): "${query}" -- resultado en caché (sin llamar a la API) -- candidatos: ${describeRankedForLog(rankCandidates(cached, query))}.`);
    return cached;
  }

  const endpoint = mediaType === "video" ? "https://pixabay.com/api/videos/" : "https://pixabay.com/api/";
  const params = new URLSearchParams({
    key: apiKey,
    q: query,
    lang,
    per_page: "5",
    safesearch: "true",
    ...(mediaType === "image" ? { image_type: "all" } : {}),
  });

  let payload;
  try {
    payload = await fetchJson(`${endpoint}?${params.toString()}`);
  } catch (err) {
    // Un fallo de red/API (incluido un 429 por exceder el límite de
    // solicitudes) nunca tumba el job -- se trata como "sin resultados"
    // para ESTE recurso, se registra, y se sigue con los demás.
    log(`Pixabay (${mediaType}): "${query}" -- falló la búsqueda (${err.message ?? err}).`);
    return [];
  }

  const hits = Array.isArray(payload.hits) ? payload.hits : [];
  await writeCache(cacheDir, mediaType, query, hits);
  log(`Pixabay (${mediaType}): "${query}" -- ${hits.length} candidato(s), cacheados por 24h -- candidatos: ${describeRankedForLog(rankCandidates(hits, query))}.`);
  if (mediaType === "video" && hits.length > 0) {
    // Diagnóstico de UNA sola vez, sin costo de IA (pedido explícito de
    // Alex, 01-nov-2026, antes de confiar en qué campo trae el
    // fotograma de cada video): la documentación oficial de Pixabay
    // muestra `videos.<tamaño>.thumbnail`, pero eso nunca se confirmó
    // contra una respuesta real. Esto imprime las claves reales, nada
    // más -- ni descarga ni analiza nada.
    const firstHit = hits[0];
    const sizeKeys = Object.keys(firstHit.videos ?? {});
    const perSizeKeys = sizeKeys.map((size) => `${size}=[${Object.keys(firstHit.videos[size] ?? {}).join(",")}]`).join(" ");
    log(`Pixabay (video): diagnóstico de campos reales -- primer candidato #${firstHit.id} -- claves de nivel superior=[${Object.keys(firstHit).join(",")}] -- claves por tamaño: ${perSizeKeys}.`);
  }
  return hits;
};

const pickImageUrl = (hit) => hit.largeImageURL ?? hit.webformatURL;
const pickVideoUrl = (hit) => hit.videos?.large?.url ?? hit.videos?.medium?.url ?? hit.videos?.small?.url;

const extensionFor = (url, fallback) => {
  const match = /\.([a-zA-Z0-9]+)(?:\?|$)/.exec(url ?? "");
  return match ? match[1] : fallback;
};

// --- Capa B: validación semántica con IA (solo texto) -------------------

// Confirmado en claude.com/pricing el 01-nov-2026 (no se asumió Haiku
// 4.5, que es el que estaba vigente antes de esta corrección): Haiku
// 5.5, para prompts de hasta 100K tokens, $0.10/MTok de entrada y
// $0.50/MTok de salida -- 90% más barato que Haiku 4.5.
export const RELEVANCE_MODEL = "claude-haiku-5-5";
export const RELEVANCE_MODEL_INPUT_PRICE_PER_TOKEN = 0.10 / 1_000_000;
export const RELEVANCE_MODEL_OUTPUT_PRICE_PER_TOKEN = 0.50 / 1_000_000;

/** Costo real de una llamada, a partir del uso que devuelve la API (nunca estimado). */
export const computeRelevanceCallCostUsd = (usage) =>
  (usage?.input_tokens ?? 0) * RELEVANCE_MODEL_INPUT_PRICE_PER_TOKEN + (usage?.output_tokens ?? 0) * RELEVANCE_MODEL_OUTPUT_PRICE_PER_TOKEN;

// Incidente real (01-nov-2026): con 2 finalistas y etiquetas muy
// repetidas ("iphone" x4, "oficina" x5 en los datos crudos de
// Pixabay), la llamada devolvió texto VACÍO y el recurso (un caso
// positivo real) quedó rechazado por el fail-safe en vez de aceptado.
// CAUSA RAÍZ real, confirmada el 01-nov-2026 con una segunda corrida
// real (ver Capa C abajo): esta hipótesis original ("era solo
// max_tokens insuficiente") era PARCIAL. La causa de fondo es que la
// API de Mensajes tiene el razonamiento extendido ("thinking") ENCENDIDO
// POR DEFECTO, y claude-haiku-5-5 por defecto usa thinking ADAPTATIVO
// sin que se pida nada -- confirmado en la documentación oficial
// (platform.claude.com/docs/en/build-with-claude/thinking: "Messages
// API: On by default"; tabla por modelo: Haiku 5.5 sin el campo
// "thinking" -> "Adaptive thinking"). Eso consumía el presupuesto de
// salida con un bloque "thinking" antes de completar el JSON. Se
// corrige con `thinking: {type: "disabled"}` (confirmado que Haiku 5.5
// acepta ese valor, con thinking apagado del todo, mientras no se le
// pida un "effort" de xhigh/max -- no se pide ninguno aquí). Además,
// se sube el margen de salida de 200 a 1024 tokens como defensa
// adicional -- el costo real no sube con esto, porque se cobra por lo
// que el modelo efectivamente genera, no por el tope.
const RELEVANCE_MAX_OUTPUT_TOKENS = 1024;
// 1 reintento automático ante un fallo TÉCNICO (respuesta vacía, JSON
// no parseable, error de red/timeout) -- nunca ante un veredicto real
// ("ninguno sirve" no es un error, es una respuesta válida y se
// respeta sin reintentar).
const RELEVANCE_MAX_ATTEMPTS = 2;

/**
 * Quita etiquetas duplicadas (ignorando mayúsculas/espacios) antes de
 * mandarlas al modelo o al log -- un candidato con "iphone" repetido 4
 * veces en los datos crudos de Pixabay no debe inflar ni el costo del
 * prompt ni la lectura del log. No afecta el puntaje de la Capa A
 * (que ya usa un Set internamente), solo lo que se muestra/envía.
 */
export const dedupeTagsString = (tagsString) => {
  const seen = new Set();
  const kept = [];
  for (const raw of (tagsString ?? "").split(",")) {
    const trimmed = raw.trim();
    const key = trimmed.toLowerCase();
    if (trimmed && !seen.has(key)) {
      seen.add(key);
      kept.push(trimmed);
    }
  }
  return kept.join(", ");
};

const buildRelevancePrompt = (query, finalists) =>
  `Eres un validador de relevancia visual, nada más -- no decides si usar el recurso, solo si el SUJETO de cada candidato corresponde de verdad a la consulta.

Nunca viste ninguna imagen ni video real: solo tenés el id, el tipo y las etiquetas que el propio banco (Pixabay) le puso a cada candidato. Tu juicio es sobre esas etiquetas, no sobre contenido visual.

Consulta: "${query}"

Candidatos (cada uno ya comparte AL MENOS algunas palabras con la consulta -- tu trabajo es decidir si el SUJETO real coincide, no solo si hay palabras en común):
${finalists.map((f, i) => `${i + 1}. id=${f.hit.id} tipo=${f.hit.type ?? "?"} etiquetas="${dedupeTagsString(f.hit.tags)}"`).join("\n")}

Elegí el ÚNICO candidato cuyo sujeto real corresponde a la consulta. Si ninguno corresponde (por ejemplo: la consulta pide una persona y el candidato es un animal; o la consulta no tiene relación real con ningún candidato aunque compartan alguna palabra suelta), elegí ninguno -- es preferible no elegir nada que elegir el equivocado. No inventes nada que no esté en las etiquetas.

Responde ÚNICAMENTE con un objeto JSON, sin texto antes ni después, sin bloque de código, sin explicación aparte del campo "reason":
{"chosenId": <id de un candidato de la lista> | null, "reason": "una frase breve, en español"}`;

const parseRelevanceResponse = (rawText, validIds) => {
  const cleaned = (rawText ?? "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();

  const tryParse = (candidate) => {
    try {
      return JSON.parse(candidate);
    } catch {
      return undefined;
    }
  };

  // Parseo tolerante: si el texto viene limpio, se parsea directo. Si
  // el modelo agregó algo de prosa alrededor del JSON, se busca el
  // primer objeto "{...}" dentro del texto antes de darse por vencido
  // -- pero si no hay NADA de texto (el incidente real del 01-nov-2026),
  // no hay nada que buscar y el error lo dice explícitamente.
  let parsed = tryParse(cleaned);
  if (!parsed) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) parsed = tryParse(match[0]);
  }
  if (!parsed) {
    throw new Error(
      cleaned.length === 0
        ? "el validador de relevancia devolvió una respuesta de texto VACÍA (sin ningún bloque de texto utilizable)."
        : `el validador de relevancia no devolvió JSON válido: "${cleaned.slice(0, 200)}"`,
    );
  }
  if (parsed.chosenId !== null && !validIds.includes(parsed.chosenId)) {
    throw new Error(`el validador de relevancia eligió el id ${parsed.chosenId}, que no estaba entre los finalistas (${validIds.join(", ")}).`);
  }
  if (typeof parsed.reason !== "string" || parsed.reason.trim().length === 0) {
    throw new Error("el validador de relevancia no dio un motivo.");
  }
  return { chosenId: parsed.chosenId, reason: parsed.reason.trim() };
};

/**
 * Llama a Claude Haiku para juzgar, SOLO con id/tipo/etiquetas (nunca
 * una imagen), cuál finalista (si alguno) corresponde de verdad al
 * sujeto de la consulta. Devuelve `{chosenId, reason, usage}` --
 * `usage` es el consumo REAL de tokens que devuelve la API, para poder
 * loguear el costo real (nunca estimado) de cada llamada.
 *
 * Si la respuesta no se puede parsear (el incidente real: texto
 * vacío), el error que se lanza lleva adjunto `.usage` (para poder
 * contar el costo de ESE intento fallido también) y un mensaje con
 * diagnóstico -- stop_reason, qué tipos de bloque devolvió el
 * contenido, y los tokens -- nunca ninguna clave.
 */
const realValidateRelevanceWithAI = async ({ query, finalists }) => {
  const client = getClient();
  const response = await client.messages.create({
    model: RELEVANCE_MODEL,
    max_tokens: RELEVANCE_MAX_OUTPUT_TOKENS,
    thinking: { type: "disabled" },
    messages: [{ role: "user", content: buildRelevancePrompt(query, finalists) }],
  });
  const usage = response.usage ?? { input_tokens: 0, output_tokens: 0 };
  const contentBlocks = response.content ?? [];
  const text = contentBlocks
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
  const validIds = finalists.map((f) => f.hit.id);
  try {
    const { chosenId, reason } = parseRelevanceResponse(text, validIds);
    return { chosenId, reason, usage };
  } catch (err) {
    const blockTypes = contentBlocks.map((b) => b.type).join(", ") || "ninguno";
    const diagnosed = new Error(
      `${err.message} -- diagnóstico: stop_reason="${response.stop_reason ?? "desconocido"}", bloques de contenido=[${blockTypes}], tokens=${usage.input_tokens ?? 0} entrada / ${usage.output_tokens ?? 0} salida.`,
    );
    diagnosed.usage = usage;
    throw diagnosed;
  }
};
let validateRelevanceWithAI = realValidateRelevanceWithAI;
/** Solo para pruebas: nunca llama a la API real de Anthropic. */
export const __setRelevanceValidatorForTesting = (fn) => {
  validateRelevanceWithAI = fn ?? realValidateRelevanceWithAI;
};

/**
 * Envoltorio con UN reintento automático ante un fallo TÉCNICO de la
 * Capa B (nunca ante un veredicto válido, incluido "ninguno sirve").
 * Registra el costo de CADA intento, exitoso o no -- si los dos
 * intentos fallan, el error final lleva adjunto el costo total
 * gastado en los intentos fallidos (`.spentOnFailedAttemptsUsd`) para
 * que quede en el log de rechazo también.
 */
const validateRelevanceWithRetry = async ({ query, finalists, resourceId, log }) => {
  let lastErr;
  let spentOnFailedAttemptsUsd = 0;
  for (let attempt = 1; attempt <= RELEVANCE_MAX_ATTEMPTS; attempt++) {
    try {
      return await validateRelevanceWithAI({ query, finalists });
    } catch (err) {
      lastErr = err;
      const attemptCostUsd = computeRelevanceCallCostUsd(err.usage);
      spentOnFailedAttemptsUsd += attemptCostUsd;
      log(
        `Pixabay: Capa B -- intento ${attempt}/${RELEVANCE_MAX_ATTEMPTS} para "${resourceId}" falló (${err.message}) -- costo de ese intento: $${attemptCostUsd.toFixed(6)}.` +
          (attempt < RELEVANCE_MAX_ATTEMPTS ? " Reintentando una vez." : ""),
      );
    }
  }
  lastErr.spentOnFailedAttemptsUsd = spentOnFailedAttemptsUsd;
  throw lastErr;
};

// --- Capa C: validación VISUAL sobre la miniatura real (autorizado por
// Alex, 01-nov-2026, tras un defecto real: la Capa B aprobó #2846221
// ("laptop sobre un escritorio de oficina moderno") por sus etiquetas
// ("macbook", "escritorio", "oficina en casa"), pero la foto real
// mostraba un CELULAR sobre un cuaderno -- las etiquetas describían
// mal el contenido real. Esta capa no reemplaza ni reescribe la Capa A
// ni la Capa B: corre DESPUÉS, sobre el candidato que la Capa B
// aprobó, y si esa evaluación visual lo rechaza, sigue -- en el mismo
// orden de puntaje de la Capa A -- con los demás finalistas, hasta un
// máximo de VISUAL_MAX_EVALUATIONS evaluaciones por recurso. El
// recurso queda pendiente solo si TODAS las evaluaciones intentadas
// rechazan (o fallan técnicamente). -------------------------------

// Autorización explícita de Alex: Capa B + hasta 2 finalistas más (3
// evaluaciones visuales en total por recurso), nunca más.
const VISUAL_MAX_EVALUATIONS = 3;
// Mismo criterio que la Capa B: 1 reintento automático ante un fallo
// TÉCNICO (nunca ante un "no corresponde" -- eso es un veredicto
// válido, no un error).
const VISUAL_MAX_ATTEMPTS = 2;
// DEFECTO REAL (job b7c0c8ac, 01-nov-2026): con 300 tokens de salida y
// el razonamiento extendido encendido por defecto (ver Capa B arriba),
// la llamada se agotó en stop_reason="max_tokens" con un bloque
// "thinking" que consumió el presupuesto -- el JSON quedó truncado a
// mitad de un veredicto que SÍ rechazaba el candidato correctamente
// ({"aprobado": false, "motivo": "Aparece una laptop, pero el
// escritorio es de madera rústica..." -- cortado ahí). Mismo arreglo
// que la Capa B: `thinking: {type: "disabled"}` en la llamada de abajo,
// más este margen subido de 300 a 1024 como defensa adicional (sin
// costo real extra -- se cobra por lo generado, no por el tope).
const VISUAL_MAX_OUTPUT_TOKENS = 1024;

// DECISIÓN (pedida explícitamente por Alex antes de codificar esto):
// la miniatura NUNCA se manda como `source: {type: "url", url: ...}`
// apuntando directo al CDN de Pixabay. La documentación oficial de la
// API de Pixabay (https://pixabay.com/api/docs/) dice literalmente:
// "permanent hotlinking of images (using Pixabay URLs in your app) is
// not allowed. If you intend to use the images, please download them
// to your server first." Aunque nuestro caso es una llamada
// servidor-a-modelo y no un sitio público, la instrucción es clara y
// la miniatura pesa unos pocos KB (webformatURL, <=640px) -- se
// descarga una sola vez a memoria (nunca a disco, nunca se guarda) y
// se manda en base64. Esto también evita depender de que Anthropic
// pueda alcanzar el CDN de Pixabay desde sus propios servidores (no
// confirmado, y ahora irrelevante porque no se usa esa vía).
const SUPPORTED_IMAGE_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/**
 * DEFECTO REAL (job b7c0c8ac, 01-nov-2026): el candidato #1868496 vino
 * declarado como `image/jpeg` (por la cabecera HTTP que mandó el CDN)
 * pero el archivo real era un PNG -- Anthropic lo rechazó con HTTP 400
 * ("the image appears to be a image/png image"). Ni la cabecera
 * Content-Type ni la extensión de la URL son confiables (un CDN puede
 * mentir en cualquiera de las dos); el tipo real se determina por la
 * FIRMA DE BYTES del archivo descargado, que nunca miente. Devuelve
 * `null` si no reconoce ninguna firma soportada -- eso es, a propósito,
 * un fallo técnico (nunca se adivina un tipo).
 */
export const detectImageContentTypeFromBytes = (buffer) => {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }
  if (buffer.length >= 6 && buffer.toString("latin1", 0, 3) === "GIF" && buffer[3] === 0x38 && (buffer[4] === 0x37 || buffer[4] === 0x39) && buffer[5] === 0x61) {
    return "image/gif";
  }
  if (buffer.length >= 12 && buffer.toString("latin1", 0, 4) === "RIFF" && buffer.toString("latin1", 8, 12) === "WEBP") {
    return "image/webp";
  }
  return null;
};

/**
 * La miniatura a evaluar visualmente -- NUNCA la imagen/video completo.
 * Para imagen: `webformatURL` (<=640px), nunca `previewURL` (<=150px):
 * la documentación de Claude advierte que la precisión cae en
 * imágenes de menos de 200px, y 150px queda por debajo de ese umbral.
 * Para video: el campo `thumbnail` dentro del tamaño más chico
 * disponible de `videos` (confirmado en la documentación oficial de
 * Pixabay con un ejemplo de respuesta literal el 01-nov-2026; el log
 * de diagnóstico de `searchPixabay` de arriba confirma esto contra una
 * respuesta real la primera vez que corra un job con un broll).
 */
export const pickThumbnailUrl = (hit, mediaType) => {
  if (mediaType === "video") {
    return (
      hit.videos?.tiny?.thumbnail ??
      hit.videos?.small?.thumbnail ??
      hit.videos?.medium?.thumbnail ??
      hit.videos?.large?.thumbnail ??
      null
    );
  }
  return hit.webformatURL ?? null;
};

const realDownloadBytes = async (url) => {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} al descargar la miniatura`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  // El tipo se determina por la firma de bytes del archivo real, NUNCA
  // por la cabecera Content-Type ni por la extensión de la URL -- ver
  // el comentario grande de detectImageContentTypeFromBytes arriba.
  const contentType = detectImageContentTypeFromBytes(buffer);
  return { buffer, contentType };
};
let downloadBytes = realDownloadBytes;
/** Solo para pruebas: nunca descarga nada real. */
export const __setDownloadBytesForTesting = (fn) => {
  downloadBytes = fn ?? realDownloadBytes;
};

const buildVisualPrompt = (query) =>
  `Consulta: "${query}"

¿Esta imagen muestra realmente lo que pide la consulta? Si tenés cualquier duda, respondé que no -- es preferible rechazar a aprobar algo dudoso. No evalúes calidad fotográfica ni composición, solo si el sujeto real corresponde a la consulta.

Responde ÚNICAMENTE con un objeto JSON, sin texto antes ni después, sin bloque de código:
{"aprobado": true|false, "motivo": "una frase breve, en español"}`;

const parseVisualResponse = (rawText) => {
  const cleaned = (rawText ?? "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();

  const tryParse = (candidate) => {
    try {
      return JSON.parse(candidate);
    } catch {
      return undefined;
    }
  };

  let parsed = tryParse(cleaned);
  if (!parsed) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) parsed = tryParse(match[0]);
  }
  if (!parsed) {
    throw new Error(
      cleaned.length === 0
        ? "el validador visual devolvió una respuesta de texto VACÍA (sin ningún bloque de texto utilizable)."
        : `el validador visual no devolvió JSON válido: "${cleaned.slice(0, 200)}"`,
    );
  }
  if (typeof parsed.aprobado !== "boolean") {
    throw new Error("el validador visual no dio un valor booleano en 'aprobado'.");
  }
  if (typeof parsed.motivo !== "string" || parsed.motivo.trim().length === 0) {
    throw new Error("el validador visual no dio un motivo.");
  }
  return { aprobado: parsed.aprobado, motivo: parsed.motivo.trim() };
};

/**
 * Evalúa UN candidato visualmente: descarga su miniatura real (nunca
 * la imagen/video completo) y le pregunta a Claude (con la miniatura
 * en base64, nunca por URL -- ver decisión arriba) si corresponde de
 * verdad a la consulta. Nunca envía las etiquetas -- el objetivo es
 * que el modelo juzgue los píxeles, no que repita el razonamiento de
 * la Capa B. Igual que la Capa B, cualquier fallo de parseo lleva
 * `.usage` adjunto (para contar el costo del intento fallido) y un
 * diagnóstico (stop_reason, tipos de bloque, tokens) -- nunca claves.
 */
const realEvaluateCandidateVisually = async ({ query, hit, mediaType }) => {
  const thumbnailUrl = pickThumbnailUrl(hit, mediaType);
  if (!thumbnailUrl) {
    throw new Error(`no hay miniatura utilizable para el candidato #${hit.id} (el campo esperado no vino en la respuesta de Pixabay).`);
  }
  let image;
  try {
    image = await downloadBytes(thumbnailUrl);
  } catch (err) {
    throw new Error(`no se pudo descargar la miniatura del candidato #${hit.id} (${thumbnailUrl}): ${err.message ?? err}`);
  }
  if (!image.contentType || !SUPPORTED_IMAGE_CONTENT_TYPES.has(image.contentType)) {
    throw new Error(
      image.contentType
        ? `la miniatura del candidato #${hit.id} es un formato no soportado por Anthropic ("${image.contentType}", detectado por la firma de bytes real del archivo).`
        : `la miniatura del candidato #${hit.id} no tiene una firma de bytes reconocible como JPEG/PNG/GIF/WebP -- no se puede determinar su tipo real con confianza.`,
    );
  }

  const client = getClient();
  const response = await client.messages.create({
    model: RELEVANCE_MODEL,
    max_tokens: VISUAL_MAX_OUTPUT_TOKENS,
    thinking: { type: "disabled" },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: image.contentType, data: image.buffer.toString("base64") } },
          { type: "text", text: buildVisualPrompt(query) },
        ],
      },
    ],
  });
  const usage = response.usage ?? { input_tokens: 0, output_tokens: 0 };
  const contentBlocks = response.content ?? [];
  const text = contentBlocks
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
  try {
    const { aprobado, motivo } = parseVisualResponse(text);
    return { aprobado, motivo, usage, thumbnailUrl };
  } catch (err) {
    const blockTypes = contentBlocks.map((b) => b.type).join(", ") || "ninguno";
    const diagnosed = new Error(
      `${err.message} -- diagnóstico: stop_reason="${response.stop_reason ?? "desconocido"}", bloques de contenido=[${blockTypes}], tokens=${usage.input_tokens ?? 0} entrada / ${usage.output_tokens ?? 0} salida.`,
    );
    diagnosed.usage = usage;
    throw diagnosed;
  }
};
let evaluateCandidateVisually = realEvaluateCandidateVisually;
/** Solo para pruebas: nunca llama a la API real de Anthropic ni descarga nada. */
export const __setVisualValidatorForTesting = (fn) => {
  evaluateCandidateVisually = fn ?? realEvaluateCandidateVisually;
};

/** Mismo criterio de reintento que la Capa B, para la Capa C. */
const evaluateCandidateVisuallyWithRetry = async ({ query, hit, mediaType, resourceId, log }) => {
  let lastErr;
  let spentOnFailedAttemptsUsd = 0;
  for (let attempt = 1; attempt <= VISUAL_MAX_ATTEMPTS; attempt++) {
    try {
      return await evaluateCandidateVisually({ query, hit, mediaType });
    } catch (err) {
      lastErr = err;
      const attemptCostUsd = computeRelevanceCallCostUsd(err.usage);
      spentOnFailedAttemptsUsd += attemptCostUsd;
      log(
        `Pixabay: Capa C -- intento ${attempt}/${VISUAL_MAX_ATTEMPTS} para "${resourceId}" candidato #${hit.id} falló (${err.message}) -- costo de ese intento: $${attemptCostUsd.toFixed(6)}.` +
          (attempt < VISUAL_MAX_ATTEMPTS ? " Reintentando una vez." : ""),
      );
    }
  }
  lastErr.spentOnFailedAttemptsUsd = spentOnFailedAttemptsUsd;
  throw lastErr;
};

/**
 * Capa C completa para un recurso: evalúa visualmente, en orden de
 * puntaje de la Capa A, empezando por el candidato que la Capa B
 * aprobó -- hasta VISUAL_MAX_EVALUATIONS candidatos en total. Se
 * detiene en el primero que la IA apruebe visualmente. Devuelve
 * `{approved, attempts}` -- `approved` es el finalista aprobado (o
 * `null` si ninguno lo fue), `attempts` es la lista de intentos (para
 * el log y el motivo de rechazo final).
 */
const runVisualValidation = async ({ query, finalists, chosenIdFromCapaB, mediaType, resourceId, log }) => {
  const chosenFinalist = finalists.find((f) => f.hit.id === chosenIdFromCapaB);
  const ordered = [chosenFinalist, ...finalists.filter((f) => f.hit.id !== chosenIdFromCapaB)].slice(0, VISUAL_MAX_EVALUATIONS);

  const attempts = [];
  for (const candidate of ordered) {
    let result;
    try {
      result = await evaluateCandidateVisuallyWithRetry({ query, hit: candidate.hit, mediaType, resourceId, log });
    } catch (err) {
      const spentUsd = err.spentOnFailedAttemptsUsd ?? 0;
      log(`Pixabay: Capa C -- candidato #${candidate.hit.id} para "${resourceId}" quedó sin validar tras un fallo técnico (${err.message}) -- costo gastado en los intentos: $${spentUsd.toFixed(6)}.`);
      attempts.push({ hit: candidate.hit, aprobado: false, motivo: `fallo técnico: ${err.message ?? err}`, isCapaBChoice: candidate.hit.id === chosenIdFromCapaB });
      continue;
    }
    const costUsd = computeRelevanceCallCostUsd(result.usage);
    log(
      `Pixabay: Capa C (${RELEVANCE_MODEL}) para "${resourceId}" -- candidato #${candidate.hit.id} -- miniatura: ${result.thumbnailUrl} -- página: ${candidate.hit.pageURL} -- ` +
        `veredicto: ${result.aprobado ? "APROBADO" : "rechazado"} -- motivo: "${result.motivo}" -- tokens: ${result.usage.input_tokens ?? 0} entrada / ${result.usage.output_tokens ?? 0} salida -- costo real: $${costUsd.toFixed(6)}.`,
    );
    attempts.push({ hit: candidate.hit, aprobado: result.aprobado, motivo: result.motivo, isCapaBChoice: candidate.hit.id === chosenIdFromCapaB });
    if (result.aprobado) {
      return { approved: candidate, approvedMotivo: result.motivo, attempts };
    }
  }
  return { approved: null, approvedMotivo: null, attempts };
};

/**
 * Resuelve UN recurso `broll`/`image` contra Pixabay: busca (con
 * caché), filtra finalistas por palabras clave (Capa A), valida el
 * sujeto real con IA sobre esos finalistas (Capa B, solo texto),
 * confirma con la miniatura REAL (Capa C, visual, sobre el elegido de
 * la Capa B y -- si lo rechaza -- los demás finalistas en orden de
 * puntaje), descarga SOLO el archivo finalmente aprobado, y arma el
 * registro de licencia. Si ya tenía `resolvedAsset` o
 * `acquisitionFailureReason` de una corrida anterior, no vuelve a
 * tocar nada (idempotente).
 */
export const resolveOneResource = async ({ resource, apiKey, cacheDir, assetsDir, jobId, lang = "es", log = () => {} }) => {
  if (resource.resolvedAsset || resource.acquisitionFailureReason) {
    log(`Pixabay: recurso "${resource.id}" ya estaba resuelto de una corrida anterior (${resource.resolvedAsset ? `asset #${resource.resolvedAsset.assetId}` : "descartado"}) -- no se vuelve a consultar.`);
    return resource;
  }
  if (!resource.visualQuery || resource.visualQuery.trim().length === 0) {
    log(`Pixabay: recurso "${resource.id}" (${resource.type}) sin "visualQuery" -- se descarta sin buscar.`);
    return {
      ...resource,
      acquisitionFailureReason: `recurso "${resource.type}" sin "visualQuery" -- el planificador no dio una consulta visual concreta para buscar.`,
    };
  }

  const query = resource.visualQuery;
  const mediaType = resource.type === "broll" ? "video" : "image";
  const hits = await searchPixabay({ apiKey, query, mediaType, lang, cacheDir, log });
  const ranked = rankCandidates(hits, query);
  const finalists = filterFinalists(ranked);

  if (finalists.length === 0) {
    const reason =
      `ningún candidato de Pixabay alcanzó el umbral de relevancia por palabras clave para "${query}" ` +
      `(mínimo ${MIN_ABSOLUTE_OVERLAP} coincidencias y ${Math.round(MIN_COVERAGE_RATIO * 100)}% de cobertura; ` +
      `${hits.length} candidato(s) evaluado(s): ${describeRankedForLog(ranked)}).`;
    log(`Pixabay: RECHAZADO (capa A) recurso "${resource.id}" -- ${reason}`);
    return { ...resource, acquisitionFailureReason: reason };
  }

  log(
    `Pixabay: finalistas de "${resource.id}" para la Capa B (${finalists.length} de ${hits.length}): ` +
      finalists.map((f) => `#${f.hit.id} etiquetas="${dedupeTagsString(f.hit.tags)}" (coincidieron: ${matchedTokens(query, f.hit.tags).join(", ") || "ninguna"})`).join(" | ") +
      ".",
  );

  let verdict;
  try {
    verdict = await validateRelevanceWithRetry({ query, finalists, resourceId: resource.id, log });
  } catch (err) {
    const spentUsd = err.spentOnFailedAttemptsUsd ?? 0;
    const reason =
      `la validación de relevancia con IA falló tras ${RELEVANCE_MAX_ATTEMPTS} intento(s) (${err.message ?? err}) -- ` +
      `costo gastado en los intentos fallidos: $${spentUsd.toFixed(6)} -- se conserva el presentador en pantalla en vez de insertar un recurso sin validar.`;
    log(`Pixabay: RECHAZADO (capa B, error) recurso "${resource.id}" -- ${reason}`);
    return { ...resource, acquisitionFailureReason: reason };
  }

  const costUsd = computeRelevanceCallCostUsd(verdict.usage);
  log(
    `Pixabay: Capa B (${RELEVANCE_MODEL}) para "${resource.id}" -- veredicto: ${verdict.chosenId === null ? "NINGUNO sirve" : `candidato #${verdict.chosenId}`} ` +
      `-- motivo del modelo: "${verdict.reason}" -- tokens: ${verdict.usage.input_tokens ?? 0} entrada / ${verdict.usage.output_tokens ?? 0} salida -- costo real: $${costUsd.toFixed(6)}.`,
  );

  if (verdict.chosenId === null) {
    const reason = `la Capa B (validación con IA sobre etiquetas, sin imágenes) determinó que ningún finalista corresponde al sujeto de "${query}": ${verdict.reason}`;
    log(`Pixabay: RECHAZADO (capa B) recurso "${resource.id}" -- ${reason}`);
    return { ...resource, acquisitionFailureReason: reason };
  }

  const { approved, approvedMotivo, attempts } = await runVisualValidation({
    query,
    finalists,
    chosenIdFromCapaB: verdict.chosenId,
    mediaType,
    resourceId: resource.id,
    log,
  });

  if (!approved) {
    const motivos = attempts.map((a) => `#${a.hit.id}: ${a.motivo}`).join(" | ");
    const reason =
      `la Capa C (validación visual sobre la miniatura real, nunca solo etiquetas) rechazó ${attempts.length} candidato(s) para "${query}" -- ${motivos} ` +
      `-- se conserva el presentador en pantalla en vez de insertar un B-roll/imagen equivocado.`;
    log(`Pixabay: RECHAZADO (capa C) recurso "${resource.id}" -- ${reason}`);
    return { ...resource, acquisitionFailureReason: reason };
  }

  const { hit, score, coverage } = approved;
  const sourceUrl = mediaType === "video" ? pickVideoUrl(hit) : pickImageUrl(hit);
  if (!sourceUrl) {
    const reason = `la Capa C aprobó visualmente el candidato #${hit.id} para "${query}" pero Pixabay no le dio una URL de descarga utilizable.`;
    log(`Pixabay: RECHAZADO recurso "${resource.id}" -- ${reason}`);
    return { ...resource, acquisitionFailureReason: reason };
  }

  const ext = extensionFor(sourceUrl, mediaType === "video" ? "mp4" : "jpg");
  // `relativePath` es lo que se guarda en el job (consumible por
  // `staticFile()`, relativo a `public/`); `destPath` es la ruta real en
  // disco donde se escribe el archivo -- `assetsDir` ya apunta a
  // `.../public/uploads/resources` (ver index.mjs), así que ambas
  // describen el mismo archivo.
  const relativePath = `uploads/resources/${jobId}/${resource.id}.${ext}`;
  const destPath = path.join(assetsDir, jobId, `${resource.id}.${ext}`);

  const alreadyOnDisk = fs.existsSync(destPath);
  if (!alreadyOnDisk) {
    try {
      await downloadToFile(sourceUrl, destPath);
    } catch (err) {
      const reason = `la Capa C aprobó visualmente el candidato #${hit.id} (score=${score}) para "${query}" pero falló la descarga (${err.message ?? err}).`;
      log(`Pixabay: RECHAZADO recurso "${resource.id}" -- ${reason}`);
      return { ...resource, acquisitionFailureReason: reason };
    }
  }

  const mediaTypeFinal = mediaType === "video" ? "video" : hit.type === "illustration" ? "illustration" : "photo";
  const licenseName = "Pixabay Content License";
  const attributionRequired = false;
  const capaBDescripcion =
    hit.id === verdict.chosenId
      ? `capa B: "${verdict.reason}"`
      : `capa B había aprobado otro candidato (#${verdict.chosenId}) que la Capa C rechazó -- este no pasó por la Capa B`;
  log(
    `Pixabay: ELEGIDO recurso "${resource.id}" -> candidato #${hit.id} (capa A: score=${score}, cobertura=${(coverage * 100).toFixed(0)}%; ${capaBDescripcion}; capa C: "${approvedMotivo}") ` +
      `-- etiquetas="${dedupeTagsString(hit.tags)}", autor "${hit.user}", tipo ${mediaTypeFinal}, licencia "${licenseName}" (${PIXABAY_LICENSE_URL}, atribución ${attributionRequired ? "obligatoria" : "no obligatoria"}), ` +
      `página ${hit.pageURL}, ${alreadyOnDisk ? "ya estaba en disco" : "descargado ahora"} -> ${relativePath}.`,
  );

  return {
    ...resource,
    resolvedAsset: {
      provider: "pixabay",
      assetId: hit.id,
      pageUrl: hit.pageURL,
      localPath: relativePath,
      mediaType: mediaTypeFinal,
      author: hit.user,
      licenseName,
      licenseUrl: PIXABAY_LICENSE_URL,
      attributionRequired,
      downloadedAt: new Date().toISOString(),
    },
  };
};

/**
 * Resuelve TODOS los recursos `broll`/`image` de un job contra Pixabay
 * -- el resto de los recursos (graphic/CTA/text-highlight/etc.) pasan
 * sin tocar. Nunca lanza por un fallo individual: cada recurso que no
 * se pudo resolver queda con `acquisitionFailureReason`, el resto sigue.
 */
export const acquireResourcesForJob = async ({ resources, apiKey, cacheDir, assetsDir, jobId, lang = "es", log = () => {} }) => {
  const updated = [];
  const issues = [];
  for (const resource of resources ?? []) {
    if (resource.type !== "broll" && resource.type !== "image") {
      updated.push(resource);
      continue;
    }
    const resolved = await resolveOneResource({ resource, apiKey, cacheDir, assetsDir, jobId, lang, log });
    updated.push(resolved);
    if (resolved.acquisitionFailureReason) {
      issues.push(`recurso "${resolved.id}" (${resolved.type}): ${resolved.acquisitionFailureReason}`);
    }
  }
  return { resources: updated, issues };
};
