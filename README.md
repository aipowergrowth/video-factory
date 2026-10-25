# fábrica-videos

Motor de fabricación de videos de YouTube para los canales **A mí no me
cuadra**, **Alex Cripto y Negocios** y **La Nave Tierra**, construido con
Remotion.

Es **un solo motor** (`VideoEngine`), no una composición por canal: recibe
un "trabajo" (`EngineJob`) que dice qué **canal**, a qué **destino**
(horizontal 16:9 para YouTube o vertical 9:16 para Shorts/Reels) y con qué
**entrada** — hoy, un video ya grabado — hay que producir, más las
inserciones (overlays) y subtítulos ya decididos. El aspecto editorial de
cada canal (colores, correcciones de transcripción) vive en archivos de
configuración fuera del código, en `public/channels/`.

## Comandos

```console
npm i                 # instalar dependencias
npm run dev            # Remotion Studio (previsualización)
npm run lint            # tipos (tsc) + estilo (eslint)
npm run server           # levanta la API HTTP (ver server/index.mjs y DEPLOY.md)
```

**Renderizar un video:**

```console
npx remotion render VideoEngine out/video.mp4 --props='{"jobFile":"jobs/mi-video.json"}'
```

⚠️ En esta Mac (macOS 12.7.6) ese comando por sí solo **no funciona** —
ver [Renderizar en macOS 12](#renderizar-en-macos-12-monterey).

## Arquitectura del motor

```
src/
  engine/
    VideoEngineComposition.tsx  -> registra la ÚNICA <Composition id="VideoEngine">;
                                   calcula ancho/alto desde `destination` y
                                   carga el perfil del `channel` en tiempo de render
    VideoEngine.tsx              -> video base + overlays + captions, con el
                                   tema del canal aplicado vía contexto
    loadJob.ts                   -> carga/valida public/jobs/<archivo>.json
    sources/
      Source.tsx                 -> despacha por `input.type` (punto de extensión)
      RecordedVideoSource.tsx     -> entrada de hoy: un video ya grabado
    theme/ThemeContext.tsx        -> perfil editorial del canal (colores)
    OverlayRenderer.tsx, ImageOverlay.tsx, BRollOverlay.tsx, TextOverlay.tsx,
    Captions.tsx, Fade.tsx        -> overlays reutilizables (sin cambios de lógica
                                    desde la primera versión; solo se movieron aquí)
  graphics/
    Chart.tsx, CycleDiagram.tsx, StatCallout.tsx  -> gráficos/diagramas en código
  channels/
    loadChannelProfile.ts         -> carga public/channels/<channel>/profile.json
  types.ts                        -> EngineJob, Destination, EngineInput, Overlay,
                                    ChannelProfile, CorrectionRule
```

### Sumar un tipo de entrada nuevo (p.ej. guion + audio + imágenes)

No hace falta reconstruir nada de overlays/captions/canales. Solo:

1. Añadir el variante en `EngineInput` (`src/types.ts`).
2. Crear su componente de fuente en `src/engine/sources/`.
3. Añadir el `case` correspondiente en `src/engine/sources/Source.tsx` y en
   `src/engine/getDurationInSeconds.ts`.

### Destinos soportados

| `destination` | Dimensiones |
|---|---|
| `youtube-16-9` | 1920x1080 |
| `vertical-9-16` | 1080x1920 |

Ambos a 30 FPS. El mismo `baseVideo` se recorta/ajusta (`objectFit: cover`)
al lienzo elegido — no hay recentrado inteligente de sujeto, es un ajuste
literal (ver `RecordedVideoSource.tsx`).

## Esquema de un trabajo (`EngineJob`, JSON)

```jsonc
{
  "channel": "a-mi-no-me-cuadra",       // debe existir public/channels/<channel>/profile.json
  "destination": "youtube-16-9",         // o "vertical-9-16"
  "input": {
    "type": "recorded-video",            // único tipo implementado hoy
    "baseVideo": "videos/original.mp4",  // dentro de public/
    "durationInSeconds": 30
  },
  "overlays": [
    { "id": "broll-apertura", "type": "broll", "startSeconds": 3, "durationSeconds": 4, "src": "broll/apertura.mp4", "muted": true },
    { "id": "imagen-grafico", "type": "image", "startSeconds": 10, "durationSeconds": 3, "src": "images/grafico.png" },
    { "id": "texto-dato", "type": "text", "startSeconds": 15, "durationSeconds": 3, "text": "Dato clave" },
    { "id": "diagrama", "type": "graphic", "graphic": "cycle", "startSeconds": 20, "durationSeconds": 5, "props": { "title": "...", "steps": ["A", "B", "C"] } }
  ],
  "captions": []  // subtítulos sincronizados; estructura lista, puede ir vacío
}
```

Los huecos entre overlays se dejan tal cual, mostrando solo el video base:
**los segmentos sin B-roll están soportados de forma nativa**.

### Carpetas en `public/`

```
public/
  jobs/        -> un .json por video (el EngineJob)
  channels/
    <channel>/profile.json      -> tema editorial (colores)
    <channel>/corrections.json  -> correcciones de transcripción (ver abajo)
  videos/, broll/, images/      -> assets
  uploads/jobs/, uploads/videos/ -> escritos en tiempo real por server/index.mjs
                                    (API/Docker); no se versionan en git
```

## Perfiles editoriales por canal

`public/channels/<channel>/profile.json`:

```jsonc
{
  "channelId": "a-mi-no-me-cuadra",
  "displayName": "A mí no me cuadra",
  "theme": {
    "accentColor": "#E53935",
    "captionBackgroundColor": "rgba(0,0,0,0.6)",
    "captionTextColor": "#ffffff"
  }
}
```

`VideoEngineComposition` carga este archivo en `calculateMetadata` y lo
inyecta vía contexto (`src/engine/theme/ThemeContext.tsx`); los overlays
(`TextOverlay`, `Captions`, `StatCallout`, `CycleDiagram`) lo consumen con
`useEngineTheme()`. Sin perfil (o si falla la carga), se usa un tema por
defecto idéntico al que tenían los overlays antes de que existiera esto —
no cambia nada retroactivamente.

Ya existen perfiles para los tres canales. Los de **Alex Cripto y
Negocios** y **La Nave Tierra** son placeholders (un color razonable, sin
contenido real todavía) listos para ajustar.

### Registro de correcciones (ASR)

`public/channels/<channel>/corrections.json` — un archivo por canal, como
se pidió:

```jsonc
[
  { "from": "cameron cepa", "to": "Cameron Sepah" },
  { "from": "puro hay", "to": "puro hype" }
]
```

Lo consume `scripts/group_captions.mjs` (no el motor de render — las
correcciones se aplican al generar los subtítulos, antes de meterlos en el
`EngineJob`). Corrige por **frase**, no por palabra suelta, y se aplica
antes de partir el texto en líneas de subtítulo — así una corrección no se
pierde si la frase cae justo en el límite entre dos líneas (least la
palabra "hay" que sí es correcta en otras partes de la misma transcripción
no se toca). El de **a-mi-no-me-cuadra** trae las correcciones reales que
hicieron falta para el primer video; los otros dos canales están
preparados pero vacíos (`[]`).

## Transcripción y subtítulos (whisper.cpp local)

```console
node scripts/transcribe.mjs ruta/al/audio.wav ruta/salida/captions.json medium auto
node scripts/group_captions.mjs ruta/palabras.json ruta/lineas.json public/channels/<channel>/corrections.json
```

- `transcribe.mjs`: modelo (`medium` va bien en español) + idioma. **Importante:**
  si se omite el idioma, la librería usa `en` por defecto y fuerza una
  transcripción/traducción incorrecta en videos que no están en inglés —
  usar siempre `auto` (o `es`).
- `group_captions.mjs`: agrupa las palabras sueltas en líneas legibles
  (respetando límites de palabra) y aplica el registro de correcciones del
  canal si se le pasa como tercer argumento.

Para recortar el video/audio original a los segundos que se necesiten (sin
ffmpeg, con AVFoundation nativo de macOS):

```console
swift scripts/trim_audio.swift entrada.mp4 salida.m4a <duracionSeg> <inicioSeg>
swift scripts/trim_video.swift entrada.mp4 salida.mp4 <duracionSeg> <inicioSeg>
```

`trim_video.swift` reencoda a H.264: el Chromium que usa Remotion para
renderizar **no decodifica HEVC/H.265** (formato típico de iPhone/cámara).
Todo video original en HEVC debe pasar por aquí (o por el equivalente en
la API — ver abajo) antes de usarse como `baseVideo`.

## Renderizar en macOS 12 (Monterey)

Esta Mac tiene macOS 12.7.6. Remotion 4.0.538 descarga binarios nativos
(Chrome headless shell, ffmpeg, ffprobe y el compositor) que requieren
macOS 13+/15+ y fallan con errores de símbolos de `dyld` al cargar. Esto
**no es un bug del proyecto**: es un requisito de sistema de Remotion, y
**solo afecta a esta máquina de desarrollo** — en el contenedor Docker
(Linux, ver más abajo) no aplica.

Workaround verificado (ya resuelto, documentado por si se reinstalan
`node_modules`):

1. **Navegador**: Brave (ya instalado) en vez del Chrome headless que
   Remotion intenta descargar, con `--browser-executable`.
2. **ffmpeg/ffprobe/compositor**: los de
   `node_modules/@remotion/compositor-darwin-x64` (v4.0.538) no cargan en
   macOS 12; los de la versión **4.0.200** de ese mismo paquete sí. Están
   copiados en `.remotion-macos12-binaries/` (ignorado por git), usados
   con `--binaries-directory`.

```console
npx remotion render VideoEngine out/video.mp4 \
  --props='{"jobFile":"jobs/dopamina-90s.json"}' \
  --browser-executable="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
  --binaries-directory="$(pwd)/.remotion-macos12-binaries"
```

Si `.remotion-macos12-binaries/` no existe (p. ej. tras un clon limpio):

```console
cd /tmp && npm pack @remotion/compositor-darwin-x64@4.0.200
mkdir compositor-4.0.200 && tar -xzf remotion-compositor-darwin-x64-4.0.200.tgz -C compositor-4.0.200 --strip-components=1
chmod +x compositor-4.0.200/{ffmpeg,ffprobe,remotion}
cp compositor-4.0.200/* /ruta/al/proyecto/.remotion-macos12-binaries/
```

`server/index.mjs` (la API) también acepta `REMOTION_BROWSER_EXECUTABLE`
y `REMOTION_BINARIES_DIRECTORY` como variables de entorno para poder
probarlo en esta Mac; en el contenedor Linux de producción se dejan sin
definir.

## API HTTP + Docker (para n8n / VPS)

`server/index.mjs` expone una API mínima (`POST /jobs`, `GET /jobs/:id`,
`GET /jobs/:id/download`) para que n8n mande un video + un `EngineJob` y
reciba el MP4. El `Dockerfile`, `docker-stack.yml` (Portainer/Swarm) y
`registry/docker-stack.yml` (registro privado autoalojado, opcional) están
listos para desplegar. **Todo el detalle — y qué de esto está probado de
verdad y qué no — está en [`DEPLOY.md`](./DEPLOY.md).**

## Próximos canales

**Alex Cripto y Negocios** y **La Nave Tierra** ya tienen perfil y
registro de correcciones preparados (`public/channels/`), y el motor los
soporta sin ningún cambio de código — solo falta su primer `EngineJob`
real con contenido propio.
