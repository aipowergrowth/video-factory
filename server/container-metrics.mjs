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

/** Resume picos/promedios -- misma lógica pura que usa `startContainerMetricsSampling`, separada para poder probarla sin `setInterval` real. */
export const summarizeMetricSamples = ({ memoryBytesSamples, cpuCoreSamples, cpuLimitCores }) => {
  if (memoryBytesSamples.length === 0 && cpuCoreSamples.length === 0) {
    return { available: false };
  }
  const peakMemoryBytes = memoryBytesSamples.length ? Math.max(...memoryBytesSamples) : null;
  const avgMemoryBytes = memoryBytesSamples.length ? memoryBytesSamples.reduce((a, b) => a + b, 0) / memoryBytesSamples.length : null;
  const peakCpuCores = cpuCoreSamples.length ? Math.max(...cpuCoreSamples) : null;
  const avgCpuCores = cpuCoreSamples.length ? cpuCoreSamples.reduce((a, b) => a + b, 0) / cpuCoreSamples.length : null;
  const round1 = (n) => (n === null ? null : Math.round(n * 10) / 10);
  const round2 = (n) => (n === null ? null : Math.round(n * 100) / 100);
  return {
    available: true,
    sampleCount: Math.max(memoryBytesSamples.length, cpuCoreSamples.length),
    peakMemoryMB: peakMemoryBytes !== null ? Math.round(peakMemoryBytes / 1024 / 1024) : null,
    avgMemoryMB: avgMemoryBytes !== null ? Math.round(avgMemoryBytes / 1024 / 1024) : null,
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
  const cpuUsageSamples = []; // { usageMicros, atMs }
  let cpuLimitCores = null;

  const sampleOnce = async () => {
    const mem = await readContainerMemoryBytes(cgroupRoot);
    if (mem !== null) memoryBytesSamples.push(mem);
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
    return summarizeMetricSamples({ memoryBytesSamples, cpuCoreSamples, cpuLimitCores });
  };

  return { stop };
};
