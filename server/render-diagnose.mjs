// Render de diagnóstico (Fase 0, causa raíz con evidencia del VPS,
// 09-nov-2026, autorizado por Alex, criterio 3). Objetivo: ejecutar,
// sobre el video base y el job.json YA persistidos de un job
// existente, un render MUY corto (los primeros cuadros y una ventana
// en el medio del video, vía `--frames`, confirmado contra la
// documentación oficial de `npx remotion render` -- no asumido) con
// `--log=verbose` SOLO en este modo, para ver hitos concretos del
// arranque (navegador, bundling, composición, video fuente) sin
// comprometerse al render completo ni tocar el estado del job real.
//
// Deliberadamente separado de `runRemotionRender` (el render real de
// producción): ese tiene su propio vigilante de atasco/timeout largo,
// pensado para un render de horas -- el de diagnóstico es otra cosa,
// acotado a minutos, con su propio timeout corto y sin vigilante de
// atasco (si no completa en el timeout, YA es evidencia -- "se quedó
// en X" es la respuesta, no un error que corregir con reintentos).
//
// Pura orquestación, sin tocar `jobs`/`runningChildren`/`writeStatus`
// -- eso es responsabilidad exclusiva del endpoint en index.mjs (igual
// que runRemotionRender). Esto permite probarlo con un video sintético
// real en CI sin levantar el servidor completo.
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { buildRenderArgs, parseRenderProgressLine } from "./render-worker.mjs";
import { killProcessGroup, countAliveProcessesInGroup } from "./process-tree.mjs";
import { createMilestoneTracker } from "./verbose-log-milestones.mjs";

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

/**
 * Decide las ventanas de `--frames` para el diagnóstico -- pura.
 * Primeros `initialFrameCount` cuadros SIEMPRE (el arranque:
 * navegador, bundling, composición, primer cuadro del video fuente);
 * si el video tiene más cuadros, agrega una ventana en la MITAD
 * (`middleWindowFrameCount`) y otra cerca del FINAL
 * (`endFrameCount`) -- criterio 1 de la tarea "reducir el tiempo de
 * render": medir con ventanas representativas de inicio, medio y
 * final, no solo los primeros cuadros (el job real que motivó la
 * tarea anterior se atascó bien entrado el video, no en el arranque).
 * Cada ventana que se superpondría o quedaría pegada a la anterior se
 * omite (nunca un rango inválido, duplicado o de tamaño negativo).
 *
 * Devuelve el array de ventanas CON su posición dentro de la
 * selección COMBINADA (`combinedStart`/`combinedEnd`, 0-based,
 * inclusive) -- es el mismo índice que Remotion reporta en "Rendered
 * N/TOTAL" cuando `--frames` tiene varios rangos (confirmado real en
 * CI, tarea anterior: con `--frames=0-9,290-299` el total pasó a ser
 * 20, no 300, y N corre 0..19 de forma continua a través de los dos
 * rangos). Esto es lo que permite, más abajo, atribuirle cada tick de
 * progreso a la ventana (inicio/medio/final) correcta.
 */
export const buildDiagnosticWindows = (totalFrames, { initialFrameCount = 30, middleWindowFrameCount = 30, endFrameCount = 30 } = {}) => {
  if (!Number.isFinite(totalFrames) || totalFrames <= 0) return [];
  const windows = [];
  let combinedCursor = 0;

  const tryAddWindow = (label, start, end) => {
    const lastWindow = windows[windows.length - 1];
    if (lastWindow && start <= lastWindow.end) return; // se superpondría o quedaría pegada -- se omite, nunca un rango inválido/duplicado
    const frameCount = end - start + 1;
    windows.push({ label, start, end, combinedStart: combinedCursor, combinedEnd: combinedCursor + frameCount - 1 });
    combinedCursor += frameCount;
  };

  tryAddWindow("inicio", 0, Math.min(initialFrameCount, totalFrames) - 1);

  const middleStart = Math.floor(totalFrames / 2);
  const middleEnd = Math.min(middleStart + middleWindowFrameCount - 1, totalFrames - 1);
  tryAddWindow("medio", middleStart, middleEnd);

  const endStart = Math.max(0, totalFrames - endFrameCount);
  tryAddWindow("final", endStart, totalFrames - 1);

  return windows;
};

/** Compatibilidad -- la cadena de `--frames` sola, derivada de `buildDiagnosticWindows`. */
export const buildDiagnosticFrameRanges = (totalFrames, opts) => {
  const windows = buildDiagnosticWindows(totalFrames, opts);
  return windows.length > 0 ? windows.map((w) => `${w.start}-${w.end}`).join(",") : null;
};

/**
 * A partir de los ticks reales de progreso ("Rendered N/TOTAL",
 * `renderedFrames` = N en el índice COMBINADO) y las ventanas de
 * `buildDiagnosticWindows`, calcula el tiempo PROMEDIO por cuadro
 * dentro de cada ventana -- usa el DELTA entre el primer y el último
 * tick VISTO en esa ventana (nunca el tiempo desde el arranque del
 * proceso), así el costo de arranque (navegador/bundling, que ocurre
 * ANTES del primer tick de la ventana de inicio) nunca se mezcla con
 * el costo sostenido por cuadro -- es justo lo que pide el criterio 1
 * ("dónde se va el tiempo", no solo el total). `null` en una ventana
 * con menos de 2 ticks reales -- nunca un promedio inventado con un
 * solo dato.
 */
