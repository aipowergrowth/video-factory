// PRUEBA SIMULADA -- nunca llama a la red real de Gemini (misma
// disciplina que el resto del proyecto: inyecta
// __setImageGeneratorForTesting en vez de golpear una API real).
// Prueba la lógica PURA (buildImageGenerationPrompt) y el CONTROL DE
// FLUJO del reintento (generateImageWithRetry) de
// server/image-generation.mjs.
import {
  GEMINI_IMAGE_MODEL,
  GEMINI_IMAGE_PRICE_USD,
  buildImageGenerationPrompt,
  generateImageWithRetry,
  __setImageGeneratorForTesting,
} from "./image-generation.mjs";

let failures = 0;
const check = (label, cond, detail = "") => {
  if (!cond) {
    failures++;
    console.log(`FAIL: ${label}${detail ? ` -- ${detail}` : ""}`);
  } else {
    console.log(`ok: ${label}`);
  }
};

// --- constantes verificadas ---

check("GEMINI_IMAGE_MODEL: id de modelo confirmado contra ai.google.dev/gemini-api/docs/pricing", GEMINI_IMAGE_MODEL === "gemini-3.1-flash-lite-image");
check("GEMINI_IMAGE_PRICE_USD: tarifa confirmada ($0.0336 por imagen 1K)", GEMINI_IMAGE_PRICE_USD === 0.0336);

// --- buildImageGenerationPrompt (decisiones cerradas de Alex: siempre
// ilustrativo, nunca fotorrealista, sin texto en la imagen) ---

{
  const prompt = buildImageGenerationPrompt("cazadores prehistóricos persiguiendo presa en la naturaleza", undefined);
  check("buildImageGenerationPrompt: incluye la consulta original", prompt.includes("cazadores prehistóricos persiguiendo presa en la naturaleza"));
  check("buildImageGenerationPrompt: exige NUNCA fotorrealista", /NUNCA fotorrealista/i.test(prompt));
  check("buildImageGenerationPrompt: exige que nunca haya texto/letras dentro de la imagen", /NUNCA.*texto/i.test(prompt));
  check("buildImageGenerationPrompt: sin visualStyle, usa un estilo genérico razonable (no deja el prompt sin ninguna guía)", /esquemática|infográfico/i.test(prompt));
}
{
  const prompt = buildImageGenerationPrompt("ilustración de neuronas", "trazo grueso, paleta azul y blanco, minimalista");
  check("buildImageGenerationPrompt: con visualStyle, lo inyecta tal cual (coherencia por canal)", prompt.includes("trazo grueso, paleta azul y blanco, minimalista"));
}

// --- generateImageWithRetry (reintento ante fallo técnico, mismo criterio que la Capa B/C) ---

{
  let calls = 0;
  __setImageGeneratorForTesting(async () => {
    calls++;
    return { buffer: Buffer.from("imagen-falsa"), mimeType: "image/png", costUsd: 0.0336, usage: null };
  });
  const result = await generateImageWithRetry({ apiKey: "fake", prompt: "una ilustración", resourceId: "r1" });
  check("generateImageWithRetry: éxito en el primer intento -- 1 sola llamada", calls === 1 && result.costUsd === 0.0336);
  __setImageGeneratorForTesting(null);
}

{
  let calls = 0;
  __setImageGeneratorForTesting(async () => {
    calls++;
    if (calls === 1) {
      const err = new Error("timeout de red (simulado)");
      throw err; // sin costUsd -- un fallo técnico sin imagen no se cobra
    }
    return { buffer: Buffer.from("imagen-falsa"), mimeType: "image/png", costUsd: 0.0336, usage: null };
  });
  const logLines = [];
  const result = await generateImageWithRetry({ apiKey: "fake", prompt: "una ilustración", resourceId: "r2", log: (m) => logLines.push(m) });
  check("generateImageWithRetry: falla el primer intento, reintenta y el segundo sí genera", calls === 2 && result.costUsd === 0.0336);
  check("log: el intento fallido queda registrado con costo $0 (nunca se cobra un fallo sin imagen)", logLines.some((l) => l.includes("intento 1/2") && l.includes("costo de ese intento: $0.000000")));
  __setImageGeneratorForTesting(null);
}

{
  let calls = 0;
  __setImageGeneratorForTesting(async () => {
    calls++;
    throw new Error("Gemini respondió HTTP 500 (simulado)");
  });
  let thrown;
  try {
    await generateImageWithRetry({ apiKey: "fake", prompt: "una ilustración", resourceId: "r3" });
  } catch (err) {
    thrown = err;
  }
  check("generateImageWithRetry: si fallan los 2 intentos, se intentó exactamente 2 veces (no más)", calls === 2);
  check("generateImageWithRetry: el error final lanzado lleva el motivo real", thrown?.message?.includes("HTTP 500"));
  __setImageGeneratorForTesting(null);
}

console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
process.exit(failures === 0 ? 0 : 1);
