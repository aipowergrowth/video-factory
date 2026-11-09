// Corrección del vigilante de render (Fase 0, 08-nov-2026, autorizado
// por Alex) -- revisión del operador contra f157a65 confirmó dos
// defectos reales en cómo se cortaba un render (atasco, timeout,
// cancelación):
//
// 1. El hijo se lanzaba con `spawn(...)` sin `detached: true`, así que
//    quedaba en el MISMO grupo de procesos que el servidor -- nunca se
//    podía señalar "todo el árbol" sin arriesgar señalar al servidor
//    mismo. `detached: true` hace que el hijo (`npx`) sea el LÍDER de
//    un grupo de procesos nuevo (pgid = su propio pid); sus
//    descendientes (el compositor de Remotion, Chrome, los
//    subprocesos de Chrome) heredan ese mismo pgid salvo que alguno
//    llame a `setpgid` por su cuenta -- eso se confirma empíricamente
//    en Linux, no se asume (ver test-render-observability.mjs).
// 2. `child.kill(signal)` solo señala al proceso `npx` directo, nunca
//    al grupo -- por eso `killProcessGroup` usa `process.kill(-pid,
//    signal)` (pid negativo = todo el grupo, semántica estándar de
//    POSIX), con `child.kill(signal)` como respaldo si el grupo ya no
//    existe (ESRCH) o si `child.pid` no es válido.
//
// `countAliveProcessesInGroup` lee /proc directamente (sin depender
// de que `ps`/`pgrep` estén instalados en la imagen) para poder
// confirmar, después de cortar un render, cuántos procesos de ese
// grupo siguen vivos -- idealmente 0. No existe /proc en macOS (esta
// máquina de desarrollo) -- ahí devuelve `null`, nunca inventa un
// número ni lanza (mismo patrón fail-safe que container-metrics.mjs).
import fs from "node:fs/promises";

/**
 * Extrae el pgrp (grupo de procesos) de una línea cruda de
 * /proc/[pid]/stat -- pura, sin tocar disco, para poder probarla con
 * líneas fabricadas (nivel 2 de honestidad de evidencia). El campo
 * "comm" (nombre del ejecutable) viene entre paréntesis y PUEDE
 * contener espacios o paréntesis propios (p.ej. "(remotion (render))")
 * -- por eso se busca el ÚLTIMO ")" de la línea en vez de partir por
 * espacios desde el principio; todo lo que sigue a ese ")" son los
 * campos numéricos en orden fijo: state ppid pgrp session ...
 */
export const parsePgrpFromStatLine = (rawStatLine) => {
  const closeParenIndex = rawStatLine.lastIndexOf(")");
  if (closeParenIndex === -1) return null;
  const fields = rawStatLine.slice(closeParenIndex + 1).trim().split(/\s+/);
  const pgrp = Number(fields[2]); // [0]=state [1]=ppid [2]=pgrp
  return Number.isFinite(pgrp) ? pgrp : null;
};

/**
 * Cuenta cuántos procesos vivos pertenecen al grupo `pgid` --
 * confirma (o refuta) que no quedó ningún descendiente huérfano del
 * render tras cortarlo. `pgid` es el pid del proceso que se lanzó con
 * `detached: true` (su propio pid = el pgid de todo su árbol, mientras
 * ninguno de sus descendientes haga `setpgid` por su cuenta).
 */
export const countAliveProcessesInGroup = async (pgid, { procRoot = "/proc" } = {}) => {
  let entries;
  try {
    entries = await fs.readdir(procRoot);
  } catch {
    return null;
  }
  let count = 0;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const raw = await fs.readFile(`${procRoot}/${entry}/stat`, "utf8");
      if (parsePgrpFromStatLine(raw) === pgid) count++;
    } catch {
      // El proceso pudo morir entre el readdir y esta lectura -- es
      // una condición de carrera normal al leer /proc de un sistema
      // vivo, no un error real: simplemente no se cuenta.
    }
  }
  return count;
};

