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
import { buildRenderArgs } from "./render-worker.mjs";
import { killProcessGroup, countAliveProcessesInGroup } from "./process-tree.mjs";
import { createMilestoneTracker } from "./verbose-log-milestones.mjs";

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

/**
 * Decide el rango de `--frames` para el diagnóstico -- pura. Primeros
 * `initialFrameCount` cuadros SIEMPRE (el arranque: navegador,
 * bundling, composición, primer cuadro del video fuente); si el video
 * tiene más cuadros que eso, agrega una ventana de
 * `middleWindowFrameCount` cuadros centrada en la mitad del video
 * (criterio 3: "si te parece útil, una ventana en medio del video" --
 * útil porque el job real que motivó esta tarea se atascó bien
 * entrado el video, no en el arranque; ver esa ventana aparte ayuda a
 * distinguir "el arranque funciona, algo del medio no" de "nada
 * funciona"). Si el video es tan corto que la ventana intermedia se
 * superpondría con el inicio, se omite (nunca se arma un rango
 * inválido o duplicado).
 */
export const buildDiagnosticFrameRanges = (totalFrames, { initialFrameCount = 30, middleWindowFrameCount = 30 } = {}) => {
  if (!Number.isFinite(totalFrames) || totalFrames <= 0) return null;
  const initialEnd = Math.min(initialFrameCount, totalFrames) - 1;
  const initialRange = `0-${initialEnd}`;
  const middleStart = Math.floor(totalFrames / 2);
  if (middleStart <= initialEnd + 1) return initialRange;
  const middleEnd = Math.min(middleStart + middleWindowFrameCount - 1, totalFrames - 1);
  return `${initialRange},${middleStart}-${middleEnd}`;
};

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
        tracker.feed(line.replace(ANSI_PATTERN, ""), Date.now() - startedAt);
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
