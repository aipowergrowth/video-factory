// PRUEBA SIMULADA — no habla con Google Drive de verdad. Inyecta un
// cliente falso para probar la lógica real de descarga/reintentos/
// verificación de server/drive.mjs sin credenciales ni red. La validación
// definitiva es con Drive real en el VPS (ver DEPLOY.md).
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import {
  downloadFileWithRetry,
  __setDriveClientForTesting,
} from "./drive.mjs";

const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "drive-sim-"));
const content = Buffer.from("contenido simulado de un video ".repeat(1000));
const md5 = crypto.createHash("md5").update(content).digest("hex");

let scenario = "ok";
let attemptsSoFar = 0;

const fakeClient = {
  files: {
    get: async (params, opts) => {
      if (params.alt === "media") {
        attemptsSoFar += 1;
        if (scenario === "fail-then-ok" && attemptsSoFar === 1) {
          // Primer intento: la conexión se corta a mitad de la descarga.
          const stream = new Readable({
            read() {
              this.push(content.subarray(0, 10));
              this.destroy(new Error("conexión simulada interrumpida"));
            },
          });
          return { data: stream };
        }
        if (scenario === "always-fail") {
          const stream = new Readable({
            read() {
              this.destroy(new Error("fallo simulado permanente"));
            },
          });
          return { data: stream };
        }
        return { data: Readable.from(content) };
      }
      // Llamada de metadata (sin alt=media).
      return {
        data: {
          id: "fake-file-id",
          name: "video-simulado.mp4",
          size: String(content.length),
          md5Checksum: md5,
          mimeType: "video/mp4",
        },
      };
    },
  },
};

__setDriveClientForTesting(() => fakeClient);

const assert = (cond, msg) => {
  if (!cond) {
    console.log(`FALLÓ: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`OK: ${msg}`);
  }
};

// --- Escenario 1: descarga limpia en el primer intento ---
scenario = "ok";
attemptsSoFar = 0;
const dest1 = path.join(dir, "ok.mp4");
const metadata1 = await downloadFileWithRetry("fake-file-id", dest1, {
  maxAttempts: 3,
  waitMs: 10,
});
assert(metadata1.name === "video-simulado.mp4", "metadata del archivo llega completa");
assert(
  (await fsp.readFile(dest1)).equals(content),
  "descarga limpia: el contenido coincide byte a byte",
);

// --- Escenario 2: falla el primer intento, se recupera en el segundo ---
scenario = "fail-then-ok";
attemptsSoFar = 0;
const dest2 = path.join(dir, "retry.mp4");
await downloadFileWithRetry("fake-file-id", dest2, { maxAttempts: 3, waitMs: 10 });
assert(attemptsSoFar === 2, "reintento: tardó exactamente 2 intentos en lograrlo");
assert(
  (await fsp.readFile(dest2)).equals(content),
  "reintento: el archivo final quedó completo pese al primer fallo",
);

// --- Escenario 3: todos los intentos fallan -> error + limpieza ---
scenario = "always-fail";
attemptsSoFar = 0;
const dest3 = path.join(dir, "fail.mp4");
let threw = false;
try {
  await downloadFileWithRetry("fake-file-id", dest3, { maxAttempts: 3, waitMs: 10 });
} catch {
  threw = true;
}
assert(threw, "fallo permanente: downloadFileWithRetry rechaza después de agotar intentos");
assert(attemptsSoFar === 3, "fallo permanente: respetó maxAttempts=3, ni más ni menos");
assert(!fs.existsSync(dest3), "fallo permanente: no queda ningún archivo parcial en disco");

await fsp.rm(dir, { recursive: true, force: true });

if (process.exitCode === 1) {
  console.log("\n--- HUBO FALLOS EN LA PRUEBA SIMULADA ---");
} else {
  console.log("\n--- Prueba SIMULADA de server/drive.mjs: todo OK ---");
}
