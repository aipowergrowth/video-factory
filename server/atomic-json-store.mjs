// Escritura atómica (archivo temporal + rename) y serializada por
// clave -- extraído de server/index.mjs (defecto real, 02-nov-2026: el
// operador encontró 7 archivos `.status.json` con un JSON válido
// seguido de caracteres sobrantes).
//
// Causa raíz verificada, no asumida: `writeStatus()` llamaba
// `fs.writeFile` (no atómico: abre con truncado, escribe, cierra) sin
// esperar su propia finalización ni la de la llamada anterior para el
// MISMO job. Ejemplo real y concreto, no hipotético, en el propio
// server/index.mjs: `enqueue()` escribe el estado "queued" y, en el
// mismo tick (con solo una lectura de archivo de por medio),
// `processQueue()` ya está corriendo `resolveJobInput()`, que escribe
// "downloading" -- dos `fs.writeFile` al mismo path, despachados al
// threadpool de libuv sin ninguna sincronización entre ellos.
//
// Mecanismo exacto de la corrupción (reproducido y confirmado en
// test-atomic-json-store.mjs, no solo razonado): si el escritor con
// contenido MÁS CORTO abre el archivo (lo trunca) ANTES de que el
// escritor con contenido MÁS LARGO termine de escribir, pero el corto
// recién escribe DESPUÉS de que el largo ya terminó y cerró, el
// `write()` del corto sobrescribe desde el byte 0 pero -- como su
// propio `open()` ya truncó antes, no vuelve a truncar en el
// `write()` -- deja sin tocar la cola del contenido largo que queda
// más allá de donde llegó el corto. Resultado: JSON válido (el corto)
// seguido de caracteres sobrantes (la cola del largo). El callback de
// error vacío de la versión anterior hacía que esto (y cualquier otro
// fallo de escritura) nunca apareciera en ningún lado.
//
// Esta corrección resuelve las dos causas a la vez:
// - ATÓMICA: cada escritura va a un archivo temporal ÚNICO en el
//   MISMO directorio, y solo se reemplaza el archivo final con
//   `rename()` -- en POSIX, `rename()` dentro del mismo sistema de
//   archivos es una única operación atómica: un lector nunca puede
//   ver un archivo a medio escribir, y no hay forma de que el
//   contenido de dos escrituras distintas termine mezclado en el
//   archivo final.
// - SERIALIZADA POR CLAVE: una cola de promesas (una por clave)
//   encadena cada escritura a la anterior de la MISMA clave -- llegan
//   a disco en el mismo orden en que se llamó a `write()`, así que una
//   operación vieja nunca puede terminar después y pisar a una más
//   nueva. Claves distintas (jobs distintos) se siguen escribiendo en
//   paralelo entre sí, sin bloquearse mutuamente.
// - Cualquier error de escritura/rename se reporta vía `onError`,
//   nunca se oculta en un callback vacío.

import fsp from "node:fs/promises";
import crypto from "node:crypto";

/** Solo para pruebas directas de la escritura atómica en sí, sin la cola de serialización. */
export const atomicWriteFile = async (filePath, content) => {
  const tmpPath = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await fsp.writeFile(tmpPath, content);
  await fsp.rename(tmpPath, filePath);
};

/**
 * Crea un escritor de JSON atómico y serializado por clave (ver
 * comentario grande arriba). `write(key, filePath, data)` nunca lanza
 * -- cualquier fallo se reporta vía `onError(key, err)` y no rompe las
 * escrituras futuras de esa misma clave (ni de ninguna otra). Devuelve
 * la promesa de ESA escritura puntual -- los llamadores existentes
 * pueden ignorarla (igual que antes, "fire and forget"); las pruebas
 * la usan para esperar a que de verdad termine antes de leer el
 * archivo. `forget(key)` libera la entrada de la cola para una clave
 * que ya no se va a volver a escribir (p.ej. un job que se limpió).
 */
export const createAtomicJsonWriter = ({ onError = (key, err) => console.error(`[atomic-json-store] ${key}:`, err) } = {}) => {
  const queues = new Map();

  const write = (key, filePath, data) => {
    const content = JSON.stringify(data, null, 2);
    const previous = queues.get(key) ?? Promise.resolve();
    const queued = previous.then(() =>
      atomicWriteFile(filePath, content).catch((err) => {
        onError(key, err);
      }),
    );
    queues.set(key, queued);
    return queued;
  };

  const forget = (key) => {
    queues.delete(key);
  };

  return { write, forget };
};
