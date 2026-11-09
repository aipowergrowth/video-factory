// Render de diagnóstico (Fase 0, causa raíz con evidencia del VPS,
// 09-nov-2026, autorizado por Alex, criterio 3). Clasifica líneas de
// `npx remotion render --log=verbose` en hitos concretos del arranque
// del render -- confirmado contra una corrida REAL en GitHub Actions
// (09-nov-2026, @remotion/cli 4.0.538) antes de escribir este parser,
// no adivinado. Los textos exactos de abajo (p.ej. "Opening browser:",
// "Opening new stream on thread", "received frame") son los que
// Remotion imprime de verdad en ese nivel de log -- si una versión
// futura de Remotion cambia estos textos, esta función simplemente
// deja de reconocer la línea (devuelve null), nunca lanza ni rompe el
// render de diagnóstico.
//
// Los hitos elegidos responden directo al criterio 3 ("si el
// navegador arranca, si la composición carga, si se solicita y se
// extrae el primer cuadro del video base, y dónde se detiene"):
//   browser-launch-requested      -- Remotion pidió abrir Chrome
//   bundling-done                 -- el bundle de React/webpack terminó
//   composition-metadata-loaded   -- calculateMetadata() de la composición resolvió
//   render-started                -- renderMedia() empezó a pedir cuadros
//   source-video-opened           -- el compositor (Rust) abrió el stream del video FUENTE
//   source-video-first-frame      -- se decodificó el primer cuadro real del video fuente
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

const MILESTONE_PATTERNS = [
  { milestone: "browser-launch-requested", pattern: /openBrowser\(\).*Opening browser:/ },
  { milestone: "bundling-done", pattern: /Bundling done in \d+ms/ },
  { milestone: "composition-metadata-loaded", pattern: /calculateMetadata\(\) took \d+ms/ },
  { milestone: "render-started", pattern: /renderMedia\(\).*Rendering frames/ },
  { milestone: "source-video-opened", pattern: /compositor.*Opening new stream on thread \d+, src = / },
  { milestone: "source-video-first-frame", pattern: /compositor.*received frame/ },
];

/** Clasifica UNA línea de stdout de `--log=verbose` como hito, o `null` si no es ninguno de los reconocidos (pura, sin tocar nada). */
export const classifyVerboseLine = (rawLine) => {
  const line = rawLine.replace(ANSI_PATTERN, "");
  for (const { milestone, pattern } of MILESTONE_PATTERNS) {
    if (pattern.test(line)) return milestone;
  }
  return null;
};

/** Orden esperado de los hitos -- usado solo para presentar el resumen de forma legible, nunca para decidir nada del render. */
export const MILESTONE_ORDER = [
  "browser-launch-requested",
  "bundling-done",
  "composition-metadata-loaded",
  "render-started",
  "source-video-opened",
  "source-video-first-frame",
];

/**
 * Crea un acumulador de hitos: `feed(line, elapsedMs)` se llama por
 * cada línea de stdout real a medida que llega; `summary()` devuelve,
 * para cada hito, el primer `elapsedMs` en que se vio (o `null` si
 * nunca apareció -- el dato más importante del criterio 3: "dónde se
 * detiene").
 */
export const createMilestoneTracker = () => {
  const seenAtMs = {};
  for (const m of MILESTONE_ORDER) seenAtMs[m] = null;

  const feed = (rawLine, elapsedMs) => {
    const milestone = classifyVerboseLine(rawLine);
    if (milestone && seenAtMs[milestone] === null) {
      seenAtMs[milestone] = elapsedMs;
    }
    return milestone;
  };

  const summary = () => ({ ...seenAtMs });

  return { feed, summary };
};
