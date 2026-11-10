// PRUEBA SIMULADA (nivel 2 de honestidad de evidencia, CLAUDE.md) --
// server/process-tree.mjs: solo la lógica pura (parseo del pgrp de
// una línea de /proc/[pid]/stat) y el comportamiento fail-safe sin
// /proc real (macOS de desarrollo). La confirmación de que esto
// funciona de verdad contra procesos reales en Linux -- incluyendo que
// matar el grupo completo deja 0 descendientes vivos tras un render
// real -- vive en test-render-observability.mjs (CI, Linux real).

import { parsePgrpFromStatLine, countAliveProcessesInGroup, killProcessGroup, parseStatStateField, listAliveProcessesInGroup } from "./process-tree.mjs";

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

console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
process.exit(failures === 0 ? 0 : 1);
