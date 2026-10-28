import { drive as driveApi } from "@googleapis/drive";
import { GoogleAuth, OAuth2Client } from "google-auth-library";
import fs from "node:fs";
import fsp from "node:fs/promises";
import crypto from "node:crypto";

// Para LEER (carpeta de origen, compartida como Viewer con esta cuenta
// de servicio). Las cuentas de servicio no tienen cuota de almacenamiento
// propia -- no pueden SUBIR a un Drive personal (ver getUploadDriveClient
// más abajo, que usa OAuth del propio usuario para eso).
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

let cachedUploadClient = null;
let testUploadClientFactory = null;

/** Igual que __setDriveClientForTesting pero para el cliente de SUBIDA (OAuth). */
export const __setUploadDriveClientForTesting = (factory) => {
  testUploadClientFactory = factory;
  cachedUploadClient = null;
};

/**
 * Cliente de Drive autenticado como el propio usuario (OAuth, no cuenta
 * de servicio) -- necesario porque las cuentas de servicio no pueden
 * subir archivos a un Drive personal ("Service Accounts do not have
 * storage quota"). El refresh token no vence a los 7 días siempre que la
 * pantalla de consentimiento de OAuth esté en "In production" (no solo
 * "Testing") -- ver DEPLOY.md para la guía paso a paso de cómo se generó.
 */
const getUploadDriveClient = () => {
  if (testUploadClientFactory) return testUploadClientFactory();
  if (cachedUploadClient) return cachedUploadClient;
  const credsFile = process.env.DRIVE_OAUTH_CREDENTIALS_FILE;
  if (!credsFile) {
    throw new Error(
      "Falta DRIVE_OAUTH_CREDENTIALS_FILE (secreto de Portainer con client_id/client_secret/refresh_token para subir a Drive).",
    );
  }
  const raw = fs.readFileSync(credsFile, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Nunca el contenido crudo en el mensaje -- podría ser casi el JSON
    // correcto con un valor real adentro.
    throw new Error(
      "El secreto OAuth de Drive (DRIVE_OAUTH_CREDENTIALS_FILE) no es un JSON válido. Debe ser una sola línea como " +
        '{"client_id":"...","client_secret":"...","refresh_token":"..."} -- ver DEPLOY.md.',
    );
  }
  for (const field of ["client_id", "client_secret", "refresh_token"]) {
    if (typeof parsed[field] !== "string" || parsed[field].length === 0) {
      throw new Error(
        `El secreto OAuth de Drive (DRIVE_OAUTH_CREDENTIALS_FILE) no trae "${field}" (o está vacío). Ver DEPLOY.md.`,
      );
    }
  }
  const { client_id, client_secret, refresh_token } = parsed;
  const oauth2Client = new OAuth2Client({ clientId: client_id, clientSecret: client_secret });
  oauth2Client.setCredentials({ refresh_token });
  cachedUploadClient = driveApi({ version: "v3", auth: oauth2Client });
  return cachedUploadClient;
};

/**
 * Sube un archivo (el MP4 final) a una carpeta de Drive, usando el
 * permiso del propio usuario (OAuth, ver getUploadDriveClient) -- no el
 * de la cuenta de servicio, que no puede escribir en un Drive personal.
 * La carpeta ya debe existir y ser accesible para ese usuario.
 */
export const uploadFile = async ({ filePath, fileName, folderId, mimeType = "video/mp4" }) => {
  const client = getUploadDriveClient();
  const { data } = await client.files.create({
    requestBody: { name: fileName, parents: [folderId] },
    media: { mimeType, body: fs.createReadStream(filePath) },
    fields: "id,name,webViewLink",
    supportsAllDrives: true,
  });
  return data;
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
