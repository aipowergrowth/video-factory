// PRUEBA SIMULADA (nivel 2 de honestidad de evidencia, CLAUDE.md) --
// server/job-retry.mjs: qué jobs se pueden reintentar y qué etapas se
// omiten/repiten, con datos de job simulados (sin tocar disco, sin
// llamar a ninguna API). El mecanismo real que hace que esto sea
// cierto (resolveJobInput/transcribeJobIfNeeded/planEditIfNeeded/
// acquireResourcesIfNeeded ya se saltan solos si su resultado ya
// está en el job.json) no se vuelve a probar acá -- ya es el
// comportamiento existente de esas funciones, sin cambios; esta
// prueba solo cubre lo NUEVO (decidir si reintentar y describirlo).

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canRetryJob, describeRetryPlan, RETRYABLE_STATUSES, readJobFileForRetry, checkBaseVideoExists, appendAttemptHistory } from "./job-retry.mjs";

let failures = 0;
const check = (label, cond, detail = "") => {
  if (!cond) {
    failures++;
    console.log(`FAIL: ${label}${detail ? ` -- ${detail}` : ""}`);
  } else {
    console.log(`ok: ${label}`);
  }
};

// --- canRetryJob ---

check("canRetryJob: sin status (jobId desconocido) -> no se puede", canRetryJob(undefined).ok === false);
check("canRetryJob: status 'error' -> sí se puede", canRetryJob({ status: "error" }).ok === true);
check("canRetryJob: status 'cancelled' -> sí se puede", canRetryJob({ status: "cancelled" }).ok === true);

for (const status of ["done", "queued", "downloading", "transcribing", "planning", "converting", "rendering", "cancelling"]) {
  check(`canRetryJob: status '${status}' -> NO se puede (no es un estado terminal con fallo)`, canRetryJob({ status }).ok === false);
}

check(
  "canRetryJob: el motivo de rechazo menciona el estado actual",
  canRetryJob({ status: "rendering" }).reason.includes("rendering"),
);

check("RETRYABLE_STATUSES: exactamente error y cancelled, nada más", RETRYABLE_STATUSES.length === 2 && RETRYABLE_STATUSES.includes("error") && RETRYABLE_STATUSES.includes("cancelled"));

// --- describeRetryPlan ---

{
  // Caso real que motivó esta tarea: un job que falló en RENDER, con
  // transcripción/plan/recursos ya completos -- debe omitir las tres
  // primeras etapas y repetir solo el render.
  const job = {
    captions: [{ text: "hola", startMs: 0, endMs: 500, timestampMs: null, confidence: null }],
    cuts: [{ id: "c1", startSeconds: 1, endSeconds: 2 }],
    zooms: [],
    resources: [
      { id: "r1", type: "broll", resolvedAsset: { provider: "pixabay", localPath: "x.mp4" } },
      { id: "r2", type: "text-highlight", displayText: "hola" }, // no necesita adquisición (no es broll/image)
    ],
  };
  const plan = describeRetryPlan(job);
  const byName = Object.fromEntries(plan.map((s) => [s.name, s]));
  check("caso falla en render: transcripción SE OMITE", byName["transcripción"].skipped === true);
  check("caso falla en render: plan editorial SE OMITE", byName["plan editorial (cortes/zooms/recursos propuestos)"].skipped === true);
  check("caso falla en render: adquisición de recursos SE OMITE (ya resuelto)", byName["adquisición de recursos (Pixabay/Gemini)"].skipped === true);
  check("caso falla en render: render SIEMPRE se repite", byName["render"].skipped === false);
}

{
  // Un job que falló ANTES de transcribir (p.ej. el job nunca llegó a
  // esa etapa) -- todas las etapas posteriores también deben marcarse
  // "se repite", nunca asumir que están hechas.
  const job = { captions: [], cuts: [], zooms: [], resources: [] };
  const plan = describeRetryPlan(job);
  const byName = Object.fromEntries(plan.map((s) => [s.name, s]));
  check("caso falla temprano: transcripción SE REPITE", byName["transcripción"].skipped === false);
  check("caso falla temprano: plan editorial SE REPITE", byName["plan editorial (cortes/zooms/recursos propuestos)"].skipped === false);
  check("caso falla temprano: sin recursos, adquisición SE OMITE (nada que adquirir)", byName["adquisición de recursos (Pixabay/Gemini)"].skipped === true);
}

{
  // Recursos con adquisición PARCIAL (uno resuelto, otro todavía sin
  // resolver ni motivo de fallo) -- debe marcar "se repite" la
  // adquisición, igual que acquireResourcesIfNeeded lo haría de verdad.
  const job = {
    captions: [{ text: "x", startMs: 0, endMs: 100, timestampMs: null, confidence: null }],
    cuts: [],
    zooms: [{ id: "z1", startSeconds: 1, endSeconds: 2, fromScale: 1, toScale: 1.1 }],
    resources: [
      { id: "r1", type: "broll", resolvedAsset: { provider: "pixabay", localPath: "x.mp4" } },
      { id: "r2", type: "image" }, // sin resolvedAsset NI acquisitionFailureReason -- todavía pendiente de intentar
    ],
  };
  const plan = describeRetryPlan(job);
  const byName = Object.fromEntries(plan.map((s) => [s.name, s]));
  check("adquisición parcial: SE REPITE (hay al menos un recurso sin resolver)", byName["adquisición de recursos (Pixabay/Gemini)"].skipped === false);
  check("adquisición parcial: el detalle menciona cuántos quedan sin resolver", byName["adquisición de recursos (Pixabay/Gemini)"].detail.includes("1"));
}

