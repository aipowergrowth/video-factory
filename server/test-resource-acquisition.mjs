// PRUEBA SIMULADA -- nunca llama a la red real de Pixabay NI a la API
// real de Anthropic (misma disciplina que el resto de las pruebas de
// este proyecto: inyecta __setFetchJsonForTesting/
// __setDownloadToFileForTesting/__setRelevanceValidatorForTesting/
// __setVisualValidatorForTesting/__setDownloadBytesForTesting en vez de
// golpear una API real). Prueba la lógica PURA (tokenize,
// scoreKeywordOverlap, rankCandidates, filterFinalists,
// pickThumbnailUrl) y el CONTROL DE FLUJO de las tres capas de
// relevancia (Capa A por palabras clave, Capa B por IA sobre texto/
// etiquetas, Capa C por IA sobre la miniatura REAL) de
// server/resource-acquisition.mjs -- incluidos los tres casos reales
// que Alex reportó el 01-nov-2026, el caso límite del cachorro con
// etiquetas coincidentes, el incidente real del caso positivo
// (respuesta vacía de la Capa B), y el defecto real que motivó la Capa
// C (la Capa B aprobó por etiquetas un candidato cuya foto real era
// otra cosa).
//
// IMPORTANTE (criterio explícito de Alex, 01-nov-2026): estas pruebas
// con cliente/validador simulado verifican el CABLEADO -- que se
// llama a quien corresponde, con los datos correctos, en el orden
// correcto, y que los fallos se manejan bien -- pero NO son el
// criterio de aceptación de la Capa C. Eso es una corrida real contra
// Pixabay y Anthropic reales (ver el informe de entrega).
//
// Para reproducir el incidente de la respuesta vacía SIN mockear el
// SDK de Anthropic a mano, se usa __setAnthropicClientForTesting --
// el mismo gancho que ya existe en editorial.mjs -- para inyectar un
// cliente falso cuyo `messages.create` devuelve exactamente la forma
// de respuesta problemática. getClient() (compartido, ver
// resource-acquisition.mjs) devuelve ese cliente falso sin tocar la
// red ni leer ninguna clave real.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  tokenize,
  matchedTokens,
  scoreKeywordOverlap,
  rankCandidates,
  filterFinalists,
  dedupeTagsString,
  computeRelevanceCallCostUsd,
  RELEVANCE_MODEL_INPUT_PRICE_PER_TOKEN,
  RELEVANCE_MODEL_OUTPUT_PRICE_PER_TOKEN,
  pickThumbnailUrl,
  detectImageContentTypeFromBytes,
  searchPixabay,
  resolveOneResource,
  acquireResourcesForJob,
  __setFetchJsonForTesting,
  __setDownloadToFileForTesting,
  __setRelevanceValidatorForTesting,
  __setVisualValidatorForTesting,
  __setDownloadBytesForTesting,
} from "./resource-acquisition.mjs";
import { __setAnthropicClientForTesting } from "./editorial.mjs";

let failures = 0;
const check = (label, cond, detail = "") => {
  if (!cond) {
    failures++;
    console.log(`FAIL: ${label}${detail ? ` -- ${detail}` : ""}`);
  } else {
    console.log(`ok: ${label}`);
  }
};

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vf-resource-acquisition-"));
const cacheDir = path.join(tmpDir, "cache");
const assetsDir = path.join(tmpDir, "assets");

/** Validador falso (Capa B) que siempre elige el mejor finalista (el primero, ya vienen ordenados). */
const acceptBestFinalist = async ({ finalists }) => ({
  chosenId: finalists[0]?.hit.id ?? null,
  reason: "simulado: coincide con el sujeto de la consulta",
  usage: { input_tokens: 120, output_tokens: 18 },
});

/** Validador falso (Capa C) que aprueba visualmente cualquier candidato que le llegue. */
const acceptVisually = async ({ hit }) => ({
  aprobado: true,
  motivo: "simulado: la miniatura muestra el sujeto correcto",
  usage: { input_tokens: 350, output_tokens: 20 },
  thumbnailUrl: `https://cdn.example/miniatura-${hit.id}.jpg`,
});

// --- tokenize / scoreKeywordOverlap / matchedTokens ---

check("tokenize: quita stopwords y acentos", [...tokenize("una ilustración de la molécula")].sort().join(",") === "ilustracion,molecula");
check("tokenize: 'sin' es una palabra vacía (corrección 01-nov-2026)", !tokenize("xyzzy inexistente consulta sin sentido 12345").has("sin"));
check("tokenize: conserva las palabras significativas de una consulta sin sentido", [...tokenize("xyzzy inexistente consulta sin sentido 12345")].sort().join(",") === "12345,consulta,inexistente,sentido,xyzzy");
check("scoreKeywordOverlap: sin ninguna coincidencia da 0", scoreKeywordOverlap("gato jugando", "car, engine, factory") === 0);
check("scoreKeywordOverlap: con coincidencia da >0", scoreKeywordOverlap("laboratorio de neurociencia", "laboratorio, ciencia, microscopio") > 0);
check("matchedTokens: devuelve las palabras que de verdad coincidieron, no solo el número", matchedTokens("persona corriendo al amanecer en un parque", "cachorro, animal, parque").join(",") === "parque");

// --- dedupeTagsString (corrección 01-nov-2026: etiquetas repetidas no deben inflar el prompt/log) ---

check("dedupeTagsString: quita duplicados exactos sin importar mayúsculas/espacios", dedupeTagsString("iPhone, iphone , OFICINA, oficina, escritorio") === "iPhone, OFICINA, escritorio");
check("dedupeTagsString: conserva el orden de la primera aparición", dedupeTagsString("b, a, b, a, c") === "b, a, c");
check("dedupeTagsString: vacío o undefined da cadena vacía", dedupeTagsString(undefined) === "" && dedupeTagsString("") === "");

// --- rankCandidates / filterFinalists (Capa A) ---

{
  const hits = [
    { id: 1, tags: "coche, carretera, viaje" },
    { id: 2, tags: "laboratorio, neurociencia, microscopio" },
    { id: 3, tags: "comida, cocina, receta" },
  ];
  const ranked = rankCandidates(hits, "laboratorio de neurociencia");
  check("rankCandidates: ordena de mayor a menor coincidencia", ranked[0].hit.id === 2);
  check("rankCandidates: calcula la cobertura relativa a la consulta", ranked[0].coverage === 1);
}

check("filterFinalists: lista vacía no da finalistas", filterFinalists(rankCandidates([], "cualquier cosa")).length === 0);

{
  // CASO REAL 1 (reporte de Alex, 01-nov-2026): "persona corriendo al
  // amanecer en un parque" eligió un cachorro porque coincidía "parque"
  // -- un solo término de los cuatro significativos (25% de cobertura,
  // score=1). Con los nuevos umbrales (>=2 absoluto Y >=50% cobertura)
  // ni siquiera llega a finalista -- rechazado en la Capa A, SIN
  // gastar ninguna llamada a IA.
  const ranked = rankCandidates(
    [{ id: 8637542, tags: "cachorro, animal, mascota, parque" }],
    "persona corriendo al amanecer en un parque",
  );
  const finalists = filterFinalists(ranked);
  check("Capa A (caso real 1, cachorro): score=1 de 4 términos, NO llega a finalista", finalists.length === 0 && ranked[0].score === 1);
}

{
  // CASO REAL 2: consulta sin sentido "xyzzy inexistente consulta sin
  // sentido 12345" eligió un signo de interrogación -- con "sin" ya
  // como palabra vacía, y sin que ninguna palabra real de la consulta
  // aparezca en esas etiquetas, el score debe ser 0.
  const ranked = rankCandidates(
    [{ id: 1872665, tags: "signo, interrogacion, pregunta, duda, icono" }],
    "xyzzy inexistente consulta sin sentido 12345",
  );
  const finalists = filterFinalists(ranked);
  check("Capa A (caso real 2, sin sentido): score=0, NO llega a finalista", finalists.length === 0 && ranked[0].score === 0);
}

{
  // CASO REAL 3: "ilustración 3D de una molécula de dopamina en el
  // cerebro" (broll/video) -- los 5 candidatos reales sacaron 0 o 1 de
  // 4 términos significativos (ilustracion, molecula, dopamina,
  // cerebro). Ninguno debe llegar a finalista.
  const ranked = rankCandidates(
    [
      { id: 37422, tags: "ciencia, abstracto, animacion" },
      { id: 2, tags: "ilustracion, arte, diseno" },
      { id: 3, tags: "medicina, salud" },
      { id: 4, tags: "fondo, abstracto" },
      { id: 5, tags: "tecnologia, futuro" },
    ],
    "ilustración 3D de una molécula de dopamina en el cerebro",
  );
  check("Capa A (caso real 3, dopamina/video): ningún candidato llega a finalista", filterFinalists(ranked).length === 0);
}

