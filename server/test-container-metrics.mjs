// PRUEBA SIMULADA (nivel 2 de honestidad de evidencia, CLAUDE.md) --
// server/container-metrics.mjs: cálculo de núcleos de CPU usados por
// intervalo y resumen de pico/promedio, con datos de muestras
// simulados (sin cgroup real, sin depender de Linux). La lectura REAL
// de /sys/fs/cgroup (en producción) no se puede probar acá -- no
// existe en esta Mac ni en el runner de CI de forma garantizada; las
// funciones de lectura (`readContainerMemoryBytes` etc.) ya devuelven
// `null` de forma fail-safe cuando el archivo no existe, que es
// exactamente lo que esta prueba no necesita re-probar (ya lo hacía
// transcribe.mjs, sin incidentes, desde antes de esta extracción).

import { computeCpuCoresPerInterval, summarizeMetricSamples, readContainerMemoryBytes, readContainerCpuLimitCores, readContainerCpuUsageMicros } from "./container-metrics.mjs";

let failures = 0;
const check = (label, cond, detail = "") => {
  if (!cond) {
    failures++;
    console.log(`FAIL: ${label}${detail ? ` -- ${detail}` : ""}`);
  } else {
    console.log(`ok: ${label}`);
  }
};

// --- computeCpuCoresPerInterval ---

{
  // 1 núcleo usado al 100% durante 1000ms: delta de uso = 1,000,000us (1s), delta de tiempo = 1000ms -> 1.0 núcleo.
  const samples = [
    { usageMicros: 0, atMs: 0 },
    { usageMicros: 1_000_000, atMs: 1000 },
  ];
  const cores = computeCpuCoresPerInterval(samples);
  check("1 núcleo al 100% durante 1s: calcula 1.0 núcleo", cores.length === 1 && Math.abs(cores[0] - 1.0) < 1e-9);
}

{
  // 4 núcleos (contenedor de 4 CPU) usados al tope: en 1000ms de reloj, 4,000,000us de CPU acumulados -> 4.0 núcleos.
  const samples = [
    { usageMicros: 10_000_000, atMs: 5000 },
    { usageMicros: 14_000_000, atMs: 6000 },
  ];
  const cores = computeCpuCoresPerInterval(samples);
  check("4 núcleos al tope: calcula 4.0 núcleos", Math.abs(cores[0] - 4.0) < 1e-9);
}

{
  // Varias muestras seguidas -- un valor por cada par consecutivo, nunca uno menos ni uno más.
  const samples = [
    { usageMicros: 0, atMs: 0 },
    { usageMicros: 500_000, atMs: 1000 }, // 0.5 núcleos
    { usageMicros: 2_000_000, atMs: 2000 }, // 1.5 núcleos
    { usageMicros: 2_100_000, atMs: 3000 }, // 0.1 núcleos
  ];
  const cores = computeCpuCoresPerInterval(samples);
  check("4 muestras -> 3 intervalos", cores.length === 3);
  check("valores correctos por intervalo", Math.abs(cores[0] - 0.5) < 1e-9 && Math.abs(cores[1] - 1.5) < 1e-9 && Math.abs(cores[2] - 0.1) < 1e-9);
}

check("sin muestras o solo 1: sin intervalos (nunca inventa un valor)", computeCpuCoresPerInterval([]).length === 0 && computeCpuCoresPerInterval([{ usageMicros: 0, atMs: 0 }]).length === 0);

// --- summarizeMetricSamples ---

{
  const summary = summarizeMetricSamples({
    memoryBytesSamples: [1024 * 1024 * 500, 1024 * 1024 * 800, 1024 * 1024 * 600],
    cpuCoreSamples: [1.0, 3.5, 2.0],
    cpuLimitCores: 4,
  });
  check("summarize: available=true cuando hay muestras", summary.available === true);
  check("summarize: pico de memoria = la muestra más alta (800MB)", summary.peakMemoryMB === 800);
  check("summarize: promedio de memoria = (500+800+600)/3 ≈ 633MB", summary.avgMemoryMB === Math.round((500 + 800 + 600) / 3));
  check("summarize: pico de CPU = 3.5 núcleos", summary.peakCpuCores === 3.5);
  check("summarize: % del límite = 3.5/4 * 100 = 87.5%", summary.peakCpuPercentOfLimit === 87.5);
  check("summarize: límite de CPU se reporta tal cual (4 núcleos)", summary.cpuLimitCores === 4);
}

check("summarize: sin ninguna muestra -> available=false (nunca cifras inventadas)", summarizeMetricSamples({ memoryBytesSamples: [], cpuCoreSamples: [], cpuLimitCores: 4 }).available === false);

{
  // Sin límite de CPU conocido (cgroup sin tope, "max"): el % del límite queda null, no un número inventado con un denominador falso.
  const summary = summarizeMetricSamples({ memoryBytesSamples: [1000], cpuCoreSamples: [2.0], cpuLimitCores: null });
  check("summarize: sin cpuLimitCores conocido, el % del límite queda null (nunca inventado)", summary.peakCpuPercentOfLimit === null && summary.avgCpuPercentOfLimit === null);
  check("summarize: los núcleos usados sí se reportan aunque no se conozca el límite", summary.peakCpuCores === 2.0);
}

// --- Lecturas reales (best-effort, fail-safe si no hay cgroup -- esta Mac no lo tiene) ---

{
  const mem = await readContainerMemoryBytes("/ruta/que/no/existe");
  check("readContainerMemoryBytes con ruta inexistente: devuelve null, nunca lanza", mem === null);
}
{
  const limit = await readContainerCpuLimitCores("/ruta/que/no/existe");
  check("readContainerCpuLimitCores con ruta inexistente: devuelve null, nunca lanza", limit === null);
}
{
  const usage = await readContainerCpuUsageMicros("/ruta/que/no/existe");
  check("readContainerCpuUsageMicros con ruta inexistente: devuelve null, nunca lanza", usage === null);
}

console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
process.exit(failures === 0 ? 0 : 1);
