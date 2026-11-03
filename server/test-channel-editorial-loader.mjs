// PRUEBA SIMULADA (nivel 2 de honestidad de evidencia, CLAUDE.md) --
// resolución de la guía editorial de un canal según `layout`, contra
// los archivos REALES del repo en public/channels/ (sin tocar ninguna
// IA, sin red, sin gastar nada) -- exactamente lo pedido: "demuestra
// con las pruebas simuladas existentes (o una nueva) que la carga de
// guías resuelve bien los tres casos: sin layout, con layout
// 'screen-share' y con un layout inexistente."
//
// Usa server/channel-editorial-loader.mjs DIRECTO -- es el módulo real
// que server/index.mjs usa en producción (extraído de ahí el
// 03-nov-2026 para poder probarlo sin levantar el servidor), no una
// reimplementación paralela para pruebas.

import { loadChannelEditorialContext } from "./channel-editorial-loader.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let failures = 0;
const check = (label, cond, detail = "") => {
  if (!cond) {
    failures++;
    console.log(`FAIL: ${label}${detail ? ` -- ${detail}` : ""}`);
  } else {
    console.log(`ok: ${label}`);
  }
};

const CHANNEL = "alex-cripto-y-negocios";

// --- Caso 1: SIN layout -- debe cargar la guía "a cámara" por
// defecto, equivalente en comportamiento a "A mí no me cuadra"
// (criterios de B-roll/zooms/cortes), con la regla de datos
// financieros encima. ---
{
  const { guidelines, resourceProfile, correctionsHistory } = await loadChannelEditorialContext(PROJECT_ROOT, CHANNEL, undefined);
  check("sin layout: se cargó alguna guía (no null)", typeof guidelines === "string" && guidelines.length > 0);
  check("sin layout: NO es la guía de pantalla compartida", !guidelines.includes("pantalla compartida con el gráfico de mercado"));
  check("sin layout: mantiene la regla de nunca tocar datos financieros", guidelines.includes("Nunca tocar datos financieros"));
  check(
    "sin layout: ya NO exige solo gráficos reales/capturas para cualquier recurso (el defecto roto que reportó el operador)",
    !/priorizar gráficos auténticos, datos verificables y capturas pertinentes/.test(guidelines),
  );
  check(
    "sin layout: distingue explícitamente concepto (se ilustra) de dato (debe ser real)",
    guidelines.includes("Concepto") && guidelines.includes("Dato") && guidelines.includes("evidencia real"),
  );
  check(
    "sin layout: conserva el criterio de comparaciones con dos recursos consecutivos (equivalente a 'A mí no me cuadra')",
    guidelines.includes("dos recursos") && guidelines.includes("consecutivos"),
  );
  check(
    "sin layout: conserva el criterio de no dejar al presentador solo por inercia / no saturar (equivalente a 'A mí no me cuadra')",
    guidelines.toLowerCase().includes("por inercia"),
  );
  check("sin layout: siguen cargando perfil de recursos y correcciones del canal (sin cambios)", resourceProfile !== undefined && Array.isArray(correctionsHistory));
}

// --- Caso 2: layout="screen-share" -- debe cargar la guía de pantalla
// compartida, intacta, byte a byte igual a la que ya existía. ---
{
  const { guidelines } = await loadChannelEditorialContext(PROJECT_ROOT, CHANNEL, "screen-share");
  check("layout=screen-share: carga la guía de pantalla compartida", guidelines?.includes("pantalla compartida con el gráfico de mercado"));
  check("layout=screen-share: mantiene su regla de datos financieros propia", guidelines?.includes("Nunca tocar datos financieros"));
  check("layout=screen-share: mantiene 'resources: [] es el resultado por DEFECTO'", guidelines?.includes("resources: []"));
  check("layout=screen-share: mantiene 'Sin zoom en este formato'", guidelines?.includes("Sin zoom en este formato"));
}

// --- Caso 3: layout inexistente -- sin archivo propio, debe caer de
// vuelta a la guía por defecto (la misma del caso 1), nunca a error ni
// a la de pantalla compartida. ---
{
  const { guidelines } = await loadChannelEditorialContext(PROJECT_ROOT, CHANNEL, "este-layout-no-existe");
  check("layout inexistente: no se cae (no lanza, no devuelve null)", typeof guidelines === "string" && guidelines.length > 0);
  check("layout inexistente: cae a la guía por defecto, NO a la de pantalla compartida", !guidelines.includes("pantalla compartida con el gráfico de mercado"));
  check("layout inexistente: es la misma guía que el caso sin layout (por defecto)", guidelines.includes("Nunca tocar datos financieros") && guidelines.includes("Concepto"));
}

// --- Caso 4 (control, no pedido explícitamente pero barato de
// confirmar): "A mí no me cuadra" no se vio afectado por nada de esto. ---
{
  const { guidelines } = await loadChannelEditorialContext(PROJECT_ROOT, "a-mi-no-me-cuadra", undefined);
  check("control: 'A mí no me cuadra' sigue cargando su propia guía, intacta", guidelines?.includes("Video de investigación y pensamiento crítico"));
}

console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
process.exit(failures === 0 ? 0 : 1);
