import path from "path";
import fs from "fs";
import {
  downloadWhisperModel,
  installWhisperCpp,
  transcribe,
  toCaptions,
} from "@remotion/install-whisper-cpp";

const projectDir = "/Users/passwordis0000/fabrica-videos";
const to = path.join(projectDir, "whisper.cpp");
const wavPath = process.argv[2];
const outJson = process.argv[3];
const model = process.argv[4] ?? "medium";
const language = process.argv[5] ?? "auto";

console.log("Installing whisper.cpp...");
await installWhisperCpp({ to, version: "1.5.5" });

console.log(`Downloading model ${model}...`);
await downloadWhisperModel({ model, folder: to });

console.log("Transcribing", wavPath);
const whisperCppOutput = await transcribe({
  model,
  whisperPath: to,
  whisperCppVersion: "1.5.5",
  inputPath: wavPath,
  tokenLevelTimestamps: true,
  translateToEnglish: false,
  language,
});

fs.writeFileSync(
  outJson.replace(/\.json$/, ".raw.json"),
  JSON.stringify(whisperCppOutput, null, 2),
);

const { captions } = toCaptions({ whisperCppOutput });
fs.writeFileSync(outJson, JSON.stringify(captions, null, 2));

console.log("Wrote", outJson);
console.log("Preview:", captions.slice(0, 5));
