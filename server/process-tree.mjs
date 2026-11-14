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
 * Extrae el ESTADO (un solo carácter -- R corriendo, S durmiendo, D
 * esperando E/S sin poder recibir señales, Z zombi ya muerto
 * esperando que el padre lo recoja, T detenido) de una línea cruda de
 * /proc/[pid]/stat -- mismo truco del último ")". Causa raíz con
 * evidencia (10-nov-2026, criterio 6): "sigue vivo" no distingue un
 * proceso realmente corriendo de un zombi (ya terminado, inofensivo,
 * solo pendiente de que el padre lo recoja) de uno genuinamente
 * atascado en E/S (D) -- que SIGKILL no puede terminar hasta que esa
 * E/S se resuelva, por diseño del kernel, no por un defecto de este
 * mecanismo.
 */
export const parseStatStateField = (rawStatLine) => {
  const closeParenIndex = rawStatLine.lastIndexOf(")");
  if (closeParenIndex === -1) return null;
  const fields = rawStatLine.slice(closeParenIndex + 1).trim().split(/\s+/);
  return fields[0] || null;
};

/**
 * Nombre corto (/proc/[pid]/comm) y línea de comando completa con
 * argumentos (/proc/[pid]/cmdline, los `\0` se unen con espacios) de
 * un proceso -- `null` en cualquiera que no se pueda leer (el proceso
 * pudo morir justo al leerlo, o ya no existe) en vez de lanzar.
 */
const readProcessIdentity = async (pid, procRoot) => {
  let comm = null;
  let cmdline = null;
  try {
    comm = (await fs.readFile(`${procRoot}/${pid}/comm`, "utf8")).trim();
  } catch {
    // No se pudo leer -- queda null, nunca inventado.
  }
  try {
    const raw = await fs.readFile(`${procRoot}/${pid}/cmdline`, "utf8");
    cmdline = raw.split("\0").filter(Boolean).join(" ") || null;
  } catch {
    // No se pudo leer -- queda null, nunca inventado.
  }
  return { comm, cmdline };
};

/**
 * Como `countAliveProcessesInGroup`, pero con el DETALLE de cada
 * proceso vivo del grupo -- pid, estado, nombre corto y línea de
 * comando completa -- para saber QUÉ son los descendientes que
 * sobrevivieron a un corte, no solo cuántos (criterio 6, causa raíz
 * con evidencia, 10-nov-2026). `null` si no hay /proc (macOS de
 * desarrollo) -- nunca una lista inventada.
 */
export const listAliveProcessesInGroup = async (pgid, { procRoot = "/proc" } = {}) => {
  let entries;
  try {
    entries = await fs.readdir(procRoot);
  } catch {
    return null;
  }
  const alive = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const raw = await fs.readFile(`${procRoot}/${entry}/stat`, "utf8");
      if (parsePgrpFromStatLine(raw) === pgid) {
        const state = parseStatStateField(raw);
        const { comm, cmdline } = await readProcessIdentity(entry, procRoot);
        alive.push({ pid: Number(entry), state, comm, cmdline });
      }
    } catch {
      // El proceso pudo morir entre el readdir y esta lectura -- no
      // es un error real, simplemente no se incluye.
    }
  }
  return alive;
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
 *
 * LIMITACIÓN REAL (encontrada 14-nov-2026 con el código instalado de
 * Remotion 4.0.538, no asumida): Remotion lanza Chrome con
 * `detached: true` (`@remotion/renderer/dist/browser/BrowserRunner.js`,
 * línea 87: `detached: process.platform !== 'win32'`), así que Chrome
 * y sus subprocesos viven en OTRO grupo de procesos -- esta función no
 * los alcanza, y `sumGroupCpuTicks`/`listAliveProcessesInGroup` no los
 * ven. Por eso existen las variantes por ÁRBOL de más abajo
 * (`killProcessTree`, `sumProcessTreeCpuTicks`), que siguen la cadena
 * de ppid en vez del pgrp. Esta función se conserva como primer paso
 * de `killProcessTree` y para compatibilidad.
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

