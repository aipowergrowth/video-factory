// PRUEBA SIMULADA (nivel 2 de honestidad de evidencia, CLAUDE.md) --
// server/process-tree.mjs: solo la lógica pura (parseo del pgrp de
// una línea de /proc/[pid]/stat) y el comportamiento fail-safe sin
// /proc real (macOS de desarrollo). La confirmación de que esto
// funciona de verdad contra procesos reales en Linux -- incluyendo que
// matar el grupo completo deja 0 descendientes vivos tras un render
// real -- vive en test-render-observability.mjs (CI, Linux real).

import { parsePgrpFromStatLine, countAliveProcessesInGroup, killProcessGroup, parseStatStateField, listAliveProcessesInGroup, parseStatLine, collectProcessTree, readProcessTable, sumProcessTreeCpuTicks, listSurvivorsFromSnapshot, snapshotProcessTree } from "./process-tree.mjs";

let failures = 0;
const check = (label, cond, detail = "") => {
  if (!cond) {
    failures++;
    console.log(`FAIL: ${label}${detail ? ` -- ${detail}` : ""}`);
  } else {
    console.log(`ok: ${label}`);
  }
};

// --- parsePgrpFromStatLine ---

check(
  "línea normal: pid 1234, comm 'npx', pgrp en la 3ra posición tras el ')'",
  parsePgrpFromStatLine("1234 (npx) S 1 999 999 0 -1 4194304 ...") === 999,
);

check(
  "comm con espacios y paréntesis propios ('(remotion (render))') -- usa el ÚLTIMO ')' de la línea, no el primero",
  parsePgrpFromStatLine("5678 (remotion (render)) R 1 2000 2000 0 -1 4194304 ...") === 2000,
);

check("línea sin ')' (formato inesperado): devuelve null, nunca lanza ni inventa un número", parsePgrpFromStatLine("línea corrupta sin paréntesis") === null);

check(
  "campo pgrp no numérico (formato inesperado): devuelve null",
  parsePgrpFromStatLine("1234 (npx) S 1 no-es-un-numero 999 0 -1") === null,
);

// --- countAliveProcessesInGroup (fail-safe, sin /proc real) ---

{
  const count = await countAliveProcessesInGroup(999, { procRoot: "/ruta/que/no/existe" });
  check("sin /proc disponible (ruta inexistente): devuelve null, nunca lanza ni inventa un número", count === null);
}

// --- killProcessGroup (fail-safe con un pid/objeto inválido) ---

{
  // pid inventado que casi seguro no existe -- process.kill(-pid, ...) debe fallar en silencio (catch interno), nunca lanzar hacia afuera.
  let threw = null;
  try {
    killProcessGroup({ pid: 999_999_999, kill: () => {} }, "SIGTERM");
  } catch (err) {
    threw = err;
  }
  check("pid inexistente: killProcessGroup nunca lanza (cae al respaldo en silencio)", threw === null);
}

{
  let threw = null;
  try {
    killProcessGroup({}, "SIGTERM"); // sin pid válido
  } catch (err) {
    threw = err;
  }
  check("child sin pid válido: killProcessGroup no hace nada, nunca lanza", threw === null);
}

// --- parseStatStateField: criterio 6 (causa raíz con evidencia, 10-nov-2026) ---

check("estado 'R' (corriendo): se extrae tal cual", parseStatStateField("1234 (npx) R 1 999 999 0 -1") === "R");
check("estado 'Z' (zombi): se extrae tal cual", parseStatStateField("1234 (npx) Z 1 999 999 0 -1") === "Z");
check("estado 'D' (esperando E/S): se extrae tal cual", parseStatStateField("1234 (npx) D 1 999 999 0 -1") === "D");
check(
  "comm con espacios/paréntesis propios: el estado sigue siendo el primer campo tras el ÚLTIMO ')'",
  parseStatStateField("5678 (remotion (render)) S 1 2000 2000 0 -1") === "S",
);
check("línea sin ')' (formato inesperado): devuelve null, nunca lanza", parseStatStateField("línea corrupta") === null);

// --- listAliveProcessesInGroup (fail-safe, sin /proc real) ---

{
  const result = await listAliveProcessesInGroup(999, { procRoot: "/ruta/que/no/existe" });
  check("sin /proc disponible: devuelve null, nunca una lista inventada", result === null);
}

