import fs from "fs";
import { groupCaptions } from "../server/captions.mjs";

const inPath = process.argv[2];
const outPath = process.argv[3];
const correctionsPath = process.argv[4];

const words = JSON.parse(fs.readFileSync(inPath, "utf8"));
const corrections = correctionsPath
  ? JSON.parse(fs.readFileSync(correctionsPath, "utf8"))
  : [];

const lines = groupCaptions(words, corrections);

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
