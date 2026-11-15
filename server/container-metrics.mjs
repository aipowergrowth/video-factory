// Lectura de uso real de CPU/memoria del contenedor (cgroup v2) --
// Fase 0 "render de videos largos" (08-nov-2026, autorizado por Alex),
// criterio 2: "Cuadros por segundo, tiempo de render por minuto de
// video, CPU y memoria (pico y promedio)...". `readContainerMemoryBytes`
// extraído de server/transcribe.mjs (que ya la usaba, sin cambios de
// comportamiento) para poder reutilizarla también durante el render y
// probarla aislada. No existe `/sys/fs/cgroup/*` en macOS (esta
// máquina de desarrollo) -- ahí simplemente no hay métricas, nunca
// revienta: cada lectura devuelve `null` en vez de lanzar.
import fs from "node:fs/promises";

export const readContainerMemoryBytes = async (cgroupRoot = "/sys/fs/cgroup") => {
  try {
    const raw = await fs.readFile(`${cgroupRoot}/memory.current`, "utf8");
    return Number(raw.trim());
  } catch {
    return null;
  }
};

/**
 * Extrae los campos `anon`/`file` (bytes) de un `memory.stat` YA LEÍDO
 * -- pura, para poder probarla con contenido hecho a mano. `memory.stat`
 * de cgroup v2 tiene una línea por campo, `"<campo> <bytes>"`.
 *
 * Causa raíz con evidencia real del VPS, 14-nov-2026 (adenda criterio
 * 3): `memory.current` (lo que ya medía este módulo) es memoria TOTAL
 * cargada al cgroup -- incluye caché de archivos (páginas de
 * lectura/escritura de disco, reclamable bajo presión, el kernel la
 * libera SOLA antes de un OOM) junto con la memoria anónima real
 * (heap/pila de los procesos, NO reclamable -- la que de verdad puede
 * provocar un OOM-kill). Un pico de 6.144MB en `memory.current` contra
 * un límite de 6GB NO prueba por sí solo que el contenedor esté cerca
 * de un OOM-kill real -- depende de cuánto de eso es `file` (caché) vs
 * `anon` (de verdad en uso). `memory.stat` SÍ separa ambos.
 */
export const parseMemoryStatAnonFile = (rawMemoryStat) => {
  const anonMatch = /^anon (\d+)$/m.exec(rawMemoryStat ?? "");
  const fileMatch = /^file (\d+)$/m.exec(rawMemoryStat ?? "");
  return {
    anonBytes: anonMatch ? Number(anonMatch[1]) : null,
    fileBytes: fileMatch ? Number(fileMatch[1]) : null,
  };
};

/** Memoria ANÓNIMA real del contenedor (la que de verdad puede provocar un OOM-kill, sin la caché de archivos reclamable) -- `null` sin cgroup v2 o sin ese campo. */
export const readContainerAnonMemoryBytes = async (cgroupRoot = "/sys/fs/cgroup") => {
  try {
    const raw = await fs.readFile(`${cgroupRoot}/memory.stat`, "utf8");
    return parseMemoryStatAnonFile(raw).anonBytes;
  } catch {
    return null;
  }
};

/**
 * Núcleos de CPU asignados al contenedor -- cgroup v2 `cpu.max` tiene
 * la forma `"<quota> <period>"` en microsegundos (p.ej. "400000
 * 100000" = 4 núcleos), o `"max"` si no hay límite (sin tope -- se
 * devuelve `null`, no un número inventado).
 */
export const readContainerCpuLimitCores = async (cgroupRoot = "/sys/fs/cgroup") => {
  try {
    const raw = (await fs.readFile(`${cgroupRoot}/cpu.max`, "utf8")).trim();
    const [quotaStr, periodStr] = raw.split(/\s+/);
    if (quotaStr === "max") return null;
    const quota = Number(quotaStr);
    const period = Number(periodStr);
    return period > 0 ? quota / period : null;
  } catch {
    return null;
  }
};

