// PRUEBA DE REGRESIÓN -- defecto real (02-nov-2026): 7 archivos
// `.status.json` encontrados con un JSON válido seguido de caracteres
// sobrantes. Esta prueba reproduce el MECANISMO EXACTO de esa
// corrupción de forma determinística (sin depender de una carrera real
// del sistema operativo, que sería intermitente) y confirma que
// `createAtomicJsonWriter` (server/atomic-json-store.mjs) no la sufre,
// incluso bajo la misma presión de llamadas simultáneas sin esperar
// ("fire and forget") que usa `writeStatus()` en server/index.mjs.
//
// No se puede levantar server/index.mjs en esta prueba (arranca un
// servidor Express real e intenta escuchar un puerto al importarse) --
// por eso la corrección vive en su propio módulo, igual que el resto
// del proyecto.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAtomicJsonWriter, atomicWriteFile } from "./atomic-json-store.mjs";

let failures = 0;
const check = (label, cond, detail = "") => {
  if (!cond) {
    failures++;
    console.log(`FAIL: ${label}${detail ? ` -- ${detail}` : ""}`);
  } else {
    console.log(`ok: ${label}`);
  }
};

const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vf-atomic-json-store-"));

// --- Reproducción determinística del defecto real (código ANTERIOR,
// no atómico) ------------------------------------------------------

/**
 * La forma EXACTA de la corrupción real: el escritor con contenido
 * CORTO abre el archivo (lo trunca) PRIMERO, pero su escritura real
 * queda pendiente; el escritor con contenido LARGO abre (trunca otra
 * vez) y escribe + cierra COMPLETO; recién ENTONCES el escritor corto
 * hace su propia escritura -- sobrescribe desde el byte 0 pero, como
 * su propio `open()` ya truncó antes (nunca vuelve a truncar en el
 * `write()`), deja sin tocar la cola del contenido largo que queda
 * más allá de donde llegó el corto. Usa los mismos primitivos de bajo
 * nivel que `fs.writeFile` usa por dentro (open con truncado + write +
 * close), controlando el ORDEN a propósito para que la prueba sea
 * determinística, no una carrera intermitente.
 */
const reproduceRealCorruptionMechanism = async (filePath, shortContent, longContent) => {
  const shortHandle = await fsp.open(filePath, "w"); // 1) trunca PRIMERO, no escribe todavía
  const longHandle = await fsp.open(filePath, "w"); // 2) trunca OTRA VEZ, luego escribe y cierra completo
  await longHandle.writeFile(longContent);
  await longHandle.close();
  await shortHandle.writeFile(shortContent); // 3) recién ahora -- su open ya truncó en el paso 1
  await shortHandle.close();
};

{
  const filePath = path.join(tmpDir, "reproduccion-defecto-real.status.json");
  const shortContent = JSON.stringify({ status: "queued" }); // 19 bytes
  const longContent = JSON.stringify({
    status: "downloading",
    createdAt: "2026-11-02T00:00:00.000Z",
    note: "contenido bastante más largo, para asegurar que quede una cola sobrante real y no una coincidencia de longitud",
  });
  check("reproducción: el contenido corto es de verdad más corto que el largo (si no, la prueba no probaría nada)", shortContent.length < longContent.length);

  await reproduceRealCorruptionMechanism(filePath, shortContent, longContent);
  const raw = await fsp.readFile(filePath, "utf8");

  check("reproducción del defecto real: el archivo completo NO es JSON válido (justo el defecto reportado)", (() => {
    try {
      JSON.parse(raw);
      return false; // si parseó, no reprodujimos el defecto
    } catch {
      return true;
    }
  })());
  check("reproducción: el PREFIJO sí es el JSON corto, completo y válido", raw.startsWith(shortContent) && (() => {
    try {
      JSON.parse(raw.slice(0, shortContent.length));
      return true;
    } catch {
      return false;
    }
  })());
  check("reproducción: hay bytes sobrantes después del JSON válido (la cola del contenido largo)", raw.length > shortContent.length);
  console.log(`  (evidencia: archivo de ${raw.length} bytes, JSON válido en los primeros ${shortContent.length}, ${raw.length - shortContent.length} byte(s) sobrante(s) después -- confirma el mecanismo reportado por el operador)`);
}

// --- atomicWriteFile por sí sola --------------------------------

{
  const filePath = path.join(tmpDir, "atomic-solo.json");
  await atomicWriteFile(filePath, JSON.stringify({ a: 1 }));
  const raw = await fsp.readFile(filePath, "utf8");
  check("atomicWriteFile: el archivo final es JSON válido", (() => {
    try {
      JSON.parse(raw);
      return true;
    } catch {
      return false;
    }
  })());
  const siblingFiles = await fsp.readdir(tmpDir);
  check("atomicWriteFile: no deja ningún archivo temporal suelto en el directorio", !siblingFiles.some((f) => f.includes(".tmp-")));
}

