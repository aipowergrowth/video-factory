import { drive as driveApi } from "@googleapis/drive";
import { GoogleAuth } from "google-auth-library";
import fs from "node:fs";
import fsp from "node:fs/promises";
import crypto from "node:crypto";

const SCOPES = ["https://www.googleapis.com/auth/drive.readonly"];

let cachedClient = null;
let testClientFactory = null;

/**
 * Permite inyectar un cliente falso en pruebas (ver
 * server/test-drive-simulated.mjs) sin tocar la lógica real de
 * descarga/reintentos/verificación — solo para tests, nunca se usa en
 * producción.
 */
export const __setDriveClientForTesting = (factory) => {
  testClientFactory = factory;
  cachedClient = null;
};

/**
 * Cliente de Drive autenticado con una cuenta de servicio. La clave nunca
 * vive en el código/repositorio: `GOOGLE_APPLICATION_CREDENTIALS` apunta a
 * un archivo montado desde un secreto de Docker (ver docker-stack.yml).
 * El acceso real a los archivos lo da haber compartido la carpeta de
 * Drive con el email de esta cuenta de servicio — no un rol de GCP.
 */
const getDriveClient = () => {
  if (testClientFactory) return testClientFactory();
  if (cachedClient) return cachedClient;
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyFile) {
    throw new Error(
      "Falta GOOGLE_APPLICATION_CREDENTIALS (ruta al JSON de la cuenta de servicio de Drive).",
    );
  }
  const auth = new GoogleAuth({ keyFile, scopes: SCOPES });
  cachedClient = driveApi({ version: "v3", auth });
  return cachedClient;
};

export const getFileMetadata = async (fileId) => {
  const client = getDriveClient();
  const { data } = await client.files.get({
    fileId,
    fields: "id,name,size,md5Checksum,mimeType",
    supportsAllDrives: true,
  });
  return data;
};

const computeMd5 = (filePath) =>
  new Promise((resolve, reject) => {
    const hash = crypto.createHash("md5");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });

/**
 * Descarga un único intento, en streaming (nunca carga el archivo
 * completo en memoria: se va escribiendo a disco a medida que llega).
 */
const downloadOnce = async (fileId, destPath) => {
  const client = getDriveClient();
  const res = await client.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "stream" },
  );

  await new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(destPath);
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      writeStream.destroy();
      reject(err);
    };
    res.data.on("error", fail);
    writeStream.on("error", fail);
    writeStream.on("finish", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    res.data.pipe(writeStream);
  });
};

/**
 * Descarga con reintentos (espera creciente entre intentos), verifica que
 * la descarga quedó completa (tamaño, y MD5 cuando Drive lo da) y borra
 * cualquier archivo parcial si falla o si va a reintentar.
 */
export const downloadFileWithRetry = async (
  fileId,
  destPath,
  { maxAttempts = 3, waitMs = 5000 } = {},
) => {
  const metadata = await getFileMetadata(fileId);
  const expectedSize = metadata.size ? Number(metadata.size) : null;

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await downloadOnce(fileId, destPath);

      const stat = await fsp.stat(destPath);
      if (expectedSize !== null && stat.size !== expectedSize) {
        throw new Error(
          `Descarga incompleta: se esperaban ${expectedSize} bytes, llegaron ${stat.size}.`,
        );
      }

      if (metadata.md5Checksum) {
        const actualMd5 = await computeMd5(destPath);
        if (actualMd5 !== metadata.md5Checksum) {
          throw new Error(
            `MD5 no coincide: Drive reporta ${metadata.md5Checksum}, se descargó ${actualMd5}.`,
          );
        }
      }

      return metadata;
    } catch (err) {
      lastError = err;
      await fsp.unlink(destPath).catch(() => {});
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, waitMs * attempt));
      }
    }
  }
  throw new Error(
    `No se pudo descargar el archivo de Drive (${fileId}) tras ${maxAttempts} intento(s): ${lastError?.message ?? lastError}`,
  );
};