/** Microsegundos de CPU acumulados desde que existe el cgroup -- `cpu.stat` tiene una línea `"usage_usec <N>"`. */
export const readContainerCpuUsageMicros = async (cgroupRoot = "/sys/fs/cgroup") => {
  try {
    const raw = await fs.readFile(`${cgroupRoot}/cpu.stat`, "utf8");
    const match = /^usage_usec (\d+)$/m.exec(raw);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
};

/**
 * Convierte una serie de muestras de uso de CPU (microsegundos
 * acumulados, con su hora en ms) en núcleos usados por intervalo --
 * pura, sin tocar el disco, para poder probarla con datos simulados
 * (nivel 2 de honestidad de evidencia) sin depender de cgroup real.
 */
export const computeCpuCoresPerInterval = (samples) => {
  const cores = [];
  for (let i = 1; i < samples.length; i++) {
    const deltaUsageUsec = samples[i].usageMicros - samples[i - 1].usageMicros;
    const deltaWallUsec = (samples[i].atMs - samples[i - 1].atMs) * 1000;
    if (deltaWallUsec > 0) cores.push(deltaUsageUsec / deltaWallUsec);
  }
  return cores;
};

/** Resume picos/promedios -- misma lógica pura que usa `startContainerMetricsSampling`, separada para poder probarla sin `setInterval` real. `anonMemoryBytesSamples` (criterio 3, adenda 14-nov-2026) es opcional -- `anon*` queda en `null` si no se dio, nunca un número inventado. */
export const summarizeMetricSamples = ({ memoryBytesSamples, cpuCoreSamples, cpuLimitCores, anonMemoryBytesSamples = [] }) => {
  if (memoryBytesSamples.length === 0 && cpuCoreSamples.length === 0) {
    return { available: false };
  }
  const peakMemoryBytes = memoryBytesSamples.length ? Math.max(...memoryBytesSamples) : null;
  const avgMemoryBytes = memoryBytesSamples.length ? memoryBytesSamples.reduce((a, b) => a + b, 0) / memoryBytesSamples.length : null;
  const peakAnonMemoryBytes = anonMemoryBytesSamples.length ? Math.max(...anonMemoryBytesSamples) : null;
  const avgAnonMemoryBytes = anonMemoryBytesSamples.length ? anonMemoryBytesSamples.reduce((a, b) => a + b, 0) / anonMemoryBytesSamples.length : null;
  const peakCpuCores = cpuCoreSamples.length ? Math.max(...cpuCoreSamples) : null;
  const avgCpuCores = cpuCoreSamples.length ? cpuCoreSamples.reduce((a, b) => a + b, 0) / cpuCoreSamples.length : null;
  const round1 = (n) => (n === null ? null : Math.round(n * 10) / 10);
  const round2 = (n) => (n === null ? null : Math.round(n * 100) / 100);
  return {
    available: true,
    sampleCount: Math.max(memoryBytesSamples.length, cpuCoreSamples.length),
    peakMemoryMB: peakMemoryBytes !== null ? Math.round(peakMemoryBytes / 1024 / 1024) : null,
    avgMemoryMB: avgMemoryBytes !== null ? Math.round(avgMemoryBytes / 1024 / 1024) : null,
    // Memoria ANÓNIMA real (sin caché de archivos reclamable) -- la que
    // de verdad puede provocar un OOM-kill. `null` si no se pudo medir
    // (p.ej. `memory.stat` no disponible) -- nunca confundir con 0.
    peakAnonMemoryMB: peakAnonMemoryBytes !== null ? Math.round(peakAnonMemoryBytes / 1024 / 1024) : null,
    avgAnonMemoryMB: avgAnonMemoryBytes !== null ? Math.round(avgAnonMemoryBytes / 1024 / 1024) : null,
    cpuLimitCores,
    peakCpuCores: round2(peakCpuCores),
    avgCpuCores: round2(avgCpuCores),
    peakCpuPercentOfLimit: peakCpuCores !== null && cpuLimitCores ? round1((peakCpuCores / cpuLimitCores) * 100) : null,
    avgCpuPercentOfLimit: avgCpuCores !== null && cpuLimitCores ? round1((avgCpuCores / cpuLimitCores) * 100) : null,
  };
};

/**
 * Muestrea memoria/CPU del contenedor cada `intervalMs` mientras algo
 * se ejecuta (un render, una transcripción) y acumula pico/promedio.
 * `stop()` detiene el muestreo y devuelve el resumen de
 * `summarizeMetricSamples` -- `available:false` si no hay cgroup
 * (macOS de desarrollo), nunca cifras inventadas.
 */
export const startContainerMetricsSampling = ({ intervalMs = 10_000, cgroupRoot = "/sys/fs/cgroup" } = {}) => {
  const memoryBytesSamples = [];
  const anonMemoryBytesSamples = [];
  const cpuUsageSamples = []; // { usageMicros, atMs }
  let cpuLimitCores = null;

  const sampleOnce = async () => {
    const mem = await readContainerMemoryBytes(cgroupRoot);
    if (mem !== null) memoryBytesSamples.push(mem);
    const anonMem = await readContainerAnonMemoryBytes(cgroupRoot);
    if (anonMem !== null) anonMemoryBytesSamples.push(anonMem);
    const usageMicros = await readContainerCpuUsageMicros(cgroupRoot);
    if (usageMicros !== null) cpuUsageSamples.push({ usageMicros, atMs: Date.now() });
  };

  const limitPromise = readContainerCpuLimitCores(cgroupRoot).then((limit) => {
    cpuLimitCores = limit;
  });
  const firstSamplePromise = sampleOnce();
  const timer = setInterval(sampleOnce, intervalMs);

  const stop = async () => {
    clearInterval(timer);
    await Promise.all([limitPromise, firstSamplePromise]);
    await sampleOnce(); // muestra final, para que el último tramo del render también cuente
    const cpuCoreSamples = computeCpuCoresPerInterval(cpuUsageSamples);
    return summarizeMetricSamples({ memoryBytesSamples, cpuCoreSamples, cpuLimitCores, anonMemoryBytesSamples });
  };

  return { stop };
};

/**
 * Compuerta de seguridad de memoria (adenda criterio 3/4, 14-nov-2026):
 * `true` si hay margen ANÓNIMO suficiente para arrancar OTRO proceso
 * pesado (un tramo más en paralelo) sin acercarse al límite real de
 * OOM-kill del contenedor -- mide `memory.stat` en el momento, no un
 * supuesto. `safetyMarginFraction` (25% por defecto) es cuánto del
 * límite se deja de colchón a propósito, generoso frente a que la
 * memoria anónima puede seguir creciendo mientras el nuevo proceso
 * arranca (el chequeo es un instante, no una reserva). Si no se puede
 * medir (sin cgroup, o sin límite conocido), devuelve `true` -- fail-
 * safe hacia PERMITIR, igual que el resto de este módulo cuando cgroup
 * no existe (macOS de desarrollo); el límite real de memoria del
 * kernel sigue protegiendo al contenedor de todos modos.
 */
export const hasMemoryHeadroomForAnotherTask = async ({ cgroupRoot = "/sys/fs/cgroup", memoryLimitBytes, safetyMarginFraction = 0.25 } = {}) => {
  if (!memoryLimitBytes || memoryLimitBytes <= 0) return true;
  const anonBytes = await readContainerAnonMemoryBytes(cgroupRoot);
  if (anonBytes === null) return true;
  return anonBytes < memoryLimitBytes * (1 - safetyMarginFraction);
};

/** Límite de memoria del contenedor en bytes -- cgroup v2 `memory.max` (bytes, o `"max"` si no hay tope -- `null`, no un número inventado). */
export const readContainerMemoryLimitBytes = async (cgroupRoot = "/sys/fs/cgroup") => {
  try {
    const raw = (await fs.readFile(`${cgroupRoot}/memory.max`, "utf8")).trim();
    if (raw === "max") return null;
    const bytes = Number(raw);
    return Number.isFinite(bytes) ? bytes : null;
  } catch {
    return null;
  }
};
