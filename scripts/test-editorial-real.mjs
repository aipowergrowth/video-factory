// Prueba REAL de server/editorial.mjs contra la API real de Claude, sin
// gastar una corrida completa en el VPS. Necesita ANTHROPIC_API_KEY en el
// entorno (nunca lo pases por otro lado) y un archivo de transcripción
// real (ver scripts/transcribe.mjs o el propio pipeline del servidor para
// generarlo) con esta forma:
//   { "captions": [...líneas agrupadas...], "words": [...palabra por palabra...], "durationInSeconds": number }
//
// Uso:
//   ANTHROPIC_API_KEY=sk-ant-... node scripts/test-editorial-real.mjs \
//     /ruta/a/transcript.json a-mi-no-me-cuadra youtube-16-9
import fs from "node:fs/promises";
import { planEdit } from "../server/editorial.mjs";

const [, , transcriptPath, channel = "a-mi-no-me-cuadra", destination = "youtube-16-9"] =
  process.argv;

if (!transcriptPath) {
  console.error(
    "Uso: ANTHROPIC_API_KEY=sk-ant-... node scripts/test-editorial-real.mjs <transcript.json> [canal] [destination]",
  );
  process.exit(1);
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Falta ANTHROPIC_API_KEY en el entorno (no lo pegues en ningún archivo del repo).");
  process.exit(1);
}

const { captions, words, durationInSeconds } = JSON.parse(
  await fs.readFile(transcriptPath, "utf8"),
);
const guidelines = await fs.readFile(
  `public/channels/${channel}/editorial-guidelines.md`,
  "utf8",
);

console.log(
  `Transcripción: ${captions?.length ?? 0} líneas, ${words?.length ?? 0} palabras, ${durationInSeconds}s de video.`,
);
console.log(`Canal: ${channel}. Destino: ${destination}.\n`);

const startedAt = Date.now();
const plan = await planEdit({
  captions,
  transcriptWords: words,
  guidelines,
  durationInSeconds,
  destination,
  onLog: (msg) => console.log(`[log] ${msg}`),
});
const totalElapsedMs = Date.now() - startedAt;

console.log("\n--- RESULTADO ---");
console.log(`Tiempo total: ${(totalElapsedMs / 1000).toFixed(1)}s`);
console.log(
  `Métricas: stop_reason=${plan.metrics.stopReason}, max_tokens=${plan.metrics.maxTokens}, ` +
    `reintentó=${plan.metrics.retried}, tokens=${plan.metrics.inputTokens}in/${plan.metrics.outputTokens}out`,
);
console.log(`Cortes: ${plan.cuts.length}. Zooms: ${plan.zooms.length}.`);
console.log(`\nNotas del editor:\n${plan.notes}\n`);

if (plan.cuts.length > 0) {
  console.log("Cortes:");
  for (const cut of plan.cuts) {
    console.log(
      `  ${cut.startSeconds.toFixed(2)}-${cut.endSeconds.toFixed(2)}s (${(cut.endSeconds - cut.startSeconds).toFixed(2)}s): ${cut.reason ?? "(sin razón)"}`,
    );
  }
}
if (plan.zooms.length > 0) {
  console.log("\nZooms:");
  for (const zoom of plan.zooms) {
    console.log(
      `  ${zoom.startSeconds.toFixed(2)}-${zoom.endSeconds.toFixed(2)}s (${zoom.fromScale}x->${zoom.toScale}x): ${zoom.reason ?? "(sin razón)"}`,
    );
  }
}

const totalCutSeconds = plan.cuts.reduce((sum, c) => sum + (c.endSeconds - c.startSeconds), 0);
console.log(
  `\nDuración final estimada: ${(durationInSeconds - totalCutSeconds).toFixed(1)}s ` +
    `(${totalCutSeconds.toFixed(1)}s cortados de ${durationInSeconds}s originales).`,
);