/**
 * Extrae pgrp + utime/stime (ticks de CPU acumulados, en modo usuario
 * y en modo kernel) de una línea cruda de /proc/[pid]/stat -- pura,
 * mismo truco del último ")" que `parsePgrpFromStatLine`. Campos
 * confirmados contra `man proc` (orden fijo tras el "comm"): state(0)
 * ppid(1) pgrp(2) session(3) tty_nr(4) tpgid(5) flags(6) minflt(7)
 * cminflt(8) majflt(9) cmajflt(10) utime(11) stime(12) ...
 *
 * Causa raíz con evidencia (Fase 0, 09-nov-2026, autorizado por Alex,
 * criterio 6): esto es lo que permite distinguir "proceso realmente
 * colgado" de "proceso ocupado pero sin terminar un cuadro" -- si
 * utime+stime no sube entre dos lecturas, el proceso no usó NADA de
 * CPU en ese intervalo (coincide con el issue público de Remotion
 * #11864, "every process at 0% CPU"); si sube, está haciendo algo
 * (bundling, lanzando el navegador, decodificando keyframes
 * dispersos) aunque el contador de cuadros siga en 0.
 */
export const parseStatCpuFields = (rawStatLine) => {
  const closeParenIndex = rawStatLine.lastIndexOf(")");
  if (closeParenIndex === -1) return null;
  const fields = rawStatLine.slice(closeParenIndex + 1).trim().split(/\s+/);
  const pgrp = Number(fields[2]);
  const utimeTicks = Number(fields[11]);
  const stimeTicks = Number(fields[12]);
  if (!Number.isFinite(pgrp) || !Number.isFinite(utimeTicks) || !Number.isFinite(stimeTicks)) return null;
  return { pgrp, utimeTicks, stimeTicks };
};

/**
 * Suma utime+stime de TODOS los procesos vivos del grupo `pgid` --
 * ticks de CPU acumulados desde que cada proceso existe (no un
 * promedio ni un porcentaje). Comparar dos lecturas de esto en el
 * tiempo (delta > 0 = hubo actividad real de CPU en ese intervalo) es
 * la señal de "actividad" del vigilante rediseñado. `null` si no hay
 * /proc (macOS de desarrollo) -- nunca un número inventado.
 */
export const sumGroupCpuTicks = async (pgid, { procRoot = "/proc" } = {}) => {
  let entries;
  try {
    entries = await fs.readdir(procRoot);
  } catch {
    return null;
  }
  let totalTicks = 0;
  let matched = false;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const raw = await fs.readFile(`${procRoot}/${entry}/stat`, "utf8");
      const parsed = parseStatCpuFields(raw);
      if (parsed && parsed.pgrp === pgid) {
        totalTicks += parsed.utimeTicks + parsed.stimeTicks;
        matched = true;
      }
    } catch {
      // Condición de carrera normal (el proceso murió entre el
      // readdir y esta lectura) -- no es un error real, se ignora.
    }
  }
  // Ningún proceso vivo en el grupo todavía (p.ej. justo tras el
  // spawn, antes de que /proc tenga la entrada) es distinto de "0
  // ticks medidos" -- se reporta null, no 0, para no leerse como
  // "actividad cero confirmada" cuando en realidad no se pudo medir
  // nada todavía.
  return matched ? totalTicks : null;
};

/**
 * Termina TODO el grupo de procesos de `child` (no solo el proceso
 * directo) -- requiere que se haya lanzado con `detached: true`. Si el
 * grupo ya no existe (ya terminó, ESRCH) o `child.pid` no es válido,
 * cae de respaldo a señalar solo el proceso directo -- nunca lanza.
 */
export const killProcessGroup = (child, signal) => {
  if (typeof child?.pid !== "number") return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // El proceso ya no existe de ninguna forma -- nada que hacer.
    }
  }
};
