// Recuperación de un job fallido (Fase 0 "render de videos largos",
// 08-nov-2026, autorizado por Alex, criterio 3). Causa raíz verificada
// por código, no asumida: el pipeline (resolveJobInput ->
// transcribeJobIfNeeded -> planEditIfNeeded -> acquireResourcesIfNeeded
// -> render) YA es idempotente por construcción -- cada etapa se
// salta sola si su resultado ya está en el job.json persistido en
// disco (confirmado leyendo server/index.mjs: `transcribeJobIfNeeded`
// se salta si `job.captions.length > 0`; `planEditIfNeeded` si
// `job.cuts`/`job.zooms` ya tienen algo; `acquireResourcesIfNeeded` si
// todo recurso broll/image ya tiene `resolvedAsset` o
// `acquisitionFailureReason`). Un job que falló por timeout de render
// (como 1fd239de-8f9e-4642-8e42-d848b17d8481) ya pasó por las tres
// primeras etapas antes de llegar al render -- re-encolarlo reintenta
// SOLO el render, con $0 de costo de API, sin ningún cambio nuevo en
// esas funciones (que ya tenían este comportamiento desde antes).
//
// Este módulo agrega solo lo que faltaba: decidir si un job puede
// reintentarse (`canRetryJob`) y describir, para el log/humano, qué se
// va a omitir y qué se va a repetir (`describeRetryPlan`) -- NUNCA
// decide el comportamiento real del pipeline, que sigue viviendo
// exclusivamente en las funciones de index.mjs ya mencionadas; si
// `describeRetryPlan` llegara a desincronizarse de esa lógica real, el
// peor caso es una línea de log desprolija, nunca un reintento que
// repita o salte algo distinto de lo que esas funciones ya decidían.

import fsp from "node:fs/promises";
import path from "node:path";

/**
 * Historial de intentos (Fase 0, causa raíz con evidencia del VPS,
 * 09-nov-2026, autorizado por Alex, criterio 2). Causa raíz real
 * confirmada contra el código (f157a65/dca1c65, no asumida): el
 * endpoint de reintentar hacía `writeStatus(jobId, { error: undefined,
 * renderProgress: undefined })` -- eso BORRA el motivo del intento
 * anterior (en JSON, una clave con valor `undefined` desaparece al
 * serializar) antes de que nadie lo haya visto. Un job real (1fd239de)
 * perdió así el motivo de su intento de las 19:33 cuando se reintentó
 * a las 20:00.
 *
 * `appendAttemptHistory` es pura: recibe el historial actual (puede
 * venir undefined si es el primer intento) y el nuevo intento
 * concluido, devuelve un array nuevo con como máximo
 * `maxEntries` -- los MÁS RECIENTES primero no hace falta; se guarda
 * en orden cronológico (el más viejo primero) y quien lo muestre
 * decide el orden de lectura. Recortar por `maxEntries` (no por bytes)
 * porque cada entrada YA viene con sus propios campos acotados
 * (`stdoutTail`/`stderrTail`, ver render-worker.mjs) -- un tamaño por
 * entrada predecible hace que acotar la CANTIDAD de entradas sea
 * suficiente para acotar el tamaño total.
 */
export const MAX_ATTEMPT_HISTORY_ENTRIES = 5;

export const appendAttemptHistory = (existingAttempts, newAttempt, maxEntries = MAX_ATTEMPT_HISTORY_ENTRIES) => {
  const current = Array.isArray(existingAttempts) ? existingAttempts : [];
  const next = [...current, newAttempt];
  return next.length > maxEntries ? next.slice(next.length - maxEntries) : next;
};

/** Solo error/cancelled se pueden reintentar -- un job en curso o ya
 * terminado con éxito no tiene nada que "reintentar". */
export const RETRYABLE_STATUSES = ["error", "cancelled"];

