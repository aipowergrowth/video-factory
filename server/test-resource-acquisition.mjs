// PRUEBA SIMULADA -- nunca llama a la red real de Pixabay (misma
// disciplina que el resto de las pruebas de este proyecto: inyecta
// __setFetchJsonForTesting/__setDownloadToFileForTesting en vez de
// golpear una API real). Prueba la lógica PURA (tokenize, scoreKeywordOverlap,
// pickBestHit) y el CONTROL DE FLUJO (caché de 24h, un solo pedido por
// consulta, nunca tumbar el job por un fallo, nunca descargar más de un
// archivo por recurso) de server/resource-acquisition.mjs.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  tokenize,
  scoreKeywordOverlap,
  pickBestHit,
  searchPixabay,
  resolveOneResource,
  acquireResourcesForJob,
  __setFetchJsonForTesting,
  __setDownloadToFileForTesting,
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

// --- tokenize / scoreKeywordOverlap ---

check("tokenize: quita stopwords y acentos", [...tokenize("una ilustración de la molécula")].sort().join(",") === "ilustracion,molecula");
check("scoreKeywordOverlap: cuenta coincidencias reales", scoreKeywordOverlap("molécula de dopamina", "dopamine, molecule, science") >= 0);
check("scoreKeywordOverlap: sin ninguna coincidencia da 0", scoreKeywordOverlap("gato jugando", "car, engine, factory") === 0);
check("scoreKeywordOverlap: con coincidencia da >0", scoreKeywordOverlap("laboratorio de neurociencia", "laboratorio, ciencia, microscopio") > 0);

// --- pickBestHit ---

{
  const hits = [
    { id: 1, tags: "coche, carretera, viaje" },
    { id: 2, tags: "laboratorio, neurociencia, microscopio" },
    { id: 3, tags: "comida, cocina, receta" },
  ];
  const best = pickBestHit(hits, "laboratorio de neurociencia");
  check("pickBestHit: elige el candidato con mejor coincidencia", best && best.hit.id === 2);
}

{
  const hits = [{ id: 1, tags: "coche, carretera" }, { id: 2, tags: "comida, cocina" }];
  const best = pickBestHit(hits, "laboratorio de neurociencia");
  check("pickBestHit: sin ningún candidato relevante, devuelve null (no inserta algo genérico)", best === null);
}

check("pickBestHit: lista vacía devuelve null", pickBestHit([], "cualquier cosa") === null);

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

// --- resolveOneResource ---

{
  // Caso sano: encuentra un candidato relevante y descarga SOLO ese archivo.
  let searchCalls = 0;
  let downloadCalls = 0;
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
  const resource = { id: "ai-resource-0", type: "image", description: "prosa editorial", visualQuery: "ilustración de una molécula de dopamina" };
  const resolved = await resolveOneResource({ resource, apiKey: "fake", cacheDir, assetsDir, jobId: "job-test" });
  check("resolveOneResource: resuelve con el candidato más relevante (id 7, no 8)", resolved.resolvedAsset?.assetId === 7);
  check("resolveOneResource: se descarga exactamente 1 archivo (nunca los dos candidatos)", downloadCalls === 1);
  check("resolveOneResource: solo 1 búsqueda", searchCalls === 1);
  check("resolveOneResource: registra proveedor/licencia/autor/fecha", resolved.resolvedAsset?.provider === "pixabay" && resolved.resolvedAsset?.licenseName && resolved.resolvedAsset?.author === "autor-x" && resolved.resolvedAsset?.downloadedAt);
  check("resolveOneResource: mediaType illustration se conserva (no se fuerza a 'photo')", resolved.resolvedAsset?.mediaType === "illustration");
  check("resolveOneResource: localPath queda dentro de uploads/resources/<jobId>/", resolved.resolvedAsset?.localPath.startsWith("uploads/resources/job-test/"));
  __setFetchJsonForTesting(null);
  __setDownloadToFileForTesting(null);
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
  // Ningún candidato relevante: no inserta nada genérico -- queda con motivo.
  __setFetchJsonForTesting(async () => ({ hits: [{ id: 9, tags: "coche, carretera", largeImageURL: "https://cdn.example/9.jpg", user: "x" }] }));
  const resource = { id: "ai-resource-2", type: "image", description: "x", visualQuery: "laboratorio de neurociencia" };
  const resolved = await resolveOneResource({ resource, apiKey: "fake", cacheDir, assetsDir, jobId: "job-test" });
  check("resolveOneResource: sin candidato relevante, NO queda resolvedAsset", resolved.resolvedAsset === undefined);
  check("resolveOneResource: motivo menciona la consulta original", resolved.acquisitionFailureReason?.includes("laboratorio de neurociencia"));
  __setFetchJsonForTesting(null);
}

{
  // Falla la descarga (red) tras encontrar un candidato válido: no tumba nada.
  __setFetchJsonForTesting(async () => ({ hits: [{ id: 10, tags: "neurona, cerebro, primer-plano", largeImageURL: "https://cdn.example/10.jpg", user: "x" }] }));
  __setDownloadToFileForTesting(async () => {
    throw new Error("ECONNRESET (simulado)");
  });
  const resource = { id: "ai-resource-3", type: "image", description: "x", visualQuery: "fotografía de una neurona en primer plano" };
  const resolved = await resolveOneResource({ resource, apiKey: "fake", cacheDir, assetsDir, jobId: "job-test" });
  check("resolveOneResource: fallo de descarga -- sin resolvedAsset, con motivo, sin lanzar", resolved.resolvedAsset === undefined && resolved.acquisitionFailureReason?.includes("ECONNRESET"));
  __setFetchJsonForTesting(null);
  __setDownloadToFileForTesting(null);
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
  __setFetchJsonForTesting(async ({ } = {}) => ({ hits: [{ id: 20, tags: "sinapsis, cerebro, ilustracion", largeImageURL: "https://cdn.example/20.jpg", user: "x" }] }));
  __setDownloadToFileForTesting(async () => {});
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
}

await fs.rm(tmpDir, { recursive: true, force: true });

console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
process.exit(failures === 0 ? 0 : 1);
