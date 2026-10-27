// Se ejecuta SOLO durante el build de la imagen (etapa whisper-builder del
// Dockerfile) — compila whisper.cpp y descarga el modelo, para que en
// producción la transcripción arranque al instante (nada que instalar ni
// descargar en tiempo de ejecución). Reutiliza la misma librería que ya
// usa scripts/transcribe.mjs en local — una sola forma de instalar
// whisper.cpp en todo el proyecto.
import path from "node:path";
import { installWhisperCpp, downloadWhisperModel } from "@remotion/install-whisper-cpp";

const to = path.join(process.cwd(), "whisper.cpp");
const model = process.env.WHISPER_MODEL ?? "small";
const version = "1.5.5";

console.log(`Instalando whisper.cpp ${version}...`);
await installWhisperCpp({ to, version });

console.log(`Descargando modelo "${model}"...`);
await downloadWhisperModel({ model, folder: to });

console.log("whisper.cpp listo en", to);