// --------------------------------------------------------------------
// Variantes por ÁRBOL de procesos (cadena de ppid), 14-nov-2026.
//
// Causa raíz con evidencia (código instalado, no supuesto): Remotion
// lanza Chrome con `detached: true` (ver arriba), así que el navegador
// -- que es quien hace el trabajo pesado entre "bundling listo" y el
// primer cuadro, y quien decodifica el video fuente -- NO pertenece al
// grupo de procesos del render. Consecuencias reales:
//   1. El vigilante por grupo (`sumGroupCpuTicks`) puede ver 0 ticks
//      mientras Chrome sí trabaja: el proceso Node de Remotion espera
//      al navegador sin gastar CPU. Explica el fallo reproducible del
//      caso 7 de test-render-observability.mjs ("0 min sin actividad"
//      justo tras bundling 100%).
//   2. El conteo de huérfanos por grupo nunca podía ver un Chrome
//      sobreviviente -- "0 descendientes vivos" solo probaba que el
//      grupo de npx/node murió.
// La cadena ppid sí une todo: npx -> node (remotion) -> chrome
// (ppid = node) -> subprocesos de chrome. Después de matar a node, sus
// hijos se re-adoptan por init (ppid=1) y la cadena se rompe -- por
// eso el corte toma primero una FOTO del árbol (pids + tiempo de
// arranque, para no confundir un pid reutilizado) y el chequeo
// posterior de supervivientes se hace contra esa foto, no contra el
// árbol vivo.
// --------------------------------------------------------------------

/**
 * Parsea una línea completa de /proc/[pid]/stat -- pura. Campos tras
 * el ÚLTIMO ")" (orden fijo, `man proc`): state(0) ppid(1) pgrp(2)
 * session(3) tty_nr(4) tpgid(5) flags(6) minflt(7) cminflt(8)
 * majflt(9) cmajflt(10) utime(11) stime(12) cutime(13) cstime(14)
 * priority(15) nice(16) num_threads(17) itrealvalue(18) starttime(19).
 */
export const parseStatLine = (rawStatLine) => {
  const openParenIndex = rawStatLine.indexOf("(");
  const closeParenIndex = rawStatLine.lastIndexOf(")");
  if (openParenIndex === -1 || closeParenIndex === -1 || closeParenIndex < openParenIndex) return null;
  const pid = Number(rawStatLine.slice(0, openParenIndex).trim());
  const comm = rawStatLine.slice(openParenIndex + 1, closeParenIndex);
  const fields = rawStatLine.slice(closeParenIndex + 1).trim().split(/\s+/);
  const state = fields[0] || null;
  const ppid = Number(fields[1]);
  const pgrp = Number(fields[2]);
  const utimeTicks = Number(fields[11]);
  const stimeTicks = Number(fields[12]);
  const startTimeTicks = Number(fields[19]);
  if (![pid, ppid, pgrp, utimeTicks, stimeTicks].every(Number.isFinite)) return null;
  return { pid, comm, state, ppid, pgrp, utimeTicks, stimeTicks, startTimeTicks: Number.isFinite(startTimeTicks) ? startTimeTicks : null };
};

/** Lee /proc completo una sola vez -> Map pid -> parseStatLine. `null` sin /proc (macOS de desarrollo). */
export const readProcessTable = async ({ procRoot = "/proc" } = {}) => {
  let entries;
  try {
    entries = await fs.readdir(procRoot);
  } catch {
    return null;
  }
  const table = new Map();
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const parsed = parseStatLine(await fs.readFile(`${procRoot}/${entry}/stat`, "utf8"));
      if (parsed) table.set(parsed.pid, parsed);
    } catch {
      // Murió entre el readdir y la lectura -- condición normal, se omite.
    }
  }
  return table;
};

/** Raíz + todos sus descendientes por cadena de ppid (BFS, raíz primero) -- pura sobre una tabla ya leída. */
export const collectProcessTree = (rootPid, table) => {
  const root = table.get(rootPid);
  if (!root) return [];
  const childrenByPpid = new Map();
  for (const p of table.values()) {
    if (!childrenByPpid.has(p.ppid)) childrenByPpid.set(p.ppid, []);
    childrenByPpid.get(p.ppid).push(p);
  }
  const result = [root];
  const queue = [rootPid];
  const seen = new Set([rootPid]);
  while (queue.length > 0) {
    const pid = queue.shift();
    for (const child of childrenByPpid.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      result.push(child);
      queue.push(child.pid);
    }
  }
  return result;
};

/**
 * Como `sumGroupCpuTicks`, pero sobre el ÁRBOL (incluye Chrome aunque
 * esté en otro grupo). `null` si no hay /proc o la raíz ya no existe.
 */
export const sumProcessTreeCpuTicks = async (rootPid, { procRoot = "/proc" } = {}) => {
  const table = await readProcessTable({ procRoot });
  if (!table) return null;
  const tree = collectProcessTree(rootPid, table);
  if (tree.length === 0) return null;
  return tree.reduce((sum, p) => sum + p.utimeTicks + p.stimeTicks, 0);
};

