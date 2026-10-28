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
  uploadFile,
  __setDriveClientForTesting,
  __setUploadDriveClientForTesting,
} from "./drive.mjs";

const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "drive-sim-"));
const content = Buffer.from("contenido simulado de un video ".repeat(1000));
const md5 = crypto.createHash("md5").update(content).digest("hex");

let scenario = "ok";
let attemptsSoFar = 0;
let uploadScenario = "ok";
let lastUploadRequestBody = null;

const fakeClient = {
  files: {
    create: async ({ requestBody, media }) => {
      lastUploadRequestBody = requestBody;
      // Drenar el stream de entrada, igual que haría la librería real.
      for await (const _chunk of media.body) {
        // no-op
      }
      if (uploadScenario === "no-permission") {
        const err = new Error(
          "The user does not have sufficient permissions for this file.",
        );
        err.code = 403;
        throw err;
      }
      return {
        data: {
          id: "fake-uploaded-id",
          name: requestBody.name,
          webViewLink: "https://drive.google.com/file/d/fake-uploaded-id/view",
        },
      };
    },
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
// La subida ahora pasa por un cliente OAuth separado (no la cuenta de
// servicio) -- mismo objeto falso, inyectado en el hook correcto.
__setUploadDriveClientForTesting(() => fakeClient);

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

// --- Escenario 4: subida del MP4 final a Drive -- caso feliz ---
uploadScenario = "ok";
const uploadSrc = path.join(dir, "para-subir.mp4");
await fsp.writeFile(uploadSrc, content);
const uploaded = await uploadFile({
  filePath: uploadSrc,
  fileName: "video-final.mp4",
  folderId: "fake-folder-id",
});
assert(uploaded.id === "fake-uploaded-id", "subida: devuelve el id del archivo creado");
assert(uploaded.webViewLink?.includes("fake-uploaded-id"), "subida: devuelve un link para abrirlo");
assert(lastUploadRequestBody.parents?.[0] === "fake-folder-id", "subida: lo coloca en la carpeta correcta");

// --- Escenario 5: la carpeta no tiene permiso de Editor para la cuenta de servicio ---
uploadScenario = "no-permission";
let uploadThrew = false;
try {
  await uploadFile({
    filePath: uploadSrc,
    fileName: "video-final.mp4",
    folderId: "fake-folder-id-sin-permiso",
  });
} catch (err) {
  uploadThrew = true;
  assert(
    err.message.includes("permission"),
    "subida sin permiso: el error dice claramente que es de permisos, no uno genérico",
  );
}
assert(uploadThrew, "subida sin permiso: uploadFile rechaza en vez de fallar en silencio");

// --- Escenario 6: sin DRIVE_OAUTH_CREDENTIALS_FILE (ni cliente falso inyectado) -> error claro, no uno críptico del SDK ---
{
  __setUploadDriveClientForTesting(null);
  const previousFile = process.env.DRIVE_OAUTH_CREDENTIALS_FILE;
  delete process.env.DRIVE_OAUTH_CREDENTIALS_FILE;
  let threw = false;
  try {
    await uploadFile({ filePath: uploadSrc, fileName: "x.mp4", folderId: "fake" });
  } catch (err) {
    threw = true;
    assert(
      err.message.includes("DRIVE_OAUTH_CREDENTIALS_FILE"),
      "sin credenciales OAuth: el mensaje dice exactamente qué falta",
    );
  }
  assert(threw, "sin credenciales OAuth: uploadFile lanza error en vez de fallar en silencio");
  if (previousFile) process.env.DRIVE_OAUTH_CREDENTIALS_FILE = previousFile;
  __setUploadDriveClientForTesting(() => fakeClient);
}

// --- Escenario 7: el secreto OAuth existe pero no es JSON válido -> dice EXACTAMENTE eso, sin mostrar el contenido ---
{
  __setUploadDriveClientForTesting(null);
  const previousFile = process.env.DRIVE_OAUTH_CREDENTIALS_FILE;
  const badJsonFile = path.join(dir, "oauth-malformado.txt");
  await fsp.writeFile(badJsonFile, "esto no es json{{{");
  process.env.DRIVE_OAUTH_CREDENTIALS_FILE = badJsonFile;
  let threw = false;
  try {
    await uploadFile({ filePath: uploadSrc, fileName: "x.mp4", folderId: "fake" });
  } catch (err) {
    threw = true;
    assert(err.message.includes("no es un JSON válido"), "secreto OAuth malformado: dice en palabras que no es JSON válido");
    assert(!err.message.includes("esto no es json"), "secreto OAuth malformado: el error NUNCA repite el contenido crudo del secreto");
  }
  assert(threw, "secreto OAuth malformado: uploadFile rechaza");
  if (previousFile) process.env.DRIVE_OAUTH_CREDENTIALS_FILE = previousFile;
  __setUploadDriveClientForTesting(() => fakeClient);
}

// --- Escenario 8: el secreto OAuth es JSON válido pero le falta refresh_token -> dice EXACTAMENTE qué campo falta ---
{
  __setUploadDriveClientForTesting(null);
  const previousFile = process.env.DRIVE_OAUTH_CREDENTIALS_FILE;
  const incompleteFile = path.join(dir, "oauth-incompleto.json");
  await fsp.writeFile(incompleteFile, JSON.stringify({ client_id: "abc", client_secret: "def" }));
  process.env.DRIVE_OAUTH_CREDENTIALS_FILE = incompleteFile;
  let threw = false;
  try {
    await uploadFile({ filePath: uploadSrc, fileName: "x.mp4", folderId: "fake" });
  } catch (err) {
    threw = true;
    assert(err.message.includes('"refresh_token"'), "secreto OAuth incompleto: dice exactamente qué campo falta (refresh_token)");
    assert(!err.message.includes("abc") && !err.message.includes("def"), "secreto OAuth incompleto: el error NUNCA muestra los valores presentes");
  }
  assert(threw, "secreto OAuth incompleto: uploadFile rechaza");
  if (previousFile) process.env.DRIVE_OAUTH_CREDENTIALS_FILE = previousFile;
  __setUploadDriveClientForTesting(() => fakeClient);
}

await fsp.rm(dir, { recursive: true, force: true });

if (process.exitCode === 1) {
  console.log("\n--- HUBO FALLOS EN LA PRUEBA SIMULADA ---");
} else {
  console.log("\n--- Prueba SIMULADA de server/drive.mjs: todo OK ---");
}
