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
// RELEVANCIA, en dos capas (corrección del 01-nov-2026, tras un
// incidente real: "persona corriendo en un parque" eligió un cachorro
// porque "parque" coincidía; una consulta sin sentido eligió un
// candidato porque "sin" coincidía con la etiqueta "sin fondo"):
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
//   NUNCA una verificación visual de la imagen real. Si las etiquetas
//   de Pixabay fueran insuficientes o engañosas, la Capa B puede
//   fallar igual -- eso se reporta como tal, nunca como "verificado
//   visualmente".

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
// 200 tokens de salida era insuficiente margen; se sube a 1024 --
// el costo real no sube con esto, porque se cobra por lo que el
// modelo efectivamente genera, no por el tope. No se pide "thinking"
// (razonamiento extendido) en ningún parámetro -- está apagado por
// default en la API de Mensajes; si alguna vez apareciera un bloque de
// ese tipo, los diagnósticos de abajo lo mostrarían en vez de fallar
// en silencio.
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

/**
 * Resuelve UN recurso `broll`/`image` contra Pixabay: busca (con
 * caché), filtra finalistas por palabras clave (Capa A), valida el
 * sujeto real con IA sobre esos finalistas (Capa B, solo texto),
 * descarga SOLO el archivo que la IA eligió, y arma el registro de
 * licencia. Si ya tenía `resolvedAsset` o `acquisitionFailureReason` de
 * una corrida anterior, no vuelve a tocar nada (idempotente).
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

  const chosen = finalists.find((f) => f.hit.id === verdict.chosenId);
  const { hit, score, coverage } = chosen;
  const sourceUrl = mediaType === "video" ? pickVideoUrl(hit) : pickImageUrl(hit);
  if (!sourceUrl) {
    const reason = `la Capa B eligió el candidato #${hit.id} para "${query}" pero Pixabay no le dio una URL de descarga utilizable.`;
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
      const reason = `la Capa B eligió el candidato #${hit.id} (score=${score}) para "${query}" pero falló la descarga (${err.message ?? err}).`;
      log(`Pixabay: RECHAZADO recurso "${resource.id}" -- ${reason}`);
      return { ...resource, acquisitionFailureReason: reason };
    }
  }

  const mediaTypeFinal = mediaType === "video" ? "video" : hit.type === "illustration" ? "illustration" : "photo";
  const licenseName = "Pixabay Content License";
  const attributionRequired = false;
  log(
    `Pixabay: ELEGIDO recurso "${resource.id}" -> candidato #${hit.id} (capa A: score=${score}, cobertura=${(coverage * 100).toFixed(0)}%; capa B: "${verdict.reason}") ` +
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