{
  // Un recurso ya con acquisitionFailureReason (Pixabay no encontró
  // nada) cuenta como "ya resuelto" -- no se vuelve a intentar sin
  // necesidad, igual que acquireResourcesIfNeeded ya hace.
  const job = {
    captions: [{ text: "x", startMs: 0, endMs: 100, timestampMs: null, confidence: null }],
    cuts: [{ id: "c1", startSeconds: 0, endSeconds: 1 }],
    zooms: [],
    resources: [{ id: "r1", type: "image", acquisitionFailureReason: "sin resultado pertinente en Pixabay" }],
  };
  const plan = describeRetryPlan(job);
  const byName = Object.fromEntries(plan.map((s) => [s.name, s]));
  check("recurso con motivo de fallo ya registrado: adquisición SE OMITE", byName["adquisición de recursos (Pixabay/Gemini)"].skipped === true);
}

// --- readJobFileForRetry / checkBaseVideoExists -- con archivos REALES
// en disco (no simulado): es exactamente el escenario que más
// preocupa de esta tarea -- ¿la limpieza automática ya borró lo que
// se necesita para reintentar? ---

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vf-job-retry-"));

{
  const realJobPath = path.join(tmpDir, "real-job.json");
  await fs.writeFile(realJobPath, JSON.stringify({ captions: [], cuts: [], zooms: [], resources: [] }));
  const result = await readJobFileForRetry(realJobPath, 7);
  check("readJobFileForRetry: archivo real -- lo lee y parsea bien", result.ok === true && Array.isArray(result.job.captions));
}

{
  const missingPath = path.join(tmpDir, "no-existe.json");
  const result = await readJobFileForRetry(missingPath, 7);
  check("readJobFileForRetry: archivo YA LIMPIADO (no existe) -- rechaza con motivo claro, nunca lanza sin explicación", result.ok === false);
  check("readJobFileForRetry: el motivo menciona la retención de 7 días", result.reason.includes("7 días"));
}

{
  const corruptPath = path.join(tmpDir, "corrupto.json");
  await fs.writeFile(corruptPath, "esto no es JSON válido {{{");
  const result = await readJobFileForRetry(corruptPath, 7);
  check("readJobFileForRetry: archivo corrupto -- rechaza con motivo claro, nunca lanza sin explicación", result.ok === false);
}

{
  const realVideoPath = path.join(tmpDir, "video.mp4");
  await fs.writeFile(realVideoPath, Buffer.from("contenido de prueba, no un video real"));
  const result = await checkBaseVideoExists(realVideoPath, 7);
  check("checkBaseVideoExists: archivo real -- ok", result.ok === true);
}

{
  const missingVideoPath = path.join(tmpDir, "video-ya-limpiado.mp4");
  const result = await checkBaseVideoExists(missingVideoPath, 7);
  check("checkBaseVideoExists: video YA LIMPIADO (no existe) -- rechaza con motivo claro", result.ok === false);
  check("checkBaseVideoExists: el motivo nombra el archivo y la retención", result.reason.includes("video-ya-limpiado.mp4") && result.reason.includes("7 días"));
}

await fs.rm(tmpDir, { recursive: true, force: true });

// --- appendAttemptHistory: un reintento no borra la evidencia del intento anterior (criterio 2) ---

check("primer intento (sin historial previo, undefined): queda un array con una sola entrada", appendAttemptHistory(undefined, { n: 1 }).length === 1);
check(
  "intentos sucesivos se van agregando, uno por uno, en orden cronológico",
  JSON.stringify(appendAttemptHistory([{ n: 1 }, { n: 2 }], { n: 3 })) === JSON.stringify([{ n: 1 }, { n: 2 }, { n: 3 }]),
);
{
  // Más de maxEntries -- se recorta por el principio (los más viejos), nunca se pierde el intento MÁS RECIENTE.
  let attempts = [];
  for (let i = 1; i <= 8; i++) attempts = appendAttemptHistory(attempts, { n: i }, 5);
  check("recorta a maxEntries (5), conservando los 5 MÁS RECIENTES", attempts.length === 5 && attempts.map((a) => a.n).join(",") === "4,5,6,7,8");
}
check("existingAttempts corrupto/no-array (nunca debería pasar, pero no debe lanzar): se trata como vacío", appendAttemptHistory("no soy un array", { n: 1 }).length === 1);

console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
process.exit(failures === 0 ? 0 : 1);
