// PRUEBA SIMULADA (nivel 2 de honestidad de evidencia, CLAUDE.md) --
// server/verbose-log-milestones.mjs: clasificación pura de líneas,
// probada contra las líneas REALES capturadas en GitHub Actions
// (09-nov-2026, run 42562623810, `npx remotion render --log=verbose`
// contra @remotion/cli 4.0.538) -- no inventadas, copiadas tal cual
// del log real (con sus códigos ANSI de verdad), para que esta prueba
// confirme el parser contra lo que el binario real imprime, no contra
// un formato adivinado.

import { classifyVerboseLine, createMilestoneTracker, MILESTONE_ORDER } from "./verbose-log-milestones.mjs";

let failures = 0;
const check = (label, cond, detail = "") => {
  if (!cond) {
    failures++;
    console.log(`FAIL: ${label}${detail ? ` -- ${detail}` : ""}`);
  } else {
    console.log(`ok: ${label}`);
  }
};

// Líneas reales, copiadas tal cual (con códigos ANSI) del run 42562623810.
const REAL_LINES = {
  browserLaunch:
    "\x1b[40m openBrowser() \x1b[49m \x1b[90mOpening browser: gl = null, executable = /home/runner/work/video-factory/video-factory/node_modules/.remotion/chrome-headless-shell/linux64/chrome-headless-shell-linux64/chrome-headless-shell, enableMultiProcessOnLinux = true\x1b[39m",
  bundlingDone: "\x1b[90mBundling done in 1382ms\x1b[39m",
  metadataLoaded: "\x1b[40m selectComposition() \x1b[49m \x1b[90mcalculateMetadata() took 8ms\x1b[39m",
  renderStarted: "\x1b[40m renderMedia() \x1b[49m \x1b[90mRendering frames 0-9, 290-299\x1b[39m",
  sourceOpened:
    "\x1b[40m compositor \x1b[49m \x1b[90mOpening new stream on thread 0, src = http://localhost:3000/public/jobs/explore-verbose/base.mp4, index = 0, desired time = 0\x1b[39m",
  firstFrame: "\x1b[40m compositor \x1b[49m \x1b[90mThread 0, stream 0 - received frame, tone_mapped = true\x1b[39m",
  // Líneas reales que NO deberían clasificarse como ningún hito (ruido normal del log verbose).
  bundlingPercent: "Bundling 62%",
  unrelated: "\x1b[90mAvailable memory: 14857.50 MiB (/proc/meminfo MemAvailable)\x1b[39m",
};

check("browser-launch-requested reconocido en la línea real de openBrowser()", classifyVerboseLine(REAL_LINES.browserLaunch) === "browser-launch-requested");
check("bundling-done reconocido en la línea real 'Bundling done in Xms'", classifyVerboseLine(REAL_LINES.bundlingDone) === "bundling-done");
check("composition-metadata-loaded reconocido en la línea real de calculateMetadata()", classifyVerboseLine(REAL_LINES.metadataLoaded) === "composition-metadata-loaded");
check("render-started reconocido en la línea real de renderMedia()/Rendering frames", classifyVerboseLine(REAL_LINES.renderStarted) === "render-started");
check("source-video-opened reconocido en la línea real del compositor abriendo el stream", classifyVerboseLine(REAL_LINES.sourceOpened) === "source-video-opened");
check("source-video-first-frame reconocido en la línea real 'received frame'", classifyVerboseLine(REAL_LINES.firstFrame) === "source-video-first-frame");

check("línea de progreso normal ('Bundling 62%') no se confunde con ningún hito", classifyVerboseLine(REAL_LINES.bundlingPercent) === null);
check("línea de ruido no relacionada no se confunde con ningún hito", classifyVerboseLine(REAL_LINES.unrelated) === null);

// --- createMilestoneTracker: orden real de llegada, primer momento visto, nunca sobrescribe ---

{
  const tracker = createMilestoneTracker();
  tracker.feed(REAL_LINES.browserLaunch, 10);
  tracker.feed(REAL_LINES.bundlingDone, 1400);
  tracker.feed(REAL_LINES.metadataLoaded, 1420);
  tracker.feed(REAL_LINES.renderStarted, 1500);
  tracker.feed(REAL_LINES.sourceOpened, 1510);
  tracker.feed(REAL_LINES.firstFrame, 1520);
  const summary = tracker.summary();
  check("los 6 hitos quedan con su primer momento visto (ms desde el inicio)", MILESTONE_ORDER.every((m) => summary[m] !== null));
  check(
    "browser-launch-requested quedó en 10ms, source-video-first-frame en 1520ms (orden correcto)",
    summary["browser-launch-requested"] === 10 && summary["source-video-first-frame"] === 1520,
  );
}

{
  // Un hito que nunca llega (p.ej. el render se detuvo antes de abrir el video fuente) queda null -- "dónde se detiene" del criterio 3.
  const tracker = createMilestoneTracker();
  tracker.feed(REAL_LINES.browserLaunch, 10);
  tracker.feed(REAL_LINES.bundlingDone, 1400);
  const summary = tracker.summary();
  check("hitos nunca vistos quedan en null (nunca un valor inventado)", summary["render-started"] === null && summary["source-video-opened"] === null);
  check("hitos SÍ vistos antes del corte quedan con su momento real", summary["bundling-done"] === 1400);
}

{
  // Si la misma línea (p.ej. "received frame") se repite muchas veces (es normal, hay una por cuadro), el tracker guarda el PRIMER momento, no el último.
  const tracker = createMilestoneTracker();
  tracker.feed(REAL_LINES.firstFrame, 1520);
  tracker.feed(REAL_LINES.firstFrame, 1600);
  tracker.feed(REAL_LINES.firstFrame, 1700);
  check("líneas repetidas: se conserva el PRIMER momento visto, no se sobrescribe con los siguientes", tracker.summary()["source-video-first-frame"] === 1520);
}

console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
process.exit(failures === 0 ? 0 : 1);
