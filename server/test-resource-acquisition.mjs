// PRUEBA SIMULADA -- nunca llama a la red real de Pixabay NI a la API
// real de Anthropic (misma disciplina que el resto de las pruebas de
// este proyecto: inyecta __setFetchJsonForTesting/
// __setDownloadToFileForTesting/__setRelevanceValidatorForTesting en
// vez de golpear una API real). Prueba la lógica PURA (tokenize,
// scoreKeywordOverlap, rankCandidates, filterFinalists) y el CONTROL DE
// FLUJO de las dos capas de relevancia (Capa A por palabras clave, Capa
// B por IA sobre los finalistas) de server/resource-acquisition.mjs --
// incluidos los tres casos reales que Alex reportó el 01-nov-2026 y el
// caso límite del cachorro con etiquetas coincidentes.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  tokenize,
  matchedTokens,
  scoreKeywordOverlap,
  rankCandidates,
  filterFinalists,
  computeRelevanceCallCostUsd,
  RELEVANCE_MODEL_INPUT_PRICE_PER_TOKEN,
  RELEVANCE_MODEL_OUTPUT_PRICE_PER_TOKEN,
  searchPixabay,
  resolveOneResource,
  acquireResourcesForJob,
  __setFetchJsonForTesting,
  __setDownloadToFileForTesting,
  __setRelevanceValidatorForTesting,
} from "./resource-acquisition.mjs";

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

/** Validador falso que siempre elige el mejor finalista (el primero, ya vienen ordenados). */
const acceptBestFinalist = async ({ finalists }) => ({
  chosenId: finalists[0]?.hit.id ?? null,
  reason: "simulado: coincide con el sujeto de la consulta",
  usage: { input_tokens: 120, output_tokens: 18 },
});

// --- tokenize / scoreKeywordOverlap / matchedTokens ---

