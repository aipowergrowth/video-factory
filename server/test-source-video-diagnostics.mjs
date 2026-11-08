// PRUEBA SIMULADA (nivel 2 de honestidad de evidencia, CLAUDE.md) --
// server/source-video-diagnostics.mjs: solo la lógica pura
// (clasificación de riesgo de intervalo de keyframes, formateo de la
// línea de log), con datos inyectados -- sin ffprobe real. La
// confirmación de que ffprobe de verdad devuelve estos campos con
// estos nombres, contra un video sintético con verdad conocida, vive
// en test-render-observability.mjs (CI, FFmpeg/Chrome reales) --
// probarlo acá con un ffprobe simulado no agregaría nada que ese test
// no cubra ya contra el binario real.

import { classifyKeyframeIntervalRisk, formatSourceVideoDiagnosticsLine } from "./source-video-diagnostics.mjs";

let failures = 0;
const check = (label, cond, detail = "") => {
  if (!cond) {
    failures++;
    console.log(`FAIL: ${label}${detail ? ` -- ${detail}` : ""}`);
  } else {
    console.log(`ok: ${label}`);
  }
};

// --- classifyKeyframeIntervalRisk ---

check("intervalo null (sin keyframes/duración conocida) -> desconocido", classifyKeyframeIntervalRisk(null) === "desconocido");
check("intervalo 0s -> bajo", classifyKeyframeIntervalRisk(0) === "bajo");
check("intervalo 2s (borde) -> bajo", classifyKeyframeIntervalRisk(2) === "bajo");
check("intervalo 2.01s (justo sobre el borde) -> medio", classifyKeyframeIntervalRisk(2.01) === "medio");
check("intervalo 6s (borde) -> medio", classifyKeyframeIntervalRisk(6) === "medio");
check("intervalo 6.01s (justo sobre el borde) -> alto", classifyKeyframeIntervalRisk(6.01) === "alto");
check("intervalo 60s (un solo keyframe en un video largo) -> alto", classifyKeyframeIntervalRisk(60) === "alto");

// --- formatSourceVideoDiagnosticsLine ---

{
  const line = formatSourceVideoDiagnosticsLine({
    codec: "h264",
    width: 1920,
    height: 1080,
    durationSeconds: 1380.5,
    bitRateBps: 8_500_000,
    sizeBytes: 1_450_000_000,
    rFrameRate: "30/1",
    avgFrameRate: "30/1",
    likelyVfr: false,
    totalPackets: 41331,
    keyframeCount: 2,
    avgKeyframeIntervalSeconds: 690.25,
    keyframeIntervalRisk: "alto",
  });
  check("línea incluye códec y resolución", line.includes("códec=h264") && line.includes("1920x1080"));
  check("línea incluye duración formateada a 1 decimal", line.includes("duración=1380.5s"));
  check("línea incluye tamaño en MB", line.includes("tamaño=1382.8MB"));
  check("línea incluye bitrate en kbps", line.includes("bitrate=8500kbps"));
  check("fps constante: NO marca posible FPS variable", line.includes("(fps constante)") && !line.includes("POSIBLE FPS VARIABLE"));
  check("línea incluye conteo de keyframes y riesgo alto", line.includes("keyframes=2/41331 cuadros") && line.includes("riesgo de lentitud/cuelgue en OffthreadVideo: alto"));
}

{
  // FPS declarado y promedio distintos -> advertencia de posible FPS variable (heurística, no una medición exacta de VFR).
  const line = formatSourceVideoDiagnosticsLine({
    codec: "h264",
    width: 1280,
    height: 720,
    durationSeconds: 60,
    bitRateBps: 2_000_000,
    sizeBytes: 15_000_000,
    rFrameRate: "30/1",
    avgFrameRate: "29/1",
    likelyVfr: true,
    totalPackets: 1800,
    keyframeCount: 60,
    avgKeyframeIntervalSeconds: 1,
    keyframeIntervalRisk: "bajo",
  });
  check("fps declarado != promedio: SÍ marca posible FPS variable", line.includes("POSIBLE FPS VARIABLE"));
}

{
  // Todos los campos desconocidos (p.ej. el probe no pudo leer nada útil) -- nunca revienta, nunca inventa un número, usa "?".
  const line = formatSourceVideoDiagnosticsLine({
    codec: null,
    width: null,
    height: null,
    durationSeconds: null,
    bitRateBps: null,
    sizeBytes: null,
    rFrameRate: null,
    avgFrameRate: null,
    likelyVfr: false,
    totalPackets: 0,
    keyframeCount: 0,
    avgKeyframeIntervalSeconds: null,
    keyframeIntervalRisk: "desconocido",
  });
  check("todos los campos desconocidos: usa '?' en vez de inventar valores, nunca lanza", line.includes("códec=?") && line.includes("tamaño=?MB") && line.includes("bitrate=?kbps"));
}

console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
process.exit(failures === 0 ? 0 : 1);
