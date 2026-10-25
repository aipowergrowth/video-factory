import fs from "fs";

const inPath = process.argv[2];
const outPath = process.argv[3];
const correctionsPath = process.argv[4];
const maxChars = 70;
const maxMs = 4200;

const words = JSON.parse(fs.readFileSync(inPath, "utf8"));
const corrections = correctionsPath
  ? JSON.parse(fs.readFileSync(correctionsPath, "utf8"))
  : [];

/**
 * Las correcciones pueden abarcar una frase que cae repartida entre dos
 * palabras/tokens de whisper (o incluso entre lo que luego serían dos
 * líneas de subtítulo). Por eso se aplican ANTES de agrupar en líneas,
 * sobre el texto completo, y las palabras que caen dentro de una
 * coincidencia se colapsan en un solo token corregido (conservando el
 * startMs de la primera y el endMs de la última).
 */
const applyCorrectionsToWords = (wordList) => {
  const fullText = wordList.map((w) => w.text).join("");
  const offsets = [];
  let pos = 0;
  for (const w of wordList) {
    offsets.push([pos, pos + w.text.length]);
    pos += w.text.length;
  }

  const wordIndexAt = (charIndex) =>
    offsets.findIndex(([start, end]) => start <= charIndex && charIndex < end);

  const matches = [];
  for (const rule of corrections) {
    const flags = rule.caseSensitive ? "g" : "gi";
    const pattern = new RegExp(
      rule.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      flags,
    );
    for (const m of fullText.matchAll(pattern)) {
      const start = m.index;
      const end = m.index + m[0].length;
      matches.push({ start, end, to: rule.to });
    }
  }
  // Orden por posición; si se solapan dos reglas, gana la primera encontrada.
  matches.sort((a, b) => a.start - b.start);
  const nonOverlapping = [];
  let lastEnd = -1;
  for (const m of matches) {
    if (m.start >= lastEnd) {
      nonOverlapping.push(m);
      lastEnd = m.end;
    }
  }

  if (nonOverlapping.length === 0) {
    return wordList;
  }

  const result = [];
  let i = 0;
  for (const m of nonOverlapping) {
    const startWordIdx = wordIndexAt(m.start);
    let endWordIdx = wordIndexAt(m.end - 1);
    if (startWordIdx === -1 || endWordIdx === -1) continue;

    // Palabras anteriores a la coincidencia, sin tocar.
    while (i < startWordIdx) {
      result.push(wordList[i]);
      i += 1;
    }

    const leadingSpace = /^\s/.test(wordList[startWordIdx].text) ? " " : "";
    result.push({
      text: leadingSpace + m.to.replace(/^\s+/, ""),
      startMs: wordList[startWordIdx].startMs,
      endMs: wordList[endWordIdx].endMs,
      timestampMs: null,
      confidence: null,
    });
    i = endWordIdx + 1;
  }
  while (i < wordList.length) {
    result.push(wordList[i]);
    i += 1;
  }

  return result;
};

const correctedWords = applyCorrectionsToWords(words);

const lines = [];
let buf = [];
let bufText = "";
let bufStart = null;

const flush = () => {
  if (buf.length === 0) return;
  const text = bufText.trim();
  if (text.length > 0) {
    lines.push({
      text,
      startMs: bufStart,
      endMs: buf[buf.length - 1].endMs,
      timestampMs: null,
      confidence: null,
    });
  }
  buf = [];
  bufText = "";
  bufStart = null;
};

for (const w of correctedWords) {
  const isWordBoundary = /^[\s]/.test(w.text) || buf.length === 0;

  if (buf.length > 0 && isWordBoundary) {
    const prospectiveLen = (bufText + w.text).trim().length;
    const prospectiveMs = w.endMs - bufStart;
    if (prospectiveLen > maxChars || prospectiveMs > maxMs) {
      flush();
    }
  }

  if (bufStart === null) bufStart = w.startMs;
  buf.push(w);
  bufText += w.text;

  if (/[.!?…]\s*$/.test(w.text)) {
    flush();
  }
}
flush();

fs.writeFileSync(outPath, JSON.stringify(lines, null, 2));
console.log(`Wrote ${lines.length} caption lines to ${outPath}`);
if (corrections.length > 0) {
  console.log(
    `Applied ${corrections.length} correction rule(s) from ${correctionsPath}`,
  );
}
for (const l of lines) {
  console.log(
    `[${(l.startMs / 1000).toFixed(2)}-${(l.endMs / 1000).toFixed(2)}] ${l.text}`,
  );
}
