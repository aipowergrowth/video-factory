// Bundle de Remotion pre-construido y REUTILIZADO entre invocaciones
// (híbrido a ruta de producción, 14-nov-2026, autorizado por Alex,
// criterio 4: "reutiliza el bundle... para evitar ~16 s de arranque
// por tramo").
//
// Hechos verificados en el código instalado (Remotion 4.0.538), no
// asumidos:
// - `npx remotion render <ruta>` acepta un DIRECTORIO ya bundleado como
//   primer argumento y entonces NO vuelve a hacer bundling
//   (@remotion/cli/dist/setup-cache.js:18 -- `isBundle = existsSync(
//   fullPath) && existsSync(path.join(fullPath, 'index.html'))`).
// - El render normal del CLI hace bundling (rspack) en CADA invocación
//   y enlaza `public/` con symlink (setup-cache.js:123,
//   `symlinkPublicDir: outDir === null`) -- o sea, lo que se repite por
//   tramo es el bundling + arrancar Chrome + seleccionar la
//   composición, no una copia de public/.
// - `npx remotion bundle --out-dir X` COPIA `public/` dentro de X (no
//   expone `symlinkPublicDir`). En el VPS public/uploads pesa GB, así
//   que acá se bundlea con un `--public-dir` VACÍO y después se
//   reemplaza `X/public` por un symlink al public/ real del proyecto --
//   exactamente lo que el propio CLI de render hace con sus bundles
//   temporales. El servidor estático de Remotion hace `lstat` solo de
//   la ruta pedida (archivo), no de sus carpetas padre, así que sirve
//   archivos bajo un public/ enlazado (es como funciona el render
//   normal de producción hoy).
//
// Se usa el CLI (`npx remotion bundle`) en un proceso hijo, no el API
// `bundle()` dentro del servidor: así respeta remotion.config.ts
// (rspack, etc.) igual que el render de producción, y la memoria del
// bundler se libera al terminar en vez de quedarse en el proceso del
// servidor.
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const MARKER_FILE = ".fabrica-videos-bundle.json";

/** Pura: decide si un bundle existente sirve para esta versión (mismo `versionTag`) -- nunca reutiliza uno de otra imagen. */
export const isBundleMarkerValid = (marker, versionTag) => Boolean(marker && typeof marker === "object" && marker.versionTag === versionTag && marker.complete === true);

const readMarker = async (bundleDir) => {
  try {
    return JSON.parse(await fs.readFile(path.join(bundleDir, MARKER_FILE), "utf8"));
  } catch {
    return null;
  }
};

const runBundleCli = ({ npxCommand, cwd, env, entryPoint, outDir, publicDir, onLog }) =>
  new Promise((resolve, reject) => {
    const args = ["remotion", "bundle", entryPoint, `--out-dir=${outDir}`, `--public-dir=${publicDir}`, "--log=warn", "--disable-git-source"];
    const child = spawn(npxCommand, args, { cwd, env });
    let tail = "";
    const capture = (chunk) => {
      tail = (tail + chunk.toString("utf8")).slice(-4000);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        onLog(`remotion bundle falló (code=${code} signal=${signal}): ${tail}`);
        reject(new Error(`remotion bundle salió con code=${code} signal=${signal}: ${tail}`));
      }
    });
  });

/**
 * Garantiza un bundle listo en `bundleDir` para `versionTag` y devuelve
 * su ruta. Reutiliza el existente si el marcador coincide (una sola
 * vez por imagen/proceso); si no, lo construye desde cero. `public/`
 * queda como symlink al del proyecto, así los uploads nuevos se ven
 * sin re-bundlear.
 */
export const ensureRenderBundle = async ({ projectRoot, bundleDir, versionTag, entryPoint = "src/index.ts", npxCommand = "npx", env = process.env, force = false, onLog = () => {} }) => {
  const startedAt = Date.now();
  const existing = await readMarker(bundleDir);
  const indexExists = await fs
    .access(path.join(bundleDir, "index.html"))
    .then(() => true)
    .catch(() => false);
  if (!force && indexExists && isBundleMarkerValid(existing, versionTag)) {
    onLog(`bundle de Remotion reutilizado (${bundleDir}, versión ${versionTag}) -- sin bundling en esta invocación.`);
    return { bundleDir, reused: true, ms: Date.now() - startedAt };
  }

  await fs.rm(bundleDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(bundleDir), { recursive: true });
  const emptyPublicDir = `${bundleDir}.empty-public`;
  await fs.rm(emptyPublicDir, { recursive: true, force: true });
  await fs.mkdir(emptyPublicDir, { recursive: true });
  onLog(`construyendo el bundle de Remotion una sola vez (${bundleDir}, versión ${versionTag})...`);
  await runBundleCli({ npxCommand, cwd: projectRoot, env, entryPoint, outDir: bundleDir, publicDir: emptyPublicDir, onLog });
  await fs.rm(emptyPublicDir, { recursive: true, force: true });

  const bundlePublic = path.join(bundleDir, "public");
  await fs.rm(bundlePublic, { recursive: true, force: true });
  await fs.symlink(path.join(projectRoot, "public"), bundlePublic);

  await fs.writeFile(path.join(bundleDir, MARKER_FILE), JSON.stringify({ versionTag, complete: true, createdAt: new Date().toISOString() }, null, 2));
  const ms = Date.now() - startedAt;
  onLog(`bundle de Remotion listo en ${ms}ms -- las invocaciones siguientes lo reutilizan sin bundling.`);
  return { bundleDir, reused: false, ms };
};
