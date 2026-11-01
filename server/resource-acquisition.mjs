// Fase 3B (31-oct-2026, dictamen "integración mínima de imágenes y
// B-roll"): resuelve recursos `broll`/`image` que el planificador ya
// decidió (tipo, intervalo, `visualQuery`) contra Pixabay -- la IA
// editorial sigue decidiendo QUÉ/CUÁNDO/CUÁNTO DURA; este módulo solo
// responde DÓNDE conseguir el archivo, legalmente, con su licencia
// registrada. Nunca decide relevancia editorial por su cuenta más allá
// de un filtro de palabras clave (sin IA, pedido explícito del dictamen).
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

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

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
const MIN_KEYWORD_OVERLAP = 1; // sin IA -- el criterio de relevancia es puramente léxico

// Palabras demasiado comunes para decir algo sobre relevancia visual --
// ni exhaustivo ni delicado, solo evita que "de"/"the"/"con" cuenten
// como una coincidencia real entre la consulta y las etiquetas de Pixabay.
const STOPWORDS = new Set([
  "de", "la", "el", "los", "las", "un", "una", "unos", "unas", "y", "o", "en", "con", "para", "por", "del", "al",
  "a", "que", "su", "sus", "the", "a", "an", "of", "in", "on", "with", "for", "and", "or", "to",
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

/**
 * Comprobación de relevancia por PALABRAS CLAVE, sin llamar a ningún
 * modelo (pedido explícito del dictamen) -- cuenta cuántos tokens de la
 * consulta aparecen en las etiquetas que Pixabay ya le puso al
 * archivo. Es menos preciso que una verificación semántica; es
 * intencional (ver informe de entrega: evidencia + alternativa con IA
 * y su costo, antes de implementarla).
 */
export const scoreKeywordOverlap = (query, tagsString) => {
  const queryTokens = tokenize(query);
  const tagTokens = tokenize((tagsString ?? "").replace(/,/g, " "));
  let overlap = 0;
  for (const t of queryTokens) {
    if (tagTokens.has(t)) overlap += 1;
  }
  return overlap;
};

/** De una lista de resultados de Pixabay, el de mejor coincidencia léxica -- null si ninguno llega al mínimo. */
export const pickBestHit = (hits, query, minOverlap = MIN_KEYWORD_OVERLAP) => {
  let best = null;
  let bestScore = 0;
  for (const hit of hits ?? []) {
    const score = scoreKeywordOverlap(query, hit.tags);
    if (score > bestScore) {
      bestScore = score;
      best = hit;
    }
  }
  return bestScore >= minOverlap ? { hit: best, score: bestScore } : null;
};

/**
 * Describe cada candidato de una búsqueda (id + puntaje de coincidencia
 * léxica contra la consulta) para el log -- pedido explícito de Alex
 * (01-nov-2026): el log debe mostrar "los candidatos", no solo cuántos
 * hubo. Nunca incluye nada de la clave de la API.
 */
const describeHitsForLog = (hits, query) =>
  (hits ?? [])
    .map((hit) => `#${hit.id}(score=${scoreKeywordOverlap(query, hit.tags)})`)
    .join(", ") || "ninguno";

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
    log(`Pixabay (${mediaType}): "${query}" -- resultado en caché (sin llamar a la API) -- candidatos: ${describeHitsForLog(cached, query)}.`);
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
  log(`Pixabay (${mediaType}): "${query}" -- ${hits.length} candidato(s), cacheados por 24h -- candidatos: ${describeHitsForLog(hits, query)}.`);
  return hits;
};

const pickImageUrl = (hit) => hit.largeImageURL ?? hit.webformatURL;
const pickVideoUrl = (hit) => hit.videos?.large?.url ?? hit.videos?.medium?.url ?? hit.videos?.small?.url;

const extensionFor = (url, fallback) => {
  const match = /\.([a-zA-Z0-9]+)(?:\?|$)/.exec(url ?? "");
  return match ? match[1] : fallback;
};

/**
 * Resuelve UN recurso `broll`/`image` contra Pixabay: busca (con
 * caché), elige el mejor candidato por palabras clave, descarga SOLO
 * ese archivo y arma el registro de licencia. Si ya tenía
 * `resolvedAsset` o `acquisitionFailureReason` de una corrida anterior,
 * no vuelve a tocar nada (idempotente -- evita re-consultar en cada
 * replan de un job que no cambió).
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

  const mediaType = resource.type === "broll" ? "video" : "image";
  const hits = await searchPixabay({ apiKey, query: resource.visualQuery, mediaType, lang, cacheDir, log });
  const best = pickBestHit(hits, resource.visualQuery);

  if (!best) {
    const reason = `no se encontró en Pixabay un resultado con buena coincidencia de palabras clave para "${resource.visualQuery}" (${hits.length} candidato(s) evaluado(s): ${describeHitsForLog(hits, resource.visualQuery)}).`;
    log(`Pixabay: RECHAZADO recurso "${resource.id}" -- ${reason}`);
    return { ...resource, acquisitionFailureReason: reason };
  }

  const { hit, score } = best;
  const sourceUrl = mediaType === "video" ? pickVideoUrl(hit) : pickImageUrl(hit);
  if (!sourceUrl) {
    const reason = `Pixabay devolvió el candidato #${hit.id} para "${resource.visualQuery}" sin una URL de descarga utilizable.`;
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
      const reason = `se eligió el candidato #${hit.id} (score=${score}) para "${resource.visualQuery}" pero falló la descarga (${err.message ?? err}).`;
      log(`Pixabay: RECHAZADO recurso "${resource.id}" -- ${reason}`);
      return { ...resource, acquisitionFailureReason: reason };
    }
  }

  const mediaTypeFinal = mediaType === "video" ? "video" : hit.type === "illustration" ? "illustration" : "photo";
  const licenseName = "Pixabay Content License";
  const attributionRequired = false;
  log(
    `Pixabay: ELEGIDO recurso "${resource.id}" -> candidato #${hit.id} (score=${score} de ${hits.length} evaluado(s): ${describeHitsForLog(hits, resource.visualQuery)}) ` +
      `-- autor "${hit.user}", tipo ${mediaTypeFinal}, licencia "${licenseName}" (${PIXABAY_LICENSE_URL}, atribución ${attributionRequired ? "obligatoria" : "no obligatoria"}), ` +
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