// --- La MISMA presión que sufrió el código real (llamadas "fire and
// forget" sin esperar, para el mismo job) NO corrompe con el escritor
// nuevo ------------------------------------------------------------

{
  const filePath = path.join(tmpDir, "mismo-job-sin-esperar.status.json");
  const writer = createAtomicJsonWriter();
  // Exactamente el patrón real: "queued" (corto) seguido, sin ningún
  // await de por medio, por "downloading" (más largo) -- el mismo par
  // que produce la corrupción en server/index.mjs si no se corrige.
  const p1 = writer.write("job-x", filePath, { status: "queued", createdAt: "2026-11-02T00:00:00.000Z" });
  const p2 = writer.write("job-x", filePath, {
    status: "downloading",
    createdAt: "2026-11-02T00:00:00.000Z",
    note: "contenido más largo para la misma clave, llamado sin esperar al primero",
  });
  await Promise.all([p1, p2]);

  const raw = await fsp.readFile(filePath, "utf8");
  let parsed;
  check("mismo job, sin esperar: el archivo final SIGUE siendo JSON válido (a diferencia del código anterior)", (() => {
    try {
      parsed = JSON.parse(raw);
      return true;
    } catch {
      return false;
    }
  })());
  check("mismo job, sin esperar: el archivo final tiene el ÚLTIMO estado llamado (downloading), no el primero", parsed?.status === "downloading");
  const siblingFiles = await fsp.readdir(tmpDir);
  check("mismo job, sin esperar: no quedan archivos temporales sueltos", !siblingFiles.some((f) => f.includes(".tmp-")));
}

// --- Numerosas actualizaciones consecutivas del mismo job ----------

{
  const filePath = path.join(tmpDir, "muchas-actualizaciones.status.json");
  const writer = createAtomicJsonWriter();
  const TOTAL = 200;
  const promises = [];
  // Todas disparadas SIN esperar entre sí -- igual que writeStatus()
  // real, llamada muchas veces seguidas mientras un job avanza.
  for (let i = 0; i < TOTAL; i++) {
    promises.push(
      writer.write("job-stress", filePath, {
        sequence: i,
        // Alterna longitudes de contenido a propósito (par más largo,
        // impar más corto) para no favorecer un solo patrón de
        // tamaño -- el defecto real podía darse en cualquier
        // dirección.
        padding: i % 2 === 0 ? "x".repeat(50) : "y",
      }),
    );
  }
  await Promise.all(promises);

  const raw = await fsp.readFile(filePath, "utf8");
  let parsed;
  check("muchas actualizaciones (200, sin esperar entre sí): el archivo final es JSON válido", (() => {
    try {
      parsed = JSON.parse(raw);
      return true;
    } catch {
      return false;
    }
  })());
  check("muchas actualizaciones: el archivo final tiene la ÚLTIMA secuencia emitida (199), ninguna otra la pisó después", parsed?.sequence === TOTAL - 1);
  const siblingFiles = await fsp.readdir(tmpDir);
  check("muchas actualizaciones: no quedan archivos temporales sueltos tras 200 escrituras", !siblingFiles.some((f) => f.includes(".tmp-")));
}

// --- Claves distintas no se bloquean entre sí -----------------------

{
  const filePathA = path.join(tmpDir, "job-a.status.json");
  const filePathB = path.join(tmpDir, "job-b.status.json");
  const writer = createAtomicJsonWriter();
  await Promise.all([
    writer.write("job-a", filePathA, { status: "done", job: "a" }),
    writer.write("job-b", filePathB, { status: "done", job: "b" }),
  ]);
  const [rawA, rawB] = await Promise.all([fsp.readFile(filePathA, "utf8"), fsp.readFile(filePathB, "utf8")]);
  check("jobs distintos: cada uno con su propio contenido correcto, sin interferencia cruzada", JSON.parse(rawA).job === "a" && JSON.parse(rawB).job === "b");
}

// --- Errores de escritura se reportan, nunca se ocultan -------------

{
  const reported = [];
  const writer = createAtomicJsonWriter({ onError: (key, err) => reported.push({ key, message: err.message }) });
  // Ruta imposible de escribir (directorio padre inexistente) -- debe
  // fallar la escritura, reportarse, y NO lanzar ni romper nada.
  const badPath = path.join(tmpDir, "directorio-inexistente", "no-se-puede-escribir.json");
  await writer.write("job-malo", badPath, { status: "x" });
  check("error de escritura: se reportó vía onError (nunca un callback vacío)", reported.length === 1 && reported[0].key === "job-malo");
  check("error de escritura: no corrompe ni bloquea escrituras futuras de la misma clave", await (async () => {
    const goodPath = path.join(tmpDir, "despues-del-error.json");
    await writer.write("job-malo", goodPath, { status: "ok" });
    const raw = await fsp.readFile(goodPath, "utf8");
    return JSON.parse(raw).status === "ok";
  })());
}

await fsp.rm(tmpDir, { recursive: true, force: true });

console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
process.exit(failures === 0 ? 0 : 1);