check("tokenize: quita stopwords y acentos", [...tokenize("una ilustración de la molécula")].sort().join(",") === "ilustracion,molecula");
check("tokenize: 'sin' es una palabra vacía (corrección 01-nov-2026)", !tokenize("xyzzy inexistente consulta sin sentido 12345").has("sin"));
check("tokenize: conserva las palabras significativas de una consulta sin sentido", [...tokenize("xyzzy inexistente consulta sin sentido 12345")].sort().join(",") === "12345,consulta,inexistente,sentido,xyzzy");
check("scoreKeywordOverlap: sin ninguna coincidencia da 0", scoreKeywordOverlap("gato jugando", "car, engine, factory") === 0);
check("scoreKeywordOverlap: con coincidencia da >0", scoreKeywordOverlap("laboratorio de neurociencia", "laboratorio, ciencia, microscopio") > 0);
check("matchedTokens: devuelve las palabras que de verdad coincidieron, no solo el número", matchedTokens("persona corriendo al amanecer en un parque", "cachorro, animal, parque").join(",") === "parque");

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
  // Capa B (inyectada) lo aprueba -- se descarga SOLO ese archivo, y
  // el log trae etiquetas, veredicto, tokens y costo real.
  let searchCalls = 0;
  let downloadCalls = 0;
  let validatorCalls = 0;
  __setFetchJsonForTesting(async () => {
    searchCalls++;
    return {
      hits: [
        { id: 7, tags: "molecula, dopamina, ciencia, ilustracion", pageURL: "https://pixabay.com/x/7", largeImageURL: "https://cdn.example/7-large.jpg", user: "autor-x", type: "illustration" },
        { id: 8, tags: "coche, carretera", pageURL: "https://pixabay.com/x/8", largeImageURL: "https://cdn.example/8-large.jpg", user: "autor-y" },
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
  const resource = { id: "ai-resource-0", type: "image", description: "prosa editorial", visualQuery: "ilustración de una molécula de dopamina" };
  const logLines = [];
  const resolved = await resolveOneResource({ resource, apiKey: "fake", cacheDir, assetsDir, jobId: "job-test", log: (m) => logLines.push(m) });
  check("resolveOneResource: resuelve con el candidato que la Capa B aprobó (id 7, no 8)", resolved.resolvedAsset?.assetId === 7);
  check("resolveOneResource: se descarga exactamente 1 archivo (nunca los dos candidatos)", downloadCalls === 1);
  check("resolveOneResource: solo 1 búsqueda", searchCalls === 1);
  check("resolveOneResource: la Capa B se llamó exactamente 1 vez", validatorCalls === 1);
  check("resolveOneResource: registra proveedor/licencia/autor/fecha", resolved.resolvedAsset?.provider === "pixabay" && resolved.resolvedAsset?.licenseName && resolved.resolvedAsset?.author === "autor-x" && resolved.resolvedAsset?.downloadedAt);
  const elegidoLine = logLines.find((l) => l.includes("ELEGIDO"));
  check("log: hay una línea 'ELEGIDO' con el recurso y el candidato elegido", elegidoLine?.includes("ai-resource-0") && elegidoLine?.includes("#7"));
  check("log: la línea ELEGIDO incluye las etiquetas del candidato elegido", elegidoLine?.includes("molecula, dopamina, ciencia, ilustracion"));
  check("log: la línea ELEGIDO incluye el motivo de la Capa B", elegidoLine?.includes("coincide con el sujeto"));
  const finalistasLine = logLines.find((l) => l.includes("finalistas de"));
  check("log: hay una línea de finalistas con sus etiquetas (candidato #8 descartado antes de la IA)", finalistasLine?.includes("#7") && !finalistasLine?.includes("#8"));
  const capaBLine = logLines.find((l) => l.includes("costo real"));
  check("log: la línea de Capa B registra tokens de entrada/salida reales", capaBLine?.includes("120") && capaBLine?.includes("18"));
  check("log: la línea de Capa B registra el costo real en dólares", /costo real: \$0\.000\d+/.test(capaBLine ?? ""));
  check("log: ninguna línea de log contiene la clave de la API", !logLines.some((l) => l.includes("fake")));
  check("resolveOneResource: mediaType illustration se conserva (no se fuerza a 'photo')", resolved.resolvedAsset?.mediaType === "illustration");
  check("resolveOneResource: localPath queda dentro de uploads/resources/<jobId>/", resolved.resolvedAsset?.localPath.startsWith("uploads/resources/job-test/"));
  __setFetchJsonForTesting(null);
  __setDownloadToFileForTesting(null);
  __setRelevanceValidatorForTesting(null);
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
  __setFetchJsonForTesting(async () => ({
    hits: [
      { id: 37422, tags: "cerebro, neurona, dopamina, ciencia, ilustracion, medicina", pageURL: "https://pixabay.com/videos/id-37422/", videos: { medium: { url: "https://cdn.example/37422.mp4" } }, user: "Animateon", type: "film" },
    ],
  }));
  __setDownloadToFileForTesting(async () => {});
  __setRelevanceValidatorForTesting(async (args) => {
    validatorCalls++;
    return acceptBestFinalist(args);
  });
  const resource = { id: "test-broll-0", type: "broll", description: "x", visualQuery: "ilustración 3D de una molécula de dopamina en el cerebro" };
  const resolved = await resolveOneResource({ resource, apiKey: "fake", cacheDir, assetsDir, jobId: "job-test" });
  check("test-broll-0 (candidato realmente pertinente): SÍ se inserta", resolved.resolvedAsset?.assetId === 37422);
  check("test-broll-0: la Capa B se llamó (había finalista real)", validatorCalls === 1);
  __setFetchJsonForTesting(null);
  __setDownloadToFileForTesting(null);
  __setRelevanceValidatorForTesting(null);
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
  // La llamada a la Capa B falla (error/timeout): el recurso queda
  // pendiente con ESE motivo -- nunca se inserta sin validar (pedido
  // explícito: "es preferible conservar al presentador en pantalla").
  __setFetchJsonForTesting(async () => ({
    hits: [{ id: 12, tags: "oficina, trabajo, escritorio, computadora", pageURL: "https://pixabay.com/x/12", largeImageURL: "https://cdn.example/12.jpg", user: "x" }],
  }));
  __setRelevanceValidatorForTesting(async () => {
    throw new Error("timeout esperando a Claude (simulado)");
  });
  const resource = { id: "ai-resource-ai-fails", type: "image", description: "x", visualQuery: "oficina trabajo escritorio computadora" };
  const logLines = [];
  const resolved = await resolveOneResource({ resource, apiKey: "fake", cacheDir, assetsDir, jobId: "job-test", log: (m) => logLines.push(m) });
  check("resolveOneResource: si la Capa B falla, NUNCA se inserta sin validar", resolved.resolvedAsset === undefined);
  check("resolveOneResource: el motivo del fallo queda registrado", resolved.acquisitionFailureReason?.includes("timeout esperando a Claude"));
  check("resolveOneResource: el log explica el principio de conservar al presentador", logLines.some((l) => l.includes("presentador en pantalla")));
  __setFetchJsonForTesting(null);
  __setRelevanceValidatorForTesting(null);
}

{
  // Falla la descarga (red) tras que la Capa B aprueba un candidato: no tumba nada.
  __setFetchJsonForTesting(async () => ({ hits: [{ id: 10, tags: "neurona, cerebro, primer-plano, fotografia", largeImageURL: "https://cdn.example/10.jpg", user: "x" }] }));
  __setDownloadToFileForTesting(async () => {
    throw new Error("ECONNRESET (simulado)");
  });
  __setRelevanceValidatorForTesting(acceptBestFinalist);
  const resource = { id: "ai-resource-3", type: "image", description: "x", visualQuery: "fotografía de una neurona en primer plano" };
  const resolved = await resolveOneResource({ resource, apiKey: "fake", cacheDir, assetsDir, jobId: "job-test" });
  check("resolveOneResource: fallo de descarga -- sin resolvedAsset, con motivo, sin lanzar", resolved.resolvedAsset === undefined && resolved.acquisitionFailureReason?.includes("ECONNRESET"));
  __setFetchJsonForTesting(null);
  __setDownloadToFileForTesting(null);
  __setRelevanceValidatorForTesting(null);
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
  __setFetchJsonForTesting(async () => ({ hits: [{ id: 20, tags: "sinapsis, cerebro, ilustracion, neurociencia", largeImageURL: "https://cdn.example/20.jpg", user: "x" }] }));
  __setDownloadToFileForTesting(async () => {});
  __setRelevanceValidatorForTesting(acceptBestFinalist);
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
}

await fs.rm(tmpDir, { recursive: true, force: true });

console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
process.exit(failures === 0 ? 0 : 1);