export const computeWindowTimings = (progressTicks, windows) =>
  windows.map((w) => {
    const ticksInWindow = progressTicks.filter((t) => t.renderedFrames >= w.combinedStart && t.renderedFrames <= w.combinedEnd).sort((a, b) => a.elapsedMs - b.elapsedMs);
    if (ticksInWindow.length < 2) {
      return { label: w.label, frameCount: w.end - w.start + 1, sampledTicks: ticksInWindow.length, avgMsPerFrame: null };
    }
    const first = ticksInWindow[0];
    const last = ticksInWindow[ticksInWindow.length - 1];
    const frameDelta = last.renderedFrames - first.renderedFrames;
    const msDelta = last.elapsedMs - first.elapsedMs;
    return {
      label: w.label,
      frameCount: w.end - w.start + 1,
      sampledTicks: ticksInWindow.length,
      avgMsPerFrame: frameDelta > 0 ? Math.round((msDelta / frameDelta) * 100) / 100 : null,
    };
  });

/**
 * Corre el render de diagnóstico y devuelve TODA la evidencia
 * capturada -- nunca rechaza la promesa por un render que no completa
 * o que sale con error: eso ES la evidencia que se quiere ver
 * (criterio 3: "debe responder con evidencia... y dónde se detiene"),
 * no un fallo de la herramienta misma. Solo un error de la herramienta
 * (p.ej. no se pudo lanzar el proceso) deja `launchError` puesto.
 */
export const runDiagnosticRender = ({
  npxCommand = "npx",
  cwd,
  env,
  compositionId = "VideoEngine",
  propsJobFile,
  outputPath,
  concurrency = "1",
  enableMultiprocessOnLinux = false,
  browserExecutable,
  binariesDirectory,
  frames,
  // Metadata de `buildDiagnosticWindows` (criterio 1) -- si se da,
  // además de `frames` (derivado de las mismas ventanas), el
  // resultado trae `windowTimings`: ms/cuadro reales por ventana
  // (inicio/medio/final), no solo el total. Opcional: sin esto, el
  // diagnóstico sigue funcionando igual que antes (solo hitos).
  windows,
  timeoutMs = 120_000,
  maxCapturedChars = 50_000,
}) =>
  new Promise((resolve) => {
    const args = buildRenderArgs({
      compositionId,
      outputPath,
      propsJobFile,
      concurrency,
      enableMultiprocessOnLinux,
      browserExecutable,
      binariesDirectory,
      frames,
      logLevel: "verbose",
    });
    const startedAt = Date.now();
    let child;
    try {
      // detached:true -- mismo mecanismo que runRemotionRender (ver
      // process-tree.mjs): permite cortar TODO el árbol (Chrome
      // incluido) sin arriesgar al servidor, y contar huérfanos igual.
      child = spawn(npxCommand, args, { cwd, env, detached: true });
    } catch (err) {
      resolve({ launchError: String(err?.message ?? err), args });
      return;
    }

    const tracker = createMilestoneTracker();
    const progressTicks = [];
    let stdoutCaptured = "";
    let stderrCaptured = "";
    let stdoutLineBuffer = "";
    let timedOut = false;
    let settled = false;

    const finish = async (result) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      // Por si el proceso no cerró solo (p.ej. se está resolviendo por
      // timeout) -- siempre se asegura que no quede nada vivo antes
      // de devolver la evidencia, mismo mecanismo que el render real.
      killProcessGroup(child, "SIGTERM");
      await new Promise((r) => setTimeout(r, 500));
      killProcessGroup(child, "SIGKILL");
      await new Promise((r) => setTimeout(r, 500));
      const descendantProcessesAliveAfterCut = typeof child.pid === "number" ? await countAliveProcessesInGroup(child.pid) : null;
      await fs.rm(outputPath, { force: true }).catch(() => {});
      resolve({
        ...result,
        elapsedMs: Date.now() - startedAt,
        milestones: tracker.summary(),
        windowTimings: windows ? computeWindowTimings(progressTicks, windows) : undefined,
        stdoutTail: stdoutCaptured,
        stderrTail: stderrCaptured,
        descendantProcessesAliveAfterCut,
        args,
      });
    };

    child.stderr.on("data", (chunk) => {
      stderrCaptured = (stderrCaptured + chunk.toString("utf8")).slice(-maxCapturedChars);
    });

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdoutCaptured = (stdoutCaptured + text).slice(-maxCapturedChars);
      stdoutLineBuffer += text;
      const lines = stdoutLineBuffer.split("\n");
      stdoutLineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const cleanLine = line.replace(ANSI_PATTERN, "");
        tracker.feed(cleanLine, Date.now() - startedAt);
        const progressEvent = parseRenderProgressLine(cleanLine);
        if (progressEvent && progressEvent.stage === "rendering") {
          progressTicks.push({ renderedFrames: progressEvent.renderedFrames, elapsedMs: Date.now() - startedAt });
        }
      }
    });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      void finish({ completed: false, timedOut: true, exitCode: null, exitSignal: null });
    }, timeoutMs);

    child.on("close", (code, signal) => {
      if (timedOut) return; // ya se resolvió por timeout -- el "close" que llega después no debe pisar esa evidencia
      void finish({ completed: code === 0, timedOut: false, exitCode: code, exitSignal: signal });
    });
    child.on("error", (err) => {
      if (timedOut) return;
      void finish({ completed: false, timedOut: false, exitCode: null, exitSignal: null, spawnError: String(err?.message ?? err) });
    });
  });