{
  // CASO LÍMITE (pedido explícito de Alex): un candidato que cubre
  // TODAS las palabras significativas de la consulta -- pasaría la
  // Capa A sin problema -- pero es un cachorro, no una persona. Esto
  // demuestra el límite real de la Capa A sola (ver comentario grande
  // al inicio de resource-acquisition.mjs) y por qué hace falta la
  // Capa B.
  const ranked = rankCandidates(
    [{ id: 999, tags: "cachorro, perro, persona, corriendo, amanecer, parque" }],
    "persona corriendo al amanecer en un parque",
  );
  const finalists = filterFinalists(ranked);
  check("Capa A (caso límite): con etiquetas que cubren TODA la consulta, SÍ llega a finalista (score=4, cobertura=100%)", finalists.length === 1 && finalists[0].score === 4 && finalists[0].coverage === 1);
}

// --- pickThumbnailUrl (Capa C: qué miniatura se evalúa) ---

check(
  "pickThumbnailUrl (imagen): usa webformatURL, nunca previewURL (Claude pierde precisión bajo 200px, previewURL es <=150px)",
  pickThumbnailUrl({ webformatURL: "https://cdn.example/web.jpg", previewURL: "https://cdn.example/preview.jpg" }, "image") === "https://cdn.example/web.jpg",
);
check("pickThumbnailUrl (imagen): sin webformatURL, null (nunca cae a previewURL como respaldo)", pickThumbnailUrl({ previewURL: "https://cdn.example/preview.jpg" }, "image") === null);
check(
  "pickThumbnailUrl (video): prefiere el thumbnail del tamaño más chico disponible (tiny)",
  pickThumbnailUrl({ videos: { large: { thumbnail: "L" }, tiny: { thumbnail: "T" } } }, "video") === "T",
);
check("pickThumbnailUrl (video): si falta 'tiny', sube a 'small', luego 'medium', luego 'large'", pickThumbnailUrl({ videos: { large: { thumbnail: "L" } } }, "video") === "L");
check("pickThumbnailUrl (video): sin ningún thumbnail en ningún tamaño, null", pickThumbnailUrl({ videos: { medium: { url: "solo-url-sin-thumbnail" } } }, "video") === null);

// --- detectImageContentTypeFromBytes (defecto real: #1868496 vino con
// cabecera image/jpeg pero el archivo real era PNG -- Anthropic lo
// rechazó con HTTP 400. El tipo se determina por la firma de bytes,
// nunca por la cabecera ni la extensión de la URL.) ---

