// Lógica compartida para agrupar palabras sueltas de whisper en líneas de
// subtítulo legibles y aplicar el registro de correcciones de un canal.
// La usan tanto scripts/group_captions.mjs (CLI, uso manual) como el
// servidor (server/index.mjs, transcripción automática en el VPS) — una
// sola implementación, no dos.

const DEFAULT_MAX_CHARS = 70;
const DEFAULT_MAX_MS = 4200;

/**
 * Las correcciones pueden abarcar una frase que cae repartida entre dos
 * palabras/tokens de whisper (o incluso entre lo que luego serían dos
 * líneas de subtítulo). Por eso se aplican ANTES de agrupar en líneas,
 * sobre el texto completo, y las palabras que caen dentro de una
 * coincidencia se colapsan en un solo token corregido (conservando el
 * startMs de la primera y el endMs de la última).
 */
const applyCorrectionsToWords = (wordList, corrections) => {
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

/**
 * Agrupa palabras sueltas (formato `Caption` de whisper, una por palabra)
 * en líneas de subtítulo legibles, aplicando antes el registro de
 * correcciones del canal (si se da).
 */
export const groupCaptions = (
  words,
  corrections = [],
  { maxChars = DEFAULT_MAX_CHARS, maxMs = DEFAULT_MAX_MS } = {},
) => {
  const correctedWords = applyCorrectionsToWords(words, corrections);

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

  return lines;
};