/**
 * Lee y parsea el job.json para un reintento -- si ya no existe (la
 * limpieza automática de RETENTION_DAYS ya corrió) o está corrupto,
 * devuelve un motivo claro en vez de lanzar sin explicación. Probado
 * con archivos reales en server/test-job-retry.mjs (no simulado): es
 * exactamente el escenario que más preocupa de esta tarea (¿el job ya
 * se limpió antes de que alguien pida reintentarlo?).
 */
export const readJobFileForRetry = async (jobFilePath, retentionDays) => {
  try {
    const raw = await fsp.readFile(jobFilePath, "utf8");
    return { ok: true, job: JSON.parse(raw) };
  } catch (err) {
    return {
      ok: false,
      reason: `No se pudo leer el archivo del job (¿ya se limpió por retención de ${retentionDays} días?): ${err.message ?? err}`,
    };
  }
};

/**
 * Confirma que el video base del job todavía existe en disco --
 * `resolveJobInput` no lo vuelve a descargar/pedir si `baseVideo` ya
 * está puesto (ver server/index.mjs), así que si el ARCHIVO ya no
 * está, un reintento fallaría recién al llegar al render, mucho
 * después, con un error confuso. Se chequea ACÁ, antes de encolar.
 */
export const checkBaseVideoExists = async (baseVideoAbsolutePath, retentionDays) => {
  try {
    await fsp.access(baseVideoAbsolutePath);
    return { ok: true };
  } catch {
    return {
      ok: false,
      reason: `El video base (${path.basename(baseVideoAbsolutePath)}) ya no existe en disco (¿ya se limpió por retención de ${retentionDays} días?) -- hay que volver a subirlo, no se puede reintentar solo el render.`,
    };
  }
};

export const canRetryJob = (status) => {
  if (!status) {
    return { ok: false, reason: "jobId desconocido." };
  }
  if (!RETRYABLE_STATUSES.includes(status.status)) {
    return {
      ok: false,
      reason: `El trabajo está en estado "${status.status}" -- solo se puede reintentar uno en "error" o "cancelled".`,
    };
  }
  return { ok: true };
};

/**
 * Describe, solo para el log (ver el comentario grande de arriba --
 * nunca decide el comportamiento real), qué etapas del job ya están
 * resueltas en disco y se van a omitir, y cuál es la única que
 * siempre se repite (el render).
 */
export const describeRetryPlan = (job) => {
  const steps = [];

  const hasTranscription = Array.isArray(job.captions) && job.captions.length > 0;
  steps.push({
    name: "transcripción",
    skipped: hasTranscription,
    detail: hasTranscription ? `${job.captions.length} línea(s) de subtítulo ya transcriptas` : "se transcribirá de nuevo (whisper.cpp, sin costo de API)",
  });

  const hasPlan = (job.cuts?.length ?? 0) > 0 || (job.zooms?.length ?? 0) > 0;
  steps.push({
    name: "plan editorial (cortes/zooms/recursos propuestos)",
    skipped: hasPlan,
    detail: hasPlan
      ? `${job.cuts?.length ?? 0} corte(s), ${job.zooms?.length ?? 0} zoom(s), ${job.resources?.length ?? 0} recurso(s) ya decididos por Claude`
      : "se le volverá a pedir un plan a Claude (costo de tokens de nuevo)",
  });

  const resources = job.resources ?? [];
  const pendingAcquisition = resources.filter(
    (r) => (r.type === "broll" || r.type === "image") && !r.resolvedAsset && !r.acquisitionFailureReason,
  );
  const hasAcquisition = resources.length === 0 || pendingAcquisition.length === 0;
  steps.push({
    name: "adquisición de recursos (Pixabay/Gemini)",
    skipped: hasAcquisition,
    detail: hasAcquisition
      ? resources.length === 0
        ? "sin recursos que adquirir"
        : "todos los recursos broll/image ya tienen un resultado (resuelto o pendiente con motivo)"
      : `${pendingAcquisition.length} recurso(s) todavía sin resolver -- se intentará adquirirlos de nuevo`,
  });

  steps.push({
    name: "render",
    skipped: false,
    detail: "siempre se repite -- es la etapa que falló",
  });

  return steps;
};
