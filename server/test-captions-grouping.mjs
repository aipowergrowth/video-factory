// PRUEBA SIMULADA (nivel 2 de honestidad de evidencia, CLAUDE.md) --
// server/captions.mjs#groupCaptions: agrupado de palabras en líneas de
// subtítulo (comportamiento ya existente, sin tocar) + el desglose por
// palabra con fracciones de progreso dentro de la línea (estilo
// dinámico vertical, 03-nov-2026, autorizado por Alex). Sin ningún
// binario real ni IA -- datos simulados de palabras con sus tiempos.
//
// No existía ningún archivo de prueba dedicado a `captions.mjs` antes
// de este cambio (verificado: ni scripts/group_captions.mjs ni ningún
// server/test-*.mjs lo ejercitaban) -- este archivo cubre tanto el
// comportamiento previo (para no romperlo con el cambio) como el nuevo.

import { groupCaptions } from "./captions.mjs";

let failures = 0;
const check = (label, cond, detail = "") => {
  if (!cond) {
    failures++;
    console.log(`FAIL: ${label}${detail ? ` -- ${detail}` : ""}`);
  } else {
    console.log(`ok: ${label}`);
  }
};

const word = (text, startMs, endMs) => ({ text, startMs, endMs, timestampMs: null, confidence: null });

// --- Comportamiento ya existente (regresión): agrupado por tamaño/tiempo/puntuación, sin tocar ---

{
  const words = [word("Hola", 0, 300), word(" mundo.", 300, 700)];
  const lines = groupCaptions(words);
  check("agrupado básico: una sola línea (termina en punto)", lines.length === 1);
  check("agrupado básico: el texto concatena las palabras correctamente", lines[0].text === "Hola mundo.");
  check("agrupado básico: startMs de la primera palabra, endMs de la última", lines[0].startMs === 0 && lines[0].endMs === 700);
}

{
  // Corte por longitud (maxChars) -- comportamiento ya existente.
  const words = [word("Una", 0, 100), word(" línea", 100, 300), word(" muy", 300, 400), word(" larga", 400, 600), word(" que", 600, 700), word(" sigue", 700, 900), word(" y", 900, 950), word(" sigue", 950, 1200)];
  const lines = groupCaptions(words, [], { maxChars: 20, maxMs: 100000 });
  check("corte por longitud: produce más de una línea", lines.length > 1, `lines=${JSON.stringify(lines.map((l) => l.text))}`);
}

// --- Desglose por palabra (nuevo, 03-nov-2026) ---

{
  const words = [word("Hola", 0, 300), word(" mundo.", 300, 700)];
  const lines = groupCaptions(words);
  check("words: la línea trae un desglose por palabra", Array.isArray(lines[0].words) && lines[0].words.length === 2);
  check("words: el texto de cada palabra viene SIN el espacio líder (ya trimeado)", lines[0].words[0].text === "Hola" && lines[0].words[1].text === "mundo.");
  check(
    "words: las fracciones son relativas a [startMs, endMs] de la LÍNEA, no ms absolutos",
    lines[0].words[0].startFraction === 0 && Math.abs(lines[0].words[0].endFraction - 300 / 700) < 1e-9,
  );
  check(
    "words: la última palabra llega hasta el final de la línea (fracción 1)",
    lines[0].words[1].endFraction === 1,
  );
  check(
    "words: las fracciones son crecientes y consecutivas (la palabra 2 empieza donde termina la 1)",
    lines[0].words[1].startFraction === lines[0].words[0].endFraction,
  );
}

{
  // Una línea con VARIAS palabras reales (no solo 2) -- confirma que el
  // desglose completo sobrevive, no solo la primera/última.
  const words = [
    word("El", 1000, 1100),
    word(" presentador", 1100, 1700),
    word(" explica", 1700, 2200),
    word(" bien.", 2200, 2500),
  ];
  const lines = groupCaptions(words);
  check("words (línea de 4 palabras): desglose completo, una entrada por palabra", lines[0].words.length === 4);
  check("words (línea de 4 palabras): cada texto coincide con la palabra original (trimeada)", lines[0].words.map((w) => w.text).join(" ") === "El presentador explica bien.".replace(/\s+/g, " "));
  // La palabra 3 ("explica", 1700-2200) dentro de una línea 1000-2500 (span 1500):
  // startFraction = (1700-1000)/1500 = 0.4667, endFraction = (2200-1000)/1500 = 0.8
  check("words (línea de 4 palabras): fracción de una palabra intermedia es correcta", Math.abs(lines[0].words[2].startFraction - 700 / 1500) < 1e-9 && Math.abs(lines[0].words[2].endFraction - 1200 / 1500) < 1e-9);
}

{
  // Corrección editorial que colapsa dos palabras en un solo token
  // corregido -- el desglose trata ese token corregido como UNA sola
  // "palabra" (comportamiento razonable: se resalta la frase corregida
  // completa mientras se dice, no sus partes originales que ya no existen).
  const words = [word("la", 0, 100), word(" ola", 100, 400), word(" vino", 400, 700)];
  const corrections = [{ from: "la ola", to: "Lola" }];
  const lines = groupCaptions(words, corrections);
  check("corrección + words: el texto de la línea refleja la corrección", lines[0].text === "Lola vino");
  check("corrección + words: el token corregido cuenta como una sola palabra en el desglose", lines[0].words.length === 2 && lines[0].words[0].text === "Lola");
  check("corrección + words: el token corregido conserva el tiempo de inicio de la primera palabra original", lines[0].words[0].startFraction === 0);
}

{
  // Caso degenerado: una sola palabra cuyo startMs===endMs (span de la
  // línea = 0) -- no debe dividir por cero ni romper.
  const words = [word("Eh.", 500, 500)];
  const lines = groupCaptions(words);
  check("span de línea cero: no revienta", lines.length === 1);
  check("span de línea cero: fracciones caen al valor por defecto (0 y 1), no NaN", lines[0].words[0].startFraction === 0 && lines[0].words[0].endFraction === 1);
}

{
  // Múltiples líneas (por punto final) -- cada línea tiene SU PROPIO
  // desglose, no uno global para todo el texto transcripto.
  const words = [word("Hola.", 0, 400), word(" Chau.", 400, 900)];
  const lines = groupCaptions(words);
  check("múltiples líneas: dos líneas (una por punto final)", lines.length === 2);
  check("múltiples líneas: cada línea tiene su propio desglose de 1 palabra", lines[0].words.length === 1 && lines[1].words.length === 1);
  check("múltiples líneas: la segunda línea no hereda nada de la primera (fracciones relativas a SU propio span)", lines[1].words[0].startFraction === 0 && lines[1].words[0].endFraction === 1);
}

console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
process.exit(failures === 0 ? 0 : 1);
