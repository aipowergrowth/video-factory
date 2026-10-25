# Despliegue en VPS (Portainer / Docker Swarm)

Swarm no construye imágenes dentro del stack: hay que construir la imagen
en otro sitio (tu laptop, o un runner de CI) y publicarla en un registro;
el stack en Portainer solo la descarga (`image: ...`, sin `build:`).

> ⚠️ **Lo que sí se probó y lo que no**, honestamente:
> - El motor (composición `VideoEngine`) y la API (`server/index.mjs`) se
>   probaron de punta a punta **en esta Mac**, usando el navegador Brave y
>   binarios de `@remotion/compositor-darwin-x64@4.0.200` como sustituto de
>   lo que Remotion usaría en Linux (ver README para el porqué).
> - La imagen Docker, el Dockerfile, `docker-stack.yml` y el registro
>   privado **no se construyeron ni se desplegaron**: no hay Docker
>   instalado en esta máquina. Están escritos siguiendo al pie de la letra
>   la guía oficial de Remotion para Linux (`remotion.dev/docs/docker`),
>   pero la primera vez que los uses en tu VPS hay que tratarlos como
>   "primera prueba", no como "ya verificado".

## 1. Construir la imagen

En una máquina con Docker (tu laptop o un runner CI — no hace falta que
sea el VPS):

```console
docker build -t fabrica-videos-engine:v1 .
```

## 2. Publicar en un registro privado

### Opción A — Registro autoalojado en el mismo VPS (recomendado si no tienes uno)

1. Despliega `registry/docker-stack.yml` una sola vez en tu Portainer:
   ```console
   mkdir -p registry/auth
   docker run --rm --entrypoint htpasswd httpd:2.4-alpine -Bbn deploy "UNA_CONTRASEÑA_FUERTE" > registry/auth/htpasswd
   docker stack deploy -c registry/docker-stack.yml registry
   ```
2. Desde tu máquina de build, inicia sesión y publica:
   ```console
   docker login tu-vps.tudominio.com:5000 -u deploy
   docker tag fabrica-videos-engine:v1 tu-vps.tudominio.com:5000/fabrica-videos-engine:v1
   docker push tu-vps.tudominio.com:5000/fabrica-videos-engine:v1
   ```
   (Si el registro no tiene HTTPS con certificado válido, hay que añadir su
   host como "Insecure registry" en la configuración del daemon Docker que
   hace el push, o ponerle un proxy con TLS delante — por simplicidad, lo
   más fácil es dejar Traefik/Nginx del propio VPS haciendo TLS hacia este
   puerto.)

### Opción B — GitHub Container Registry / Docker Hub

Exactamente el mismo flujo, solo cambia el host:

```console
docker login ghcr.io -u tu-usuario
docker tag fabrica-videos-engine:v1 ghcr.io/tu-usuario/fabrica-videos-engine:v1
docker push ghcr.io/tu-usuario/fabrica-videos-engine:v1
```

## 3. Desplegar el stack en Portainer

1. Edita `docker-stack.yml`: cambia `image:` a la ruta que publicaste en
   el paso 2.
2. En Portainer → Stacks → Add stack → pega el contenido de
   `docker-stack.yml` (o apunta a este repo si usas Git-based stacks).
3. Si el registro privado necesita login, añade las credenciales del
   registro en Portainer (Registries) antes de desplegar, para que el
   nodo Swarm pueda hacer `pull`.

Lo que trae el stack:
- **Almacenamiento persistente**: dos volúmenes con nombre —
  `fabrica_videos_inputs` (videos y jobs subidos) y
  `fabrica_videos_outputs` (MP4 renderizados). Sobreviven a redeploys del
  stack.
- **Límites de recursos**: 4 CPU / 6 GB como tope (`deploy.resources.limits`),
  con una reserva mínima de 1 CPU / 2 GB.
- **Puerto 3001** publicado para que n8n le mande trabajos. Si n8n corre en
  el mismo Swarm, mejor unir ambos servicios a la misma red overlay (hay un
  bloque comentado en el propio `docker-stack.yml`) y no publicar el puerto
  al exterior.

## 4. Integración con n8n

Contrato HTTP de la API (ver `server/index.mjs`):

| Método | Ruta | Qué hace |
|---|---|---|
| `POST` | `/jobs` | `multipart/form-data`: campo `video` (el archivo) + campo `job` (JSON del trabajo, sin `input.baseVideo` — lo rellena el servidor). Devuelve `{ "jobId": "..." }` (HTTP 202). |
| `GET` | `/jobs/:id` | Estado: `{ "status": "queued"\|"rendering"\|"done"\|"error", "error"?: "..." }` |
| `GET` | `/jobs/:id/download` | Descarga el MP4 (solo cuando `status` es `"done"`) |

Flujo típico en n8n:
1. **HTTP Request** (POST, multipart) → `http://fabrica-videos-engine:3001/jobs`
2. **Wait** + **HTTP Request** (GET) en bucle a `/jobs/{{ $json.jobId }}`
   hasta que `status` sea `done` o `error` (un nodo `If` + `Wait` + loop, o
   el nodo "Wait for Webhook" si prefieres que el servicio te avise — hoy
   no hay webhook de salida, solo polling).
3. **HTTP Request** (GET) → `/jobs/{{jobId}}/download`, respuesta binaria,
   para subirlo a YouTube, mandarlo por Telegram, guardarlo en Drive, etc.

El cuerpo de `job` sigue el esquema `EngineJob` de `src/types.ts`
(`channel`, `destination`, `input.type`, `overlays`, `captions`) — igual
que los archivos de `public/jobs/*.json`, solo que aquí `input.baseVideo`
se omite porque lo completa el upload.

**Importante**: el video subido debe estar en H.264/VP8/VP9/AV1. HEVC
(típico de iPhone) se rechaza con HTTP 422 y un mensaje claro — es una
lección real de esta sesión, no una suposición (ver README).

## 5. Qué NO está resuelto todavía

- No hay reintentos automáticos si el proceso de render muere a mitad
  (el job queda en `"error"` y no se reencola solo).
- No hay autenticación en la API — si el puerto 3001 queda expuesto a
  Internet, cualquiera puede mandar trabajos. Para producción real, al
  menos pon la API detrás de la red interna del Swarm (ver punto 3) o
  añade un header/API key delante (no implementado).
- El estado de los jobs vive en memoria del proceso: si el contenedor se
  reinicia a mitad de un render, se pierde el registro de ese job (los
  archivos de entrada/salida si ya existían sí sobreviven en los
  volúmenes).