/** Detalle (pid, ppid, pgrp, estado, comm, cmdline) de cada proceso vivo del ÁRBOL de `rootPid`. `null` sin /proc. */
export const listAliveProcessesInTree = async (rootPid, { procRoot = "/proc" } = {}) => {
  const table = await readProcessTable({ procRoot });
  if (!table) return null;
  const tree = collectProcessTree(rootPid, table);
  const detailed = [];
  for (const p of tree) {
    const { comm, cmdline } = await readProcessIdentity(p.pid, procRoot);
    detailed.push({ pid: p.pid, ppid: p.ppid, pgrp: p.pgrp, state: p.state, comm: comm ?? p.comm, cmdline });
  }
  return detailed;
};

/** Foto del árbol (pid, pgrp, tiempo de arranque, comm) para poder verificar supervivientes DESPUÉS de cortar, cuando la cadena de ppid ya se rompió. */
export const snapshotProcessTree = async (rootPid, { procRoot = "/proc" } = {}) => {
  const table = await readProcessTable({ procRoot });
  if (!table) return null;
  return collectProcessTree(rootPid, table).map((p) => ({ pid: p.pid, pgrp: p.pgrp, startTimeTicks: p.startTimeTicks, comm: p.comm }));
};

/**
 * Qué procesos de una foto previa siguen vivos -- un pid que existe
 * pero con OTRO tiempo de arranque es un pid reutilizado por el
 * sistema, no un superviviente, y no se cuenta. `null` sin /proc.
 */
export const listSurvivorsFromSnapshot = async (snapshot, { procRoot = "/proc" } = {}) => {
  if (!snapshot) return null;
  const survivors = [];
  for (const entry of snapshot) {
    let parsed;
    try {
      parsed = parseStatLine(await fs.readFile(`${procRoot}/${entry.pid}/stat`, "utf8"));
    } catch {
      continue; // ya no existe -- es lo que se buscaba
    }
    if (!parsed) continue;
    if (entry.startTimeTicks !== null && parsed.startTimeTicks !== null && parsed.startTimeTicks !== entry.startTimeTicks) continue; // pid reutilizado
    const { comm, cmdline } = await readProcessIdentity(entry.pid, procRoot);
    survivors.push({ pid: entry.pid, ppid: parsed.ppid, pgrp: parsed.pgrp, state: parsed.state, comm: comm ?? parsed.comm, cmdline });
  }
  return survivors;
};

const lastKillSnapshots = new WeakMap();
/** Última foto tomada por `killProcessTree` para este `child` (para que quien espera el "close" pueda contar supervivientes contra ella). */
export const getLastKillSnapshot = (child) => (child && typeof child === "object" ? (lastKillSnapshots.get(child) ?? null) : null);

/**
 * Corta TODO el árbol: toma la foto, señala al grupo del hijo directo
 * (como siempre), y además a CADA proceso del árbol por su pid y a
 * cada grupo de procesos AJENO que aparezca en el árbol (el de Chrome)
 * -- así también caen subprocesos de Chrome creados entre la foto y la
 * señal. Nunca señala al grupo propio del servidor. Nunca lanza.
 * Devuelve la foto (o `null` sin /proc, en cuyo caso solo se señaló el
 * grupo directo, igual que antes).
 */
export const killProcessTree = async (child, signal, { procRoot = "/proc" } = {}) => {
  if (typeof child?.pid !== "number") return null;
  const snapshot = await snapshotProcessTree(child.pid, { procRoot });
  if (snapshot) lastKillSnapshots.set(child, snapshot);
  killProcessGroup(child, signal);
  if (!snapshot) return null;
  const ownGroup = (() => {
    try {
      return process.getpgid ? process.getpgid(process.pid) : null;
    } catch {
      return null;
    }
  })();
  const foreignGroups = new Set();
  for (const p of snapshot) {
    if (p.pgrp !== child.pid && p.pgrp > 1 && p.pgrp !== ownGroup && p.pgrp !== process.pid) foreignGroups.add(p.pgrp);
  }
  for (const pgrp of foreignGroups) {
    try {
      process.kill(-pgrp, signal);
    } catch {
      // Grupo ya inexistente -- bien.
    }
  }
  for (const p of snapshot) {
    try {
      process.kill(p.pid, signal);
    } catch {
      // Ya no existe -- bien.
    }
  }
  return snapshot;
};