// --- parseStatLine: campos completos (pid, ppid, pgrp, cpu, startTime) -- base de las variantes por ÁRBOL (14-nov-2026) ---

{
  const parsed = parseStatLine("1234 (npx) S 999 1500 1500 0 -1 4194304 0 0 0 0 10 5 0 0 20 0 1 0 777777 ...");
  check("parseStatLine: pid/ppid/pgrp/utime/stime/startTime en las posiciones correctas", parsed?.pid === 1234 && parsed?.ppid === 999 && parsed?.pgrp === 1500 && parsed?.utimeTicks === 10 && parsed?.stimeTicks === 5 && parsed?.startTimeTicks === 777777, JSON.stringify(parsed));
  check("parseStatLine: comm extraído entre paréntesis", parsed?.comm === "npx");
}
check("parseStatLine: línea sin ')' -- null, nunca lanza", parseStatLine("línea corrupta") === null);

// --- collectProcessTree: BFS por cadena de ppid (incluye un Chrome en OTRO grupo -- el caso real que motiva esto) ---

{
  // npx(100, pgrp=100) -> node(101, ppid=100, pgrp=100) -> chrome(102, ppid=101, pgrp=102 -- SU PROPIO grupo, detached) -> chrome-renderer(103, ppid=102, pgrp=102).
  const table = new Map([
    [100, { pid: 100, ppid: 1, pgrp: 100, state: "S", utimeTicks: 1, stimeTicks: 1, startTimeTicks: 1, comm: "npx" }],
    [101, { pid: 101, ppid: 100, pgrp: 100, state: "S", utimeTicks: 2, stimeTicks: 1, startTimeTicks: 2, comm: "node" }],
    [102, { pid: 102, ppid: 101, pgrp: 102, state: "S", utimeTicks: 5, stimeTicks: 3, startTimeTicks: 3, comm: "chrome" }],
    [103, { pid: 103, ppid: 102, pgrp: 102, state: "S", utimeTicks: 7, stimeTicks: 2, startTimeTicks: 4, comm: "chrome" }],
    [999, { pid: 999, ppid: 1, pgrp: 999, state: "S", utimeTicks: 100, stimeTicks: 100, startTimeTicks: 0, comm: "unrelated" }], // proceso ajeno, no debe aparecer
  ]);
  const tree = collectProcessTree(100, table);
  check("collectProcessTree: encuentra los 4 procesos del árbol (npx+node+chrome+chrome-renderer), NUNCA el ajeno", tree.length === 4 && tree.every((p) => p.pid !== 999), JSON.stringify(tree.map((p) => p.pid)));
  check("collectProcessTree: incluye a Chrome AUNQUE esté en otro grupo de procesos (pgrp=102, no 100) -- el hecho real que motiva esta variante", tree.some((p) => p.pid === 102 && p.pgrp === 102));
  check("collectProcessTree: raíz inexistente -- array vacío, nunca lanza", collectProcessTree(999999, table).length === 0);
}

// --- sumProcessTreeCpuTicks (fail-safe, sin /proc real) ---

{
  const ticks = await sumProcessTreeCpuTicks(999, { procRoot: "/ruta/que/no/existe" });
  check("sumProcessTreeCpuTicks sin /proc disponible: null, nunca un número inventado", ticks === null);
}

// --- readProcessTable (fail-safe, sin /proc real) ---

{
  const table = await readProcessTable({ procRoot: "/ruta/que/no/existe" });
  check("readProcessTable sin /proc disponible: null", table === null);
}

// --- snapshotProcessTree / listSurvivorsFromSnapshot (fail-safe, sin /proc real) ---

{
  const snapshot = await snapshotProcessTree(999, { procRoot: "/ruta/que/no/existe" });
  check("snapshotProcessTree sin /proc disponible: null", snapshot === null);
  const survivors = await listSurvivorsFromSnapshot(snapshot, { procRoot: "/ruta/que/no/existe" });
  check("listSurvivorsFromSnapshot con foto null: null (nunca revienta por una foto vacía)", survivors === null);
  const survivorsOfNull = await listSurvivorsFromSnapshot(null);
  check("listSurvivorsFromSnapshot(null): null", survivorsOfNull === null);
}

console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
process.exit(failures === 0 ? 0 : 1);
