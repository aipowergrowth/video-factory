# Desplegar fabrica-videos en tu Portainer — guía paso a paso

Esta guía no usa la terminal en ningún paso. Todo es clic a clic, en
github.com y en tu Portainer.

Cómo queda montado:
- El código vive en `github.com/aipowergrowth/video-factory` (privado).
- Cada vez que se sube un cambio a `main`, GitHub construye la imagen y la
  publica sola en `ghcr.io/aipowergrowth/fabrica-videos-engine` — no hace
  falta que tú hagas nada para eso, ya está funcionando.
- El servicio **no publica ningún puerto a Internet**. Solo es alcanzable
  desde dentro de tu red Docker `aipowergrowthrpa` (la misma donde corre
  n8n), por su nombre: `fabrica-videos-engine`, puerto `3001`.

## Paso 1 — Hacer pública la imagen en GitHub (una sola vez)

Por defecto, el paquete que publica GitHub Actions queda privado, y hacer
que Portainer pueda descargar una imagen privada implica un paso extra
(crear y guardar un token). Como la imagen solo contiene el código del
motor (nada de tus videos, ni credenciales, ni datos de clientes — esos
viven en volúmenes aparte), recomiendo dejarla pública: así Portainer la
descarga sin necesitar ninguna contraseña.

1. Ve a **https://github.com/aipowergrowth/video-factory** → pestaña
   **Packages** (o directamente
   `github.com/aipowergrowth/video-factory/pkgs/container/fabrica-videos-engine`
   una vez que exista el primer build).
2. Clic en el paquete **fabrica-videos-engine** → **Package settings**
   (abajo a la derecha).
3. Baja hasta **Danger Zone** → **Change visibility** → **Public** →
   confirma escribiendo el nombre cuando te lo pida.

*(Si prefieres mantenerla privada, dímelo y te paso en su lugar los pasos
para crear un token y añadir el registro con credenciales en Portainer —
son 3-4 clics más.)*

## Paso 2 — Crear los secretos y el stack en Portainer

Dos secretos (nunca van en el repo ni en el YAML del stack):

1. Menú lateral → **Secrets** → **+ Add secret**.
   - **Name**: `drive_service_account_json`. **Content**: pega el JSON
     completo de la cuenta de servicio de Google Drive.
2. Otra vez **+ Add secret**.
   - **Name**: `anthropic_api_key`. **Content**: solo la clave
     (`sk-ant-...`), sin comillas ni nombre de variable delante.

Ahora el stack:

1. Entra a tu Portainer → elige tu entorno (el que tiene la red
   `aipowergrowthrpa`).
2. Menú lateral → **Stacks** → **+ Add stack**.
3. **Name**: `fabrica-videos-engine`.
4. **Build method**: `Web editor`.
5. Pega exactamente el contenido de [`docker-stack.yml`](docker-stack.yml)
   (vive en la raíz del repo; se mantiene ahí para no duplicarlo y que
   nunca quede desactualizado aquí).
6. Baja y clic en **Deploy the stack**.

## Paso 3 — Qué vas a ver si salió bien

1. Portainer te devuelve a **Stacks**, y aparece `fabrica-videos-engine`
   con un punto/etiqueta **verde** (running).
2. Si entras al stack → pestaña **Services** (o **Containers**, según tu
   versión), el servicio `fabrica-videos-engine` muestra **1/1** réplicas
   activas — no 0/1 ni "pending".
3. Clic en el servicio → **Logs**. Deberías ver estas líneas (puede tardar
   10-20 segundos en aparecer):
   ```
   fabrica-videos API escuchando en :3001
     uploads/jobs   -> /app/public/uploads/jobs
     uploads/videos -> /app/public/uploads/videos
     outputs        -> /data/outputs
     concurrencia de renders -> 1
   ```
   Eso confirma que arrancó bien. Si en vez de eso ves errores repetidos o
   el contenedor reiniciándose en bucle, copia el log y lo revisamos.
4. **No vas a poder** abrir nada en el navegador tipo
   `http://tu-vps:3001` — es intencional, el puerto no está publicado.
   Para confirmar que n8n sí lo alcanza: en un workflow de n8n, agrega un
   nodo **HTTP Request**, método `GET`, URL
   `http://fabrica-videos-engine:3001/health`, y ejecútalo. Si todo está
   bien conectado, la respuesta es:
   ```json
   { "ok": true, "active": 0, "queued": 0 }
   ```
   Si en cambio da un error de conexión/DNS, lo más probable es que el
   servicio de n8n no esté en la misma red `aipowergrowthrpa` — revisa en
   Portainer que el stack de n8n también tenga esa red asociada.

## Integración con n8n

Contrato de la API (sin cambios respecto a la versión anterior de esta
guía):

| Método | Ruta | Qué hace |
|---|---|---|
| `POST` | `http://fabrica-videos-engine:3001/jobs` | `multipart/form-data`: campo `video` + campo `job` (JSON del trabajo). Devuelve `{ "jobId": "..." }`. |
| `GET` | `http://fabrica-videos-engine:3001/jobs/:id` | Estado: `queued` / `rendering` / `done` / `error`. |
| `GET` | `http://fabrica-videos-engine:3001/jobs/:id/download` | Descarga el MP4 cuando `status` es `"done"`. |

El cuerpo de `job` sigue el esquema `EngineJob` (`channel`, `destination`,
`input.type`, `overlays`, `captions`) — ver `README.md` del repo para el
detalle completo.

## Actualizar el servicio más adelante

Cada vez que haya un cambio de código, GitHub Actions publica sola una
nueva imagen `:latest`. Para que Portainer la use:

1. Entra al stack `fabrica-videos-engine` en Portainer.
2. Clic en **Update the stack** (o, si no refresca la imagen,
   **Pull and redeploy** desde el servicio).

No hace falta tocar el YAML ni ningún token.

## Qué NO está resuelto todavía

- No hay reintentos automáticos si un render muere a mitad (el job queda
  en `"error"`).
- No hay autenticación en la API — cualquier contenedor dentro de la red
  `aipowergrowthrpa` puede mandarle trabajos. Como esa red no está
  expuesta a Internet, el riesgo está acotado a "algo más en tu Swarm
  queda comprometido", no a Internet en general.
- El estado de los jobs vive en memoria: si el contenedor se reinicia a
  mitad de un render, se pierde el registro de ese job puntual (los
  archivos ya guardados en los volúmenes sí sobreviven).

## Lo que está probado y lo que no

- **Probado de verdad, con renders reales**: el motor (`VideoEngine`), los
  perfiles de canal, y la API (`server/index.mjs`) completa — subida,
  cola, render, descarga — corriendo en esta Mac (ver `README.md` para el
  detalle de cómo, dado que esta Mac tiene macOS 12).
- **No probado**: el build real en GitHub Actions (se disparó al subir el
  código; confírmalo en la pestaña **Actions** del repo), ni el despliegue
  en tu Portainer real, ni la integración con tu n8n real. Esta guía está
  escrita con el máximo cuidado posible pero la primera vez que la sigas
  hay que tratarla como una prueba, no como algo ya verificado end to end.