check("detectImageContentTypeFromBytes: firma JPEG (FF D8 FF)", detectImageContentTypeFromBytes(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])) === "image/jpeg");
check(
  "detectImageContentTypeFromBytes: firma PNG (89 50 4E 47 0D 0A 1A 0A) -- el defecto real: esto NO es jpeg aunque la cabecera lo diga",
  detectImageContentTypeFromBytes(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])) === "image/png",
);
check("detectImageContentTypeFromBytes: firma GIF89a", detectImageContentTypeFromBytes(Buffer.from("GIF89a", "latin1")) === "image/gif");
check("detectImageContentTypeFromBytes: firma WebP (RIFF....WEBP)", detectImageContentTypeFromBytes(Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP", "latin1")])) === "image/webp");
check("detectImageContentTypeFromBytes: bytes sin firma reconocida -- null, nunca adivina", detectImageContentTypeFromBytes(Buffer.from("esto no es una imagen de ningún tipo")) === null);
check("detectImageContentTypeFromBytes: buffer vacío -- null, sin lanzar", detectImageContentTypeFromBytes(Buffer.alloc(0)) === null);

// --- computeRelevanceCallCostUsd ---

check(
  "computeRelevanceCallCostUsd: usa las tarifas reales confirmadas de Haiku 5.5",
  Math.abs(computeRelevanceCallCostUsd({ input_tokens: 1_000_000, output_tokens: 1_000_000 }) - (RELEVANCE_MODEL_INPUT_PRICE_PER_TOKEN * 1_000_000 + RELEVANCE_MODEL_OUTPUT_PRICE_PER_TOKEN * 1_000_000)) < 1e-9,
);
check("computeRelevanceCallCostUsd: sin uso, costo 0", computeRelevanceCallCostUsd(undefined) === 0);

// --- searchPixabay: caché de 24h, un solo pedido por consulta ---

{
  let calls = 0;
  __setFetchJsonForTesting(async () => {
    calls++;
    return { hits: [{ id: 42, tags: "molecula, dopamina, ciencia" }] };
  });
  const hits1 = await searchPixabay({ apiKey: "fake", query: "molécula de dopamina", mediaType: "image", cacheDir });
  const hits2 = await searchPixabay({ apiKey: "fake", query: "molécula de dopamina", mediaType: "image", cacheDir });
  check("searchPixabay: la primera búsqueda llama a la API", hits1.length === 1);
  check("searchPixabay: la segunda búsqueda IDÉNTICA usa la caché -- sin una segunda llamada", calls === 1);
  check("searchPixabay: el resultado cacheado es el mismo", hits2[0].id === 42);
  __setFetchJsonForTesting(null);
}

{
  // Un fallo de red/API (incluido un 429) nunca tumba nada -- se trata
  // como "sin resultados" para esa búsqueda puntual.
  __setFetchJsonForTesting(async () => {
    throw new Error("Pixabay respondió 429: demasiadas solicitudes");
  });
  const hits = await searchPixabay({ apiKey: "fake", query: "consulta que falla", mediaType: "image", cacheDir });
  check("searchPixabay: un fallo de red devuelve array vacío, no lanza", Array.isArray(hits) && hits.length === 0);
  __setFetchJsonForTesting(null);
}

// --- resolveOneResource: flujo completo Capa A + Capa B ---

{
  // Caso sano (POSITIVO): Capa A deja un único finalista claro, la
  // Capa B (inyectada) lo aprueba, la Capa C (inyectada) lo confirma
  // visualmente -- se descarga SOLO ese archivo, y el log trae
  // etiquetas, veredictos de ambas capas de IA, tokens y costo real.
  let searchCalls = 0;
  let downloadCalls = 0;
  let validatorCalls = 0;
  let visualCalls = 0;
  __setFetchJsonForTesting(async () => {
    searchCalls++;
    return {
      hits: [
        {
          id: 7,
          tags: "molecula, dopamina, ciencia, ilustracion",
          pageURL: "https://pixabay.com/x/7",
          largeImageURL: "https://cdn.example/7-large.jpg",
          webformatURL: "https://cdn.example/7-web.jpg",
          user: "autor-x",
          type: "illustration",
        },
        { id: 8, tags: "coche, carretera", pageURL: "https://pixabay.com/x/8", largeImageURL: "https://cdn.example/8-large.jpg", webformatURL: "https://cdn.example/8-web.jpg", user: "autor-y" },
      ],
    };
  });
  __setDownloadToFileForTesting(async () => {
    downloadCalls++;
  });
  __setRelevanceValidatorForTesting(async (args) => {
    validatorCalls++;
    return acceptBestFinalist(args);
  });
  __setVisualValidatorForTesting(async (args) => {
    visualCalls++;
    return acceptVisually(args);
  });
  const resource = { id: "ai-resource-0", type: "image", description: "prosa editorial", visualQuery: "ilustración de una molécula de dopamina" };
  const logLines = [];
  const resolved = await resolveOneResource({ resource, apiKey: "fake", cacheDir, assetsDir, jobId: "job-test", log: (m) => logLines.push(m) });
  check("resolveOneResource: resuelve con el candidato que la Capa B aprobó y la Capa C confirmó (id 7, no 8)", resolved.resolvedAsset?.assetId === 7);
  check("resolveOneResource: se descarga exactamente 1 archivo (nunca los dos candidatos)", downloadCalls === 1);
  check("resolveOneResource: solo 1 búsqueda", searchCalls === 1);
  check("resolveOneResource: la Capa B se llamó exactamente 1 vez", validatorCalls === 1);
  check("resolveOneResource: la Capa C se llamó exactamente 1 vez (el primer candidato ya fue aprobado, no cascadea)", visualCalls === 1);
  check("resolveOneResource: registra proveedor/licencia/autor/fecha", resolved.resolvedAsset?.provider === "pixabay" && resolved.resolvedAsset?.licenseName && resolved.resolvedAsset?.author === "autor-x" && resolved.resolvedAsset?.downloadedAt);
  const elegidoLine = logLines.find((l) => l.includes("ELEGIDO"));
  check("log: hay una línea 'ELEGIDO' con el recurso y el candidato elegido", elegidoLine?.includes("ai-resource-0") && elegidoLine?.includes("#7"));
  check("log: la línea ELEGIDO incluye las etiquetas del candidato elegido", elegidoLine?.includes("molecula, dopamina, ciencia, ilustracion"));
  check("log: la línea ELEGIDO incluye el motivo de la Capa B", elegidoLine?.includes("coincide con el sujeto"));
  check("log: la línea ELEGIDO incluye el motivo de la Capa C", elegidoLine?.includes("miniatura muestra el sujeto correcto"));
  const finalistasLine = logLines.find((l) => l.includes("finalistas de"));
  check("log: hay una línea de finalistas con sus etiquetas (candidato #8 descartado antes de la IA)", finalistasLine?.includes("#7") && !finalistasLine?.includes("#8"));
  const capaBLine = logLines.find((l) => l.includes("Capa B (") && l.includes("costo real"));
  check("log: la línea de Capa B registra tokens de entrada/salida reales", capaBLine?.includes("120") && capaBLine?.includes("18"));
  check("log: la línea de Capa B registra el costo real en dólares", /costo real: \$0\.000\d+/.test(capaBLine ?? ""));
  const capaCLine = logLines.find((l) => l.includes("Capa C (") && l.includes("APROBADO"));
  check("log: la línea de Capa C incluye la miniatura evaluada y la página de Pixabay", capaCLine?.includes("miniatura-7.jpg") && capaCLine?.includes("pixabay.com/x/7"));
  check("log: la línea de Capa C registra tokens y costo reales", capaCLine?.includes("350") && capaCLine?.includes("20") && /costo real: \$0\.000\d+/.test(capaCLine ?? ""));
  check("log: ninguna línea de log contiene la clave de la API", !logLines.some((l) => l.includes("fake")));
  check("resolveOneResource: mediaType illustration se conserva (no se fuerza a 'photo')", resolved.resolvedAsset?.mediaType === "illustration");
  check("resolveOneResource: localPath queda dentro de uploads/resources/<jobId>/", resolved.resolvedAsset?.localPath.startsWith("uploads/resources/job-test/"));
  __setFetchJsonForTesting(null);
  __setDownloadToFileForTesting(null);
  __setRelevanceValidatorForTesting(null);
  __setVisualValidatorForTesting(null);
}

{
  // Sin visualQuery: ni siquiera busca -- falla rápido, con motivo claro.
  let called = false;
  __setFetchJsonForTesting(async () => {
    called = true;
    return { hits: [] };
  });
  const resource = { id: "ai-resource-1", type: "broll", description: "algo" };
  const resolved = await resolveOneResource({ resource, apiKey: "fake", cacheDir, assetsDir, jobId: "job-test" });
  check("resolveOneResource: sin visualQuery, no llama a la API", called === false);
  check("resolveOneResource: sin visualQuery, queda con acquisitionFailureReason claro", resolved.acquisitionFailureReason?.includes("visualQuery"));
  __setFetchJsonForTesting(null);
}

{
  // CASO REAL 1 completo (cachorro): la Capa A por sí sola ya rechaza
  // -- la Capa B NUNCA se llama (ahorra el costo en un caso obviamente
  // malo). No inserta un animal.
  let validatorCalls = 0;
  __setFetchJsonForTesting(async () => ({
    hits: [{ id: 8637542, tags: "cachorro, animal, mascota, parque", pageURL: "https://pixabay.com/x/cachorro-animal-8637542/", largeImageURL: "https://cdn.example/cachorro.jpg", user: "x" }],
  }));
  __setRelevanceValidatorForTesting(async (args) => {
    validatorCalls++;
    return acceptBestFinalist(args);
  });
  const resource = { id: "test-image-0", type: "image", description: "x", visualQuery: "persona corriendo al amanecer en un parque" };
  const logLines = [];
  const resolved = await resolveOneResource({ resource, apiKey: "fake", cacheDir, assetsDir, jobId: "job-test", log: (m) => logLines.push(m) });
  check("test-image-0: NO inserta un animal (Capa A lo rechaza antes de la IA)", resolved.resolvedAsset === undefined);
  check("test-image-0: la Capa B nunca se llamó (ahorro de costo en caso obvio)", validatorCalls === 0);
  check("test-image-0: el motivo queda registrado para pendingResources", typeof resolved.acquisitionFailureReason === "string" && resolved.acquisitionFailureReason.length > 0);
  const rechazadoLine = logLines.find((l) => l.includes("RECHAZADO (capa A)"));
  check("log: RECHAZADO (capa A) menciona el recurso", rechazadoLine?.includes("test-image-0"));
  __setFetchJsonForTesting(null);
  __setRelevanceValidatorForTesting(null);
}

{
  // CASO REAL 2 completo (sin sentido): mismo patrón -- Capa A rechaza
  // sin gastar ninguna llamada a IA.
  let validatorCalls = 0;
  __setFetchJsonForTesting(async () => ({
    hits: [{ id: 1872665, tags: "signo, interrogacion, pregunta, duda, icono", pageURL: "https://pixabay.com/x/signo-de-interrogacion-importante-1872665/", largeImageURL: "https://cdn.example/signo.jpg", user: "x" }],
  }));
  __setRelevanceValidatorForTesting(async (args) => {
    validatorCalls++;
    return acceptBestFinalist(args);
  });
  const resource = { id: "test-image-sin-resultado", type: "image", description: "x", visualQuery: "xyzzy inexistente consulta sin sentido 12345" };
  const resolved = await resolveOneResource({ resource, apiKey: "fake", cacheDir, assetsDir, jobId: "job-test" });
  check("test-image-sin-resultado: queda rechazado y pendiente con motivo", resolved.resolvedAsset === undefined && resolved.acquisitionFailureReason?.length > 0);
  check("test-image-sin-resultado: la Capa B nunca se llamó", validatorCalls === 0);
  __setFetchJsonForTesting(null);
  __setRelevanceValidatorForTesting(null);
}

{
  // CASO LÍMITE CRÍTICO (pedido explícito de Alex): un candidato cuyas
  // etiquetas cubren EL 100% de las palabras de la consulta -- pasa la
  // Capa A sin problema -- pero es un cachorro, no una persona. La
  // Capa B (inyectada simulando el juicio real de la IA sobre esas
  // etiquetas) debe rechazarlo igual. Esto demuestra por qué la Capa A
  // sola NO basta: coincidencia de palabras no es lo mismo que
  // coincidencia de sujeto.
  let validatorCalls = 0;
  // Caché aparte: la consulta es, a propósito, la MISMA que en el caso
  // real 1 de arriba (para probar el mismo texto que reportó Alex) --
  // si usara el mismo directorio de caché, la búsqueda de ESTE caso
  // devolvería el resultado cacheado de aquel (candidatos distintos),
  // no los de esta prueba.
  const casoLimiteCacheDir = path.join(tmpDir, "cache-caso-limite");
  __setFetchJsonForTesting(async () => ({
    hits: [{ id: 999, tags: "cachorro, perro, persona, corriendo, amanecer, parque", pageURL: "https://pixabay.com/x/999", largeImageURL: "https://cdn.example/999.jpg", user: "x" }],
  }));
  __setRelevanceValidatorForTesting(async ({ finalists }) => {
    validatorCalls++;
    // Lo que de verdad respondería un validador de texto razonable:
    // las etiquetas mencionan "cachorro"/"perro", que contradice que
    // la consulta pide una PERSONA -- rechaza aunque las palabras
    // coincidan casi todas.
    check("caso límite: el candidato del cachorro SÍ llegó a la Capa B como finalista (prueba que la Capa A sola lo habría aceptado)", finalists.some((f) => f.hit.id === 999));
    return { chosenId: null, reason: "las etiquetas mencionan un cachorro/perro, no una persona -- sujeto equivocado", usage: { input_tokens: 95, output_tokens: 22 } };
  });
  const resource = { id: "caso-limite-cachorro", type: "image", description: "x", visualQuery: "persona corriendo al amanecer en un parque" };
  const logLines = [];
  const resolved = await resolveOneResource({ resource, apiKey: "fake", cacheDir: casoLimiteCacheDir, assetsDir, jobId: "job-test", log: (m) => logLines.push(m) });
  check("caso límite: la Capa B SÍ se llamó (la Capa A lo había dejado pasar)", validatorCalls === 1);
  check("caso límite: NO se inserta el cachorro -- queda pendiente con el motivo semántico", resolved.resolvedAsset === undefined && resolved.acquisitionFailureReason?.includes("cachorro"));
  const rechazadoLine = logLines.find((l) => l.includes("RECHAZADO (capa B)"));
  check("log: RECHAZADO (capa B) registra el motivo del modelo", rechazadoLine?.includes("sujeto equivocado"));
  __setFetchJsonForTesting(null);
  __setRelevanceValidatorForTesting(null);
}

{
  // CASO REAL 3 completo (broll de dopamina/cerebro): si Pixabay
  // devuelve un video de verdad pertinente, SÍ debe insertarse --
  // "solo se inserta si su contenido es pertinente a dopamina/cerebro"
  // es una condición, no una prohibición total.
  let validatorCalls = 0;
  let visualCalls = 0;
  __setFetchJsonForTesting(async () => ({
    hits: [
      {
        id: 37422,
        tags: "cerebro, neurona, dopamina, ciencia, ilustracion, medicina",
        pageURL: "https://pixabay.com/videos/id-37422/",
        videos: { medium: { url: "https://cdn.example/37422.mp4", thumbnail: "https://cdn.example/37422-thumb.jpg" } },
        user: "Animateon",
        type: "film",
      },
    ],
  }));
  __setDownloadToFileForTesting(async () => {});
  __setRelevanceValidatorForTesting(async (args) => {
    validatorCalls++;
    return acceptBestFinalist(args);
  });
  __setVisualValidatorForTesting(async (args) => {
    visualCalls++;
    return acceptVisually(args);
  });
  const resource = { id: "test-broll-0", type: "broll", description: "x", visualQuery: "ilustración 3D de una molécula de dopamina en el cerebro" };
  const resolved = await resolveOneResource({ resource, apiKey: "fake", cacheDir, assetsDir, jobId: "job-test" });
  check("test-broll-0 (candidato realmente pertinente): SÍ se inserta", resolved.resolvedAsset?.assetId === 37422);
  check("test-broll-0: la Capa B se llamó (había finalista real)", validatorCalls === 1);
  check("test-broll-0: la Capa C también se llamó (video pasa por las tres capas igual que imagen)", visualCalls === 1);
  __setFetchJsonForTesting(null);
  __setDownloadToFileForTesting(null);
  __setRelevanceValidatorForTesting(null);
  __setVisualValidatorForTesting(null);
}

{
  // La Capa B dice "ninguno sirve" (chosenId null) sin que sea un caso
  // límite de sujeto -- debe rechazar igual, nunca forzar una elección.
  __setFetchJsonForTesting(async () => ({
    hits: [{ id: 11, tags: "oficina, trabajo, escritorio, computadora", pageURL: "https://pixabay.com/x/11", largeImageURL: "https://cdn.example/11.jpg", user: "x" }],
  }));
  __setRelevanceValidatorForTesting(async () => ({ chosenId: null, reason: "ninguno de los finalistas corresponde de verdad al sujeto pedido", usage: { input_tokens: 80, output_tokens: 15 } }));
  const resource = { id: "ai-resource-none", type: "image", description: "x", visualQuery: "oficina trabajo escritorio computadora" };
  const resolved = await resolveOneResource({ resource, apiKey: "fake", cacheDir, assetsDir, jobId: "job-test" });
  check("resolveOneResource: la Capa B puede responder 'ninguno es adecuado' -- se respeta, no se fuerza nada", resolved.resolvedAsset === undefined && resolved.acquisitionFailureReason?.includes("ninguno"));
  __setFetchJsonForTesting(null);
  __setRelevanceValidatorForTesting(null);
}

{
  // La llamada a la Capa B falla (error/timeout) en AMBOS intentos: el
  // recurso queda pendiente con ESE motivo -- nunca se inserta sin
  // validar (pedido explícito: "es preferible conservar al
  // presentador en pantalla"). El reintento automático (corrección
  // 01-nov-2026) debe intentarlo exactamente 2 veces, no más ni menos.
  let validatorCalls = 0;
  __setFetchJsonForTesting(async () => ({
    hits: [{ id: 12, tags: "oficina, trabajo, escritorio, computadora", pageURL: "https://pixabay.com/x/12", largeImageURL: "https://cdn.example/12.jpg", user: "x" }],
  }));
  __setRelevanceValidatorForTesting(async () => {
    validatorCalls++;
    const err = new Error("timeout esperando a Claude (simulado)");
    err.usage = { input_tokens: 50, output_tokens: 0 };
    throw err;
  });
  const resource = { id: "ai-resource-ai-fails", type: "image", description: "x", visualQuery: "oficina trabajo escritorio computadora" };
  const logLines = [];
  const resolved = await resolveOneResource({ resource, apiKey: "fake", cacheDir, assetsDir, jobId: "job-test", log: (m) => logLines.push(m) });
  check("resolveOneResource: si la Capa B falla, NUNCA se inserta sin validar", resolved.resolvedAsset === undefined);
  check("resolveOneResource: se reintentó exactamente 1 vez (2 intentos en total, no más)", validatorCalls === 2);
  check("resolveOneResource: el motivo del fallo queda registrado", resolved.acquisitionFailureReason?.includes("timeout esperando a Claude"));
  check("resolveOneResource: el motivo incluye el costo gastado en los intentos fallidos", resolved.acquisitionFailureReason?.includes("costo gastado en los intentos fallidos"));
  check("resolveOneResource: el log explica el principio de conservar al presentador", logLines.some((l) => l.includes("presentador en pantalla")));
  check("log: el primer intento fallido queda registrado con 'Reintentando una vez'", logLines.some((l) => l.includes("intento 1/2") && l.includes("Reintentando una vez")));
  __setFetchJsonForTesting(null);
  __setRelevanceValidatorForTesting(null);
}

{
  // INCIDENTE REAL (reporte de Alex, 01-nov-2026): con 2 finalistas y
  // etiquetas muy repetidas, la Capa B devolvió texto VACÍO -- el caso
  // positivo quedó rechazado por el fail-safe en vez de aceptado. Se
  // reproduce aquí SIN mockear el validador de alto nivel, sino
  // inyectando un cliente de Anthropic falso (mismo gancho que usa
  // editorial.mjs) para ejercitar el parseo/diagnóstico/reintento
  // REALES de realValidateRelevanceWithAI. El primer intento devuelve
  // exactamente la forma de respuesta problemática (content: [],
  // texto vacío); el reintento automático sí trae un JSON válido -- el
  // recurso debe terminar ACEPTADO.
  let createCalls = 0;
  let firstPromptText = null;
  const incidenteCacheDir = path.join(tmpDir, "cache-incidente-vacio");
  __setFetchJsonForTesting(async () => ({
    hits: [
      {
        id: 1868496,
        tags: "iphone, iphone, iphone, iphone, oficina, oficina, oficina, oficina, oficina, escritorio, laptop",
        pageURL: "https://pixabay.com/x/1868496",
        largeImageURL: "https://cdn.example/1868496.jpg",
        webformatURL: "https://cdn.example/1868496-web.jpg",
        user: "autor-a",
      },
      {
        id: 2846221,
        tags: "laptop, escritorio, oficina, moderno, trabajo",
        pageURL: "https://pixabay.com/x/2846221",
        largeImageURL: "https://cdn.example/2846221.jpg",
        webformatURL: "https://cdn.example/2846221-web.jpg",
        user: "autor-b",
      },
    ],
  }));
  __setDownloadToFileForTesting(async () => {});
  // Esta prueba se enfoca en el reintento/diagnóstico de la CAPA B
  // (ver más abajo el bloque dedicado a probar lo mismo para la Capa
  // C) -- se inyecta la Capa C aparte para que no comparta el mismo
  // cliente de Anthropic falso y no se mezclen los conteos de llamadas.
  __setVisualValidatorForTesting(acceptVisually);
  __setAnthropicClientForTesting({
    messages: {
      create: async (params) => {
        createCalls++;
        if (createCalls === 1) {
          firstPromptText = params.messages?.[0]?.content ?? "";
          // La forma EXACTA del incidente real: ningún bloque de texto.
          return { content: [], stop_reason: "end_turn", usage: { input_tokens: 540, output_tokens: 0 } };
        }
        return {
          content: [{ type: "text", text: '{"chosenId": 1868496, "reason": "escritorio con laptop, coincide con la consulta"}' }],
          stop_reason: "end_turn",
          usage: { input_tokens: 540, output_tokens: 24 },
        };
      },
    },
  });
  const resource = { id: "test-image-positivo-0", type: "image", description: "x", visualQuery: "laptop sobre un escritorio de oficina moderno" };
  const logLines = [];
  const resolved = await resolveOneResource({ resource, apiKey: "fake", cacheDir: incidenteCacheDir, assetsDir, jobId: "job-test", log: (m) => logLines.push(m) });
  check("incidente reproducido: primer intento con texto vacío, segundo intento (real) ÉXITO -- se acepta", resolved.resolvedAsset?.assetId === 1868496);
  check("incidente reproducido: hubo exactamente 2 llamadas reales a messages.create (1 fallo + 1 reintento)", createCalls === 2);
  const diagLine = logLines.find((l) => l.includes("intento 1/2"));
  check("log: el intento fallido queda diagnosticado con stop_reason y tipos de bloque -- sin claves", diagLine?.includes('stop_reason="end_turn"') && diagLine?.includes("bloques de contenido=[ninguno]") && diagLine.includes("VACÍA") && !diagLine.includes("fake"));
  check("log: el intento fallido registra su costo real de ese intento (no $0, el fallo igual consumió tokens de entrada)", /costo de ese intento: \$0\.000054/.test(diagLine ?? ""));
  // "iphone" solo aparece en las etiquetas del candidato #1868496
  // (repetido 4 veces en los datos crudos) -- deduplicado, debe quedar
  // en el prompt exactamente 1 vez. "oficina" aparece en AMBOS
  // candidatos (una vez cada uno tras deduplicar sus propias
  // etiquetas) -- lo que no debe pasar es que aparezca 5 veces seguidas
  // (el dato crudo del candidato #1868496 antes de deduplicar).
  check("prompt real enviado a la IA: 'iphone' (repetido 4 veces en el candidato #1868496) queda deduplicado a 1 sola vez", (firstPromptText.match(/iphone/gi) ?? []).length === 1);
  check("prompt real enviado a la IA: 'oficina' no aparece repetida dentro de un mismo candidato (nunca 'oficina, oficina')", !/oficina,\s*oficina/i.test(firstPromptText));
  const finalistasLine = logLines.find((l) => l.includes("finalistas de"));
  check("log: la línea de finalistas tampoco repite 'oficina' dentro de un mismo candidato", !/oficina,\s*oficina/i.test(finalistasLine ?? ""));
  const elegidoLine = logLines.find((l) => l.includes("ELEGIDO"));
  check("log: la línea ELEGIDO tampoco repite etiquetas duplicadas", (elegidoLine.match(/oficina/gi) ?? []).length === 1 && (elegidoLine.match(/iphone/gi) ?? []).length === 1);
  __setAnthropicClientForTesting(null);
  __setFetchJsonForTesting(null);
  __setDownloadToFileForTesting(null);
  __setVisualValidatorForTesting(null);
}

// --- Capa C (validación VISUAL sobre la miniatura real) ------------------
// Autorización de Alex, 01-nov-2026, tras el defecto real: la Capa B
// aprobó #2846221 por sus etiquetas ("macbook", "escritorio", "oficina
// en casa") para "laptop sobre un escritorio de oficina moderno", pero
// la foto real era un celular sobre un cuaderno.

{
  // DEFECTO REAL reproducido: la Capa B aprueba #2846221 (por
  // etiquetas), pero la Capa C -- viendo la miniatura real -- lo
  // rechaza ("es un celular, no una laptop") y cascadea al OTRO
  // finalista de la misma búsqueda (#1868496), que sí aprueba
  // visualmente. El recurso termina ACEPTADO con el candidato
  // correcto, no con el que la Capa B había elegido.
  let visualCalls = 0;
  const visualEvaluated = [];
  __setFetchJsonForTesting(async () => ({
    hits: [
      { id: 2846221, tags: "macbook, escritorio, oficina en casa, computadora", pageURL: "https://pixabay.com/es/photos/negocio-computadora-movil-2846221/", largeImageURL: "https://cdn.example/2846221-large.jpg", webformatURL: "https://cdn.example/2846221-web.jpg", user: "autor-b" },
      { id: 1868496, tags: "laptop, oficina, escritorio, moderno", pageURL: "https://pixabay.com/x/1868496", largeImageURL: "https://cdn.example/1868496-large.jpg", webformatURL: "https://cdn.example/1868496-web.jpg", user: "autor-a" },
    ],
  }));
  __setDownloadToFileForTesting(async () => {});
  __setRelevanceValidatorForTesting(async () => ({ chosenId: 2846221, reason: "las etiquetas mencionan macbook/escritorio/oficina", usage: { input_tokens: 400, output_tokens: 20 } }));
  __setVisualValidatorForTesting(async ({ hit }) => {
    visualCalls++;
    visualEvaluated.push(hit.id);
    if (hit.id === 2846221) {
      return { aprobado: false, motivo: "la miniatura muestra un celular sobre un cuaderno, no una laptop", usage: { input_tokens: 300, output_tokens: 18 }, thumbnailUrl: "https://cdn.example/2846221-web.jpg" };
    }
    return { aprobado: true, motivo: "la miniatura muestra una laptop real sobre un escritorio", usage: { input_tokens: 300, output_tokens: 16 }, thumbnailUrl: "https://cdn.example/1868496-web.jpg" };
  });
  const resource = { id: "test-image-positivo-cascada", type: "image", description: "x", visualQuery: "laptop sobre un escritorio de oficina moderno" };
  const logLines = [];
  const resolved = await resolveOneResource({ resource, apiKey: "fake", cacheDir: path.join(tmpDir, "cache-cascada-acepta"), assetsDir, jobId: "job-test", log: (m) => logLines.push(m) });
  check("cascada: la Capa C evaluó los 2 finalistas en orden (primero el de la Capa B, luego el otro)", visualEvaluated.join(",") === "2846221,1868496");
  check("cascada: se detiene apenas uno aprueba -- exactamente 2 evaluaciones, no reintenta de más", visualCalls === 2);
  check("cascada: el recurso queda ACEPTADO con el candidato que la Capa C aprobó (1868496), no con el de la Capa B (2846221)", resolved.resolvedAsset?.assetId === 1868496);
  const rechazoParcialLine = logLines.find((l) => l.includes("Capa C") && l.includes("#2846221") && l.includes("rechazado"));
  check("log: queda registrado el rechazo del candidato de la Capa B por la Capa C, con su motivo", rechazoParcialLine?.includes("celular"));
  const elegidoLine = logLines.find((l) => l.includes("ELEGIDO"));
  check("log: ELEGIDO aclara que este candidato no pasó por la Capa B (la aprobó otro que la Capa C rechazó)", elegidoLine?.includes("capa B había aprobado otro candidato (#2846221)"));
  check("log: ELEGIDO incluye el motivo real de la Capa C para el candidato aceptado", elegidoLine?.includes("laptop real sobre un escritorio"));
  __setFetchJsonForTesting(null);
  __setDownloadToFileForTesting(null);
  __setRelevanceValidatorForTesting(null);
  __setVisualValidatorForTesting(null);
}

{
  // Si la Capa C rechaza TODOS los finalistas disponibles (hasta el
  // máximo de 3), el recurso queda pendiente -- nunca se fuerza una
  // elección ni se vuelve al candidato de la Capa B "por defecto".
  let visualCalls = 0;
  __setFetchJsonForTesting(async () => ({
    hits: [
      { id: 101, tags: "laptop, oficina, escritorio, moderno", pageURL: "https://pixabay.com/x/101", webformatURL: "https://cdn.example/101-web.jpg", user: "x" },
      { id: 102, tags: "laptop, oficina, escritorio, trabajo", pageURL: "https://pixabay.com/x/102", webformatURL: "https://cdn.example/102-web.jpg", user: "x" },
      { id: 103, tags: "laptop, oficina, escritorio, computadora", pageURL: "https://pixabay.com/x/103", webformatURL: "https://cdn.example/103-web.jpg", user: "x" },
    ],
  }));
  __setRelevanceValidatorForTesting(async () => ({ chosenId: 101, reason: "mejor coincidencia de etiquetas", usage: { input_tokens: 400, output_tokens: 20 } }));
  __setVisualValidatorForTesting(async ({ hit }) => {
    visualCalls++;
    return { aprobado: false, motivo: `candidato #${hit.id}: no corresponde al sujeto pedido`, usage: { input_tokens: 300, output_tokens: 15 }, thumbnailUrl: `https://cdn.example/${hit.id}-web.jpg` };
  });
  const resource = { id: "test-todos-rechazados", type: "image", description: "x", visualQuery: "laptop sobre un escritorio de oficina moderno" };
  const logLines = [];
  const resolved = await resolveOneResource({ resource, apiKey: "fake", cacheDir: path.join(tmpDir, "cache-todos-rechazados"), assetsDir, jobId: "job-test", log: (m) => logLines.push(m) });
  check("todos rechazados: se evaluaron los 3 finalistas, ni uno más (tope autorizado por Alex)", visualCalls === 3);
  check("todos rechazados: el recurso queda pendiente, no se inserta nada", resolved.resolvedAsset === undefined);
  check("todos rechazados: el motivo incluye los 3 candidatos evaluados con su motivo", ["101", "102", "103"].every((id) => resolved.acquisitionFailureReason?.includes(`#${id}`)));
  const rechazadoLine = logLines.find((l) => l.includes("RECHAZADO (capa C)"));
  check("log: RECHAZADO (capa C) menciona el recurso y conserva al presentador", rechazadoLine?.includes("test-todos-rechazados") && rechazadoLine?.includes("presentador en pantalla"));
  __setFetchJsonForTesting(null);
  __setRelevanceValidatorForTesting(null);
  __setVisualValidatorForTesting(null);
}

{
  // Fallo TÉCNICO de la Capa C en un candidato (no un rechazo de
  // sujeto) -- debe cascadear al siguiente finalista igual, no
  // confundir "no pude evaluarlo" con "lo evalué y no corresponde".
  let visualCalls = 0;
  __setFetchJsonForTesting(async () => ({
    hits: [
      { id: 201, tags: "laptop, oficina, escritorio, moderno", pageURL: "https://pixabay.com/x/201", webformatURL: "https://cdn.example/201-web.jpg", user: "x" },
      { id: 202, tags: "laptop, oficina, escritorio, trabajo", pageURL: "https://pixabay.com/x/202", webformatURL: "https://cdn.example/202-web.jpg", user: "x" },
    ],
  }));
  __setDownloadToFileForTesting(async () => {});
  __setRelevanceValidatorForTesting(async () => ({ chosenId: 201, reason: "mejor coincidencia", usage: { input_tokens: 400, output_tokens: 20 } }));
  __setVisualValidatorForTesting(async ({ hit }) => {
    visualCalls++;
    if (hit.id === 201) {
      const err = new Error("timeout de red descargando la miniatura (simulado)");
      throw err;
    }
    return { aprobado: true, motivo: "corresponde", usage: { input_tokens: 300, output_tokens: 16 }, thumbnailUrl: "https://cdn.example/202-web.jpg" };
  });
  const resource = { id: "test-fallo-tecnico-cascada", type: "image", description: "x", visualQuery: "laptop sobre un escritorio de oficina moderno" };
  const logLines = [];
  const resolved = await resolveOneResource({ resource, apiKey: "fake", cacheDir: path.join(tmpDir, "cache-fallo-tecnico-cascada"), assetsDir, jobId: "job-test", log: (m) => logLines.push(m) });
  check("fallo técnico en el 1er candidato: cascadea al 2do y lo acepta", resolved.resolvedAsset?.assetId === 202);
  check("fallo técnico: se intentó 2 veces el reintento del 1er candidato antes de pasar al 2do", visualCalls === 3); // 201 (intento 1 + reintento) + 202 (1 intento)
  const fallaLine = logLines.find((l) => l.includes("quedó sin validar tras un fallo técnico"));
  check("log: el fallo técnico del 1er candidato queda registrado aparte del rechazo semántico", fallaLine?.includes("#201") && fallaLine?.includes("timeout de red"));
  __setFetchJsonForTesting(null);
  __setDownloadToFileForTesting(null);
  __setRelevanceValidatorForTesting(null);
  __setVisualValidatorForTesting(null);
}

{
  // Video sin ningún campo de miniatura utilizable en ningún tamaño:
  // la Capa C no puede evaluar nada -- el recurso queda pendiente
  // "sin miniatura utilizable", NUNCA se inserta confiando solo en la
  // Capa B. Usa la función REAL (sin inyectar __setVisualValidatorForTesting)
  // porque el fallo ocurre ANTES de cualquier llamada a Anthropic --
  // no hay red ni clave de por medio.
  __setFetchJsonForTesting(async () => ({
    hits: [
      {
        id: 301,
        tags: "ilustracion, molecula, dopamina, cerebro",
        pageURL: "https://pixabay.com/videos/id-301/",
        videos: { medium: { url: "https://cdn.example/301.mp4" } }, // sin "thumbnail" en ningún tamaño
        user: "x",
        type: "film",
      },
    ],
  }));
  __setRelevanceValidatorForTesting(async () => ({ chosenId: 301, reason: "única coincidencia real", usage: { input_tokens: 300, output_tokens: 15 } }));
  const resource = { id: "test-video-sin-miniatura", type: "broll", description: "x", visualQuery: "ilustración de una molécula de dopamina en el cerebro" };
  const resolved = await resolveOneResource({ resource, apiKey: "fake", cacheDir: path.join(tmpDir, "cache-video-sin-miniatura"), assetsDir, jobId: "job-test" });
  check("video sin miniatura: queda pendiente, nunca se inserta sin validar visualmente", resolved.resolvedAsset === undefined);
  check("video sin miniatura: el motivo dice que no había miniatura utilizable", resolved.acquisitionFailureReason?.includes("miniatura"));
  __setFetchJsonForTesting(null);
  __setRelevanceValidatorForTesting(null);
}

{
  // La miniatura NUNCA se manda como `source: {type: "url"}` apuntando
  // al CDN de Pixabay (decisión explícita, ver comentario grande en
  // resource-acquisition.mjs: los términos de Pixabay prohíben el
  // hotlinking permanente) -- siempre se descarga primero (inyectando
  // __setDownloadBytesForTesting, nunca la red real) y se manda en
  // base64. Se verifica contra la llamada REAL a messages.create (vía
  // el cliente de Anthropic falso), no contra un resumen de alto nivel.
  let downloadedUrl = null;
  let sentImageBlock = null;
  __setFetchJsonForTesting(async () => ({
    hits: [{ id: 401, tags: "laptop, oficina, escritorio, moderno", pageURL: "https://pixabay.com/x/401", previewURL: "https://cdn.example/401-preview.jpg", webformatURL: "https://cdn.example/401-web.jpg", user: "x" }],
  }));
  __setDownloadToFileForTesting(async () => {});
  __setRelevanceValidatorForTesting(async () => ({ chosenId: 401, reason: "coincide", usage: { input_tokens: 300, output_tokens: 15 } }));
  __setDownloadBytesForTesting(async (url) => {
    downloadedUrl = url;
    return { buffer: Buffer.from("contenido-falso-de-imagen"), contentType: "image/jpeg" };
  });
  __setAnthropicClientForTesting({
    messages: {
      create: async (params) => {
        sentImageBlock = params.messages[0].content.find((b) => b.type === "image");
        return { content: [{ type: "text", text: '{"aprobado": true, "motivo": "corresponde"}' }], stop_reason: "end_turn", usage: { input_tokens: 300, output_tokens: 16 } };
      },
    },
  });
  const resource = { id: "test-nunca-url-directa", type: "image", description: "x", visualQuery: "laptop sobre un escritorio de oficina moderno" };
  const resolved = await resolveOneResource({ resource, apiKey: "fake", cacheDir: path.join(tmpDir, "cache-nunca-url"), assetsDir, jobId: "job-test" });
  check("nunca URL directa: se descargó la miniatura con webformatURL (nunca previewURL)", downloadedUrl === "https://cdn.example/401-web.jpg");
  check("nunca URL directa: el bloque de imagen mandado a Anthropic usa 'base64', nunca 'url'", sentImageBlock?.source?.type === "base64" && sentImageBlock?.source?.data === Buffer.from("contenido-falso-de-imagen").toString("base64"));
  check("nunca URL directa: el recurso se acepta normalmente con esta ruta", resolved.resolvedAsset?.assetId === 401);
  __setFetchJsonForTesting(null);
  __setDownloadToFileForTesting(null);
  __setRelevanceValidatorForTesting(null);
  __setDownloadBytesForTesting(null);
  __setAnthropicClientForTesting(null);
}

{
  // Variante del incidente real de la Capa B (respuesta vacía),
  // ahora en la CAPA C: primer intento de messages.create devuelve
  // texto vacío (misma forma del incidente real), el reintento trae
  // JSON válido -- confirma que la Capa C tiene el mismo
  // diagnóstico/reintento, ejercitando la función REAL (no un
  // validador inyectado de alto nivel).
  let createCalls = 0;
  __setFetchJsonForTesting(async () => ({
    hits: [{ id: 501, tags: "laptop, oficina, escritorio, moderno", pageURL: "https://pixabay.com/x/501", webformatURL: "https://cdn.example/501-web.jpg", user: "x" }],
  }));
  __setDownloadToFileForTesting(async () => {});
  __setRelevanceValidatorForTesting(async () => ({ chosenId: 501, reason: "coincide", usage: { input_tokens: 300, output_tokens: 15 } }));
  __setDownloadBytesForTesting(async () => ({ buffer: Buffer.from("img"), contentType: "image/jpeg" }));
  __setAnthropicClientForTesting({
    messages: {
      create: async () => {
        createCalls++;
        if (createCalls === 1) {
          return { content: [], stop_reason: "end_turn", usage: { input_tokens: 420, output_tokens: 0 } };
        }
        return { content: [{ type: "text", text: '{"aprobado": true, "motivo": "la miniatura real muestra una laptop en un escritorio"}' }], stop_reason: "end_turn", usage: { input_tokens: 420, output_tokens: 18 } };
      },
    },
  });
  const resource = { id: "test-capa-c-respuesta-vacia", type: "image", description: "x", visualQuery: "laptop sobre un escritorio de oficina moderno" };
  const logLines = [];
  const resolved = await resolveOneResource({ resource, apiKey: "fake", cacheDir: path.join(tmpDir, "cache-capa-c-vacia"), assetsDir, jobId: "job-test", log: (m) => logLines.push(m) });
  check("Capa C respuesta vacía + reintento: hubo 2 llamadas reales, se acepta tras la segunda", createCalls === 2 && resolved.resolvedAsset?.assetId === 501);
  const diagLine = logLines.find((l) => l.includes("Capa C -- intento 1/2"));
  check("log: diagnóstico real de la Capa C (stop_reason, bloques, VACÍA) -- sin claves", diagLine?.includes('stop_reason="end_turn"') && diagLine?.includes("VACÍA") && !diagLine.includes("fake"));
  __setFetchJsonForTesting(null);
  __setDownloadToFileForTesting(null);
  __setRelevanceValidatorForTesting(null);
  __setDownloadBytesForTesting(null);
  __setAnthropicClientForTesting(null);
}

{
  // Variante del incidente real: la Capa B falla con texto vacío en
  // LOS DOS intentos (el reintento no siempre salva el caso) -- debe
  // quedar rechazado y pendiente, nunca insertar algo sin validar.
  let createCalls = 0;
  const incidenteDosVecesCacheDir = path.join(tmpDir, "cache-incidente-vacio-dos-veces");
  __setFetchJsonForTesting(async () => ({
    hits: [{ id: 55, tags: "laptop, escritorio, oficina, moderno", pageURL: "https://pixabay.com/x/55", largeImageURL: "https://cdn.example/55.jpg", user: "x" }],
  }));
  __setAnthropicClientForTesting({
    messages: {
      create: async () => {
        createCalls++;
        return { content: [], stop_reason: "max_tokens", usage: { input_tokens: 300, output_tokens: 0 } };
      },
    },
  });
  const resource = { id: "siempre-vacio", type: "image", description: "x", visualQuery: "laptop sobre un escritorio de oficina moderno" };
  const logLines = [];
  const resolved = await resolveOneResource({ resource, apiKey: "fake", cacheDir: incidenteDosVecesCacheDir, assetsDir, jobId: "job-test", log: (m) => logLines.push(m) });
  check("ambos intentos reales fallan: NUNCA se inserta sin validar", resolved.resolvedAsset === undefined);
  check("ambos intentos reales fallan: se llamó exactamente 2 veces (no más)", createCalls === 2);
  const rechazadoLine = logLines.find((l) => l.includes("RECHAZADO (capa B, error)"));
  check("log: el rechazo final menciona el costo total gastado en los intentos fallidos", rechazadoLine?.includes("costo gastado en los intentos fallidos"));
  check("log: el diagnóstico distingue 'VACÍA' de un JSON simplemente mal formado", logLines.some((l) => l.includes("VACÍA")));
  __setAnthropicClientForTesting(null);
  __setFetchJsonForTesting(null);
}

{
  // DEFECTO 1 REAL reproducido EXACTO (job b7c0c8ac, 01-nov-2026):
  // candidato #2846221 -- la API devolvió stop_reason="max_tokens" con
  // bloques [thinking, text], y el texto quedó TRUNCADO a mitad de un
  // veredicto que SÍ rechazaba el candidato ({"aprobado": false,
  // "motivo": "Aparece una laptop, pero el escritorio es de madera
  // rústica..." -- sin cerrar). Esto debe tratarse como un FALLO
  // TÉCNICO (JSON incompleto), NUNCA como un veredicto válido --
  // aunque el texto truncado "diga" aprobado:false, no se puede leer
  // como una decisión real. Confirma también que la llamada ahora
  // manda `thinking: {type: "disabled"}` (el arreglo de raíz).
  let createCalls = 0;
  let sentThinkingConfig = null;
  __setFetchJsonForTesting(async () => ({
    hits: [{ id: 2846221, tags: "macbook, escritorio, oficina en casa, computadora", pageURL: "https://pixabay.com/es/photos/negocio-computadora-movil-2846221/", webformatURL: "https://cdn.example/2846221-web.jpg", user: "x" }],
  }));
  __setDownloadBytesForTesting(async () => ({ buffer: Buffer.from([0xff, 0xd8, 0xff]), contentType: "image/jpeg" }));
  __setRelevanceValidatorForTesting(async () => ({ chosenId: 2846221, reason: "coincide por etiquetas", usage: { input_tokens: 400, output_tokens: 20 } }));
  __setAnthropicClientForTesting({
    messages: {
      create: async (params) => {
        createCalls++;
        sentThinkingConfig = params.thinking;
        return {
          content: [
            { type: "thinking", thinking: "" },
            { type: "text", text: '{"aprobado": false, "motivo": "Aparece una laptop, pero el escritorio es de madera rústica con un cuaderno, un teléfono y un bolígrafo, sin un entor' },
          ],
          stop_reason: "max_tokens",
          usage: { input_tokens: 500, output_tokens: 300 },
        };
      },
    },
  });
  const resource = { id: "defecto-1-thinking-truncado", type: "image", description: "x", visualQuery: "laptop sobre un escritorio de oficina moderno" };
  const logLines = [];
  const resolved = await resolveOneResource({ resource, apiKey: "fake", cacheDir: path.join(tmpDir, "cache-defecto-1"), assetsDir, jobId: "job-test", log: (m) => logLines.push(m) });
  check("defecto 1: la llamada manda thinking:{type:'disabled'} (el arreglo de raíz)", sentThinkingConfig?.type === "disabled");
  check("defecto 1: el JSON truncado con 'aprobado: false' a medias NUNCA cuenta como veredicto válido", createCalls === 2); // se reintentó -- no se tomó el texto truncado como respuesta
  check("defecto 1: tras 2 intentos iguales, el recurso queda pendiente (fallo técnico, no un rechazo semántico real)", resolved.resolvedAsset === undefined);
  // El motivo final SÍ puede citar el texto truncado (es diagnóstico
  // útil), pero debe quedar etiquetado como "fallo técnico" -- nunca
  // como si "aprobado: false" fuera un veredicto real que se respetó.
  check("defecto 1: el motivo del rechazo queda etiquetado como fallo técnico, no como un veredicto real respetado", resolved.acquisitionFailureReason?.includes("fallo técnico"));
  const diagLine = logLines.find((l) => l.includes("Capa C -- intento 1/2"));
  check("log: el diagnóstico distingue bloques [thinking, text] y stop_reason=max_tokens -- no confunde el texto parcial con un veredicto", diagLine?.includes("bloques de contenido=[thinking, text]") && diagLine?.includes('stop_reason="max_tokens"'));
  __setFetchJsonForTesting(null);
  __setDownloadBytesForTesting(null);
  __setRelevanceValidatorForTesting(null);
  __setAnthropicClientForTesting(null);
}

{
  // Lo mismo que el defecto 1, pero para la Capa B (texto, sin imagen)
  // -- confirma que el MISMO arreglo (thinking: disabled) se aplicó
  // ahí también, no solo en la Capa C. Esto es, con evidencia, la
  // explicación real y completa del incidente de respuesta vacía del
  // 01-nov-2026 (job 0e88b0b1): la hipótesis original ("solo
  // max_tokens insuficiente") era parcial.
  let sentThinkingConfig = null;
  __setFetchJsonForTesting(async () => ({
    hits: [{ id: 601, tags: "laptop, oficina, escritorio, moderno", pageURL: "https://pixabay.com/x/601", webformatURL: "https://cdn.example/601-web.jpg", user: "x" }],
  }));
  __setAnthropicClientForTesting({
    messages: {
      create: async (params) => {
        sentThinkingConfig = params.thinking;
        return { content: [], stop_reason: "end_turn", usage: { input_tokens: 300, output_tokens: 0 } };
      },
    },
  });
  const resource = { id: "defecto-1-capa-b-thinking", type: "image", description: "x", visualQuery: "laptop sobre un escritorio de oficina moderno" };
  await resolveOneResource({ resource, apiKey: "fake", cacheDir: path.join(tmpDir, "cache-defecto-1-capa-b"), assetsDir, jobId: "job-test" });
  check("defecto 1 (Capa B): la llamada de texto también manda thinking:{type:'disabled'}", sentThinkingConfig?.type === "disabled");
  __setFetchJsonForTesting(null);
  __setAnthropicClientForTesting(null);
}

{
  // DEFECTO 2 REAL reproducido EXACTO: candidato #1868496 -- el CDN
  // declaró la miniatura como image/jpeg (cabecera HTTP), pero el
  // archivo real era un PNG -- Anthropic respondió HTTP 400. Con el
  // arreglo (detectar por firma de bytes, no por cabecera/extensión),
  // esto debe funcionar: se manda media_type:"image/png" de verdad, y
  // Anthropic lo acepta.
  let sentMediaType = null;
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  __setFetchJsonForTesting(async () => ({
    hits: [{ id: 1868496, tags: "laptop, oficina, escritorio, moderno", pageURL: "https://pixabay.com/x/1868496", webformatURL: "https://cdn.example/1868496-web.jpg", user: "x" }], // URL termina en nada que sugiera PNG -- a propósito
  }));
  __setDownloadToFileForTesting(async () => {});
  __setRelevanceValidatorForTesting(async () => ({ chosenId: 1868496, reason: "coincide", usage: { input_tokens: 300, output_tokens: 15 } }));
  __setDownloadBytesForTesting(async () => ({ buffer: pngBytes, contentType: detectImageContentTypeFromBytes(pngBytes) }));
  __setAnthropicClientForTesting({
    messages: {
      create: async (params) => {
        sentMediaType = params.messages[0].content.find((b) => b.type === "image")?.source?.media_type;
        return { content: [{ type: "text", text: '{"aprobado": true, "motivo": "corresponde"}' }], stop_reason: "end_turn", usage: { input_tokens: 300, output_tokens: 16 } };
      },
    },
  });
  const resource = { id: "defecto-2-png-con-cabecera-jpeg", type: "image", description: "x", visualQuery: "laptop sobre un escritorio de oficina moderno" };
  const resolved = await resolveOneResource({ resource, apiKey: "fake", cacheDir: path.join(tmpDir, "cache-defecto-2"), assetsDir, jobId: "job-test" });
  check("defecto 2: el tipo real (PNG, detectado por firma de bytes) se manda correctamente, aunque la cabecera/URL sugirieran otra cosa", sentMediaType === "image/png");
  check("defecto 2: el recurso se acepta normalmente con el tipo correcto", resolved.resolvedAsset?.assetId === 1868496);
  __setFetchJsonForTesting(null);
  __setDownloadToFileForTesting(null);
  __setRelevanceValidatorForTesting(null);
  __setDownloadBytesForTesting(null);
  __setAnthropicClientForTesting(null);
}

{
  // Variante del defecto 2: la miniatura descargada no tiene ninguna
  // firma reconocible (ni JPEG/PNG/GIF/WebP) -- nunca se adivina un
  // tipo, el candidato queda rechazado con ese motivo técnico y
  // cascadea al siguiente finalista.
  __setFetchJsonForTesting(async () => ({
    hits: [
      { id: 701, tags: "laptop, oficina, escritorio, moderno", pageURL: "https://pixabay.com/x/701", webformatURL: "https://cdn.example/701-web.jpg", user: "x" },
      { id: 702, tags: "laptop, oficina, escritorio, trabajo", pageURL: "https://pixabay.com/x/702", webformatURL: "https://cdn.example/702-web.jpg", user: "x" },
    ],
  }));
  __setDownloadToFileForTesting(async () => {});
  __setRelevanceValidatorForTesting(async () => ({ chosenId: 701, reason: "coincide", usage: { input_tokens: 300, output_tokens: 15 } }));
  __setDownloadBytesForTesting(async (url) => {
    const bytes = url.includes("701") ? Buffer.from("no es ninguna imagen reconocible") : Buffer.from([0xff, 0xd8, 0xff]);
    return { buffer: bytes, contentType: detectImageContentTypeFromBytes(bytes) };
  });
  __setAnthropicClientForTesting({
    messages: {
      create: async () => ({ content: [{ type: "text", text: '{"aprobado": true, "motivo": "corresponde"}' }], stop_reason: "end_turn", usage: { input_tokens: 300, output_tokens: 16 } }),
    },
  });
  const resource = { id: "defecto-2-sin-firma-reconocible", type: "image", description: "x", visualQuery: "laptop sobre un escritorio de oficina moderno" };
  const logLines = [];
  const resolved = await resolveOneResource({ resource, apiKey: "fake", cacheDir: path.join(tmpDir, "cache-defecto-2-sin-firma"), assetsDir, jobId: "job-test", log: (m) => logLines.push(m) });
  check("sin firma reconocible: cascadea al 2do candidato (con firma JPEG válida) y lo acepta", resolved.resolvedAsset?.assetId === 702);
  const fallaLine = logLines.find((l) => l.includes("#701") && l.includes("quedó sin validar"));
  check("log: el candidato sin firma reconocible queda registrado con ese motivo técnico, nunca se adivina un tipo", fallaLine?.includes("firma de bytes"));
  __setFetchJsonForTesting(null);
  __setDownloadToFileForTesting(null);
  __setRelevanceValidatorForTesting(null);
  __setDownloadBytesForTesting(null);
  __setAnthropicClientForTesting(null);
}

{
  // Falla la descarga (red) tras que la Capa B y la Capa C aprueban un candidato: no tumba nada.
  __setFetchJsonForTesting(async () => ({
    hits: [{ id: 10, tags: "neurona, cerebro, primer-plano, fotografia", largeImageURL: "https://cdn.example/10.jpg", webformatURL: "https://cdn.example/10-web.jpg", user: "x" }],
  }));
  __setDownloadToFileForTesting(async () => {
    throw new Error("ECONNRESET (simulado)");
  });
  __setRelevanceValidatorForTesting(acceptBestFinalist);
  __setVisualValidatorForTesting(acceptVisually);
  const resource = { id: "ai-resource-3", type: "image", description: "x", visualQuery: "fotografía de una neurona en primer plano" };
  const resolved = await resolveOneResource({ resource, apiKey: "fake", cacheDir, assetsDir, jobId: "job-test" });
  check("resolveOneResource: fallo de descarga -- sin resolvedAsset, con motivo, sin lanzar", resolved.resolvedAsset === undefined && resolved.acquisitionFailureReason?.includes("ECONNRESET"));
  __setFetchJsonForTesting(null);
  __setDownloadToFileForTesting(null);
  __setRelevanceValidatorForTesting(null);
  __setVisualValidatorForTesting(null);
}

{
  // Idempotente: un recurso YA resuelto (o ya fallado) no se vuelve a tocar.
  let called = false;
  __setFetchJsonForTesting(async () => {
    called = true;
    return { hits: [] };
  });
  const already = { id: "ai-resource-4", type: "image", visualQuery: "x", resolvedAsset: { provider: "pixabay", assetId: 1 } };
  const resolved = await resolveOneResource({ resource: already, apiKey: "fake", cacheDir, assetsDir, jobId: "job-test" });
  check("resolveOneResource: ya resuelto -- no vuelve a buscar", called === false && resolved.resolvedAsset.assetId === 1);
  __setFetchJsonForTesting(null);
}

// --- acquireResourcesForJob ---

{
  __setFetchJsonForTesting(async () => ({
    hits: [{ id: 20, tags: "sinapsis, cerebro, ilustracion, neurociencia", largeImageURL: "https://cdn.example/20.jpg", webformatURL: "https://cdn.example/20-web.jpg", user: "x" }],
  }));
  __setDownloadToFileForTesting(async () => {});
  __setRelevanceValidatorForTesting(acceptBestFinalist);
  __setVisualValidatorForTesting(acceptVisually);
  const resources = [
    { id: "r0", type: "image", description: "x", visualQuery: "ilustración de una sinapsis cerebral" },
    { id: "r1", type: "graphic", description: "no debería tocarse", graphicVariant: "stat", graphicData: { value: "1", label: "x" } },
    { id: "r2", type: "text-highlight", description: "tampoco", displayText: "algo" },
    { id: "r3", type: "broll", description: "sin visualQuery -- queda pendiente" },
  ];
  const { resources: updated, issues } = await acquireResourcesForJob({ resources, apiKey: "fake", cacheDir, assetsDir, jobId: "job-test-2" });
  check("acquireResourcesForJob: resuelve el image con visualQuery", updated.find((r) => r.id === "r0").resolvedAsset?.assetId === 20);
  check("acquireResourcesForJob: NO toca graphic", updated.find((r) => r.id === "r1").graphicData.value === "1" && updated.find((r) => r.id === "r1").resolvedAsset === undefined);
  check("acquireResourcesForJob: NO toca text-highlight", updated.find((r) => r.id === "r2").displayText === "algo");
  check("acquireResourcesForJob: broll sin visualQuery queda con acquisitionFailureReason", updated.find((r) => r.id === "r3").acquisitionFailureReason?.includes("visualQuery"));
  check("acquireResourcesForJob: issues incluye solo el recurso que falló", issues.length === 1 && issues[0].includes("r3"));
  __setFetchJsonForTesting(null);
  __setDownloadToFileForTesting(null);
  __setRelevanceValidatorForTesting(null);
  __setVisualValidatorForTesting(null);
}

await fs.rm(tmpDir, { recursive: true, force: true });

console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
process.exit(failures === 0 ? 0 : 1);
