# Video Factory — Informe de entrega
## Fase 3B mínima: imágenes/B-roll con Pixabay + "graphic" con GraphicOverlay
**31 de octubre de 2026 — commit `9a99816`**

---

## Implementado

- **Planificador** (`server/editorial.mjs`): nuevos campos en el esquema de recursos — `visualQuery` (broll/image: qué buscar, visual y concreto, distinto de `description`) y `graphicVariant`/`graphicData` (graphic: `chart`/`cycle`/`stat` + los datos exactos que exige cada componente ya existente). Regla explícita en el prompt: los valores de `graphicData` tienen que ser cifras/pasos que el presentador dice realmente — si no hay suficiente dato citable, el modelo no debe proponer el recurso. En el parseo, si la forma no valida para la variante declarada, se descartan `graphicVariant`/`graphicData` **juntos** (nunca a medias).
- **`server/resource-acquisition.mjs`** (nuevo): cliente de Pixabay sin SDK (usa `fetch` nativo de Node). Cumple los tres límites pedidos: caché de 24h por consulta (un archivo por búsqueda normalizada, nunca repite la misma consulta dentro de la ventana), un solo pedido de búsqueda por consulta nueva (un 429 o error de red se registra como fallo de *ese* recurso y nunca tumba el job), descarga únicamente el archivo elegido (nunca los demás candidatos). Relevancia por **palabras clave** (superposición de tokens entre `visualQuery` y las etiquetas de Pixabay) — sin llamar a ningún modelo. Cada recurso resuelto guarda: proveedor, id del asset, URL de la página, autor, nombre y URL de la licencia, si exige atribución, fecha de descarga.
- **`cta-guarantee.mjs` / `src/types.ts`**: `isRenderableIn3A` → `isRenderableByEngine`, extendida con `graphic` (datos estructurados válidos) y `broll`/`image` (`resolvedAsset` presente). Misma función, duplicada a propósito en servidor y motor (igual patrón que `shouldBurnCaptions`/`timeline.mjs`). `computePendingResources` usa el motivo específico de la adquisición fallida cuando existe, no el genérico.
- **`index.mjs`**: nueva etapa `acquireResourcesIfNeeded`, corre siempre (con o sin IA editorial, con o sin `planOnly`) e idempotente. Un recurso **esencial** de tipo broll/image que no se resuelve detiene el job — alcance nuevo exclusivamente para este caso; `document-reference`/`graphic` esenciales pendientes siguen comportándose exactamente igual que antes. Nuevos directorios `RESOURCE_CACHE_DIR`/`RESOURCE_ASSETS_DIR`, ambos dentro de `public/uploads` (el volumen persistente que **ya existe** — sin volumen nuevo, sin librería nueva).
- **`VideoEngine.tsx` / `ResourceRenderer.tsx`**: orden de pintado corregido — broll/image primero (fondo), CTA/graphic/text-highlight después, subtítulos al final (sin importar en qué orden el planificador los proponga, nunca se tapan entre sí). `graphic` se reenvía a `Chart`/`CycleDiagram`/`StatCallout` (`src/graphics/`, ya existentes); `broll`/`image` reutilizan `BRollOverlay`/`ImageOverlay` (antes solo usados con `job.overlays` manuales). **Cero componentes Remotion nuevos.**

## Probado

- **65 pruebas unitarias nuevas o actualizadas** (`test-resource-acquisition.mjs`, `test-cta-guarantee.mjs`, `test-editorial-simulated.mjs`), con la misma disciplina del proyecto: red/FFmpeg siempre simulados, nunca una llamada real en estas pruebas. Cubren: caché de 24h real (segunda búsqueda idéntica no vuelve a llamar), selección del candidato más relevante (nunca descarga el irrelevante), rechazo cuando ningún candidato pasa el umbral (no inserta nada genérico), fallo de red/descarga sin tumbar nada, idempotencia, `graphicData` inválido descartado completo, orden de pintado.
- **Render con Chrome real en CI** (`.github/workflows/captions-destination-test.yml`, extendido): un tercer job con un recurso `graphic`/`stat` se renderizó de verdad y se confirmó por píxeles reales (822 píxeles claros en la franja central, frente al umbral de 20) que `ResourceRenderer` lo despachó correctamente a `StatCallout` — sin necesitar clave de Pixabay (graphic no toca ningún banco externo). Corrida: verde.
- `tsc`, `eslint` y los 8 archivos de prueba que corren en esta máquina: todos en verde. Los 2 archivos que necesitan FFmpeg/Remotion reales (`test-audio-regression.mjs`, `test-captions-render.mjs`) fallan aquí por la limitación ya conocida de macOS 12 (documentada desde el inicio del proyecto) — **ambos corrieron y pasaron en GitHub Actions** (Linux, mismo FFmpeg que producción), confirmado en esta misma entrega.

## Pendiente de validar (necesita la clave real de Pixabay)

La adquisición contra la **API real** de Pixabay no se pudo probar todavía — no tengo la clave. Dejé lista una prueba corta, de costo cero, para correr en el VPS en cuanto exista el secreto:

**`public/jobs/dopamina-fase3b-prueba-pixabay.json`**

- `planOnly: true` (nunca renderiza, nunca sube nada a Drive) y `skipTranscription`/`skipEditorialAI` en `true` (no llama a Claude — cero gasto nuevo de Anthropic).
- Usa el video de dopamina ya descargado en el VPS por el render `b3601795` (`uploads/videos/b3601795-d1fb-400b-ad5c-b518855775dd.mp4`) — si ya no está en disco, basta con cambiar `input.baseVideo` por `input.driveFileId` con el ID real.
- 4 recursos de prueba (marcados explícitamente como "PRUEBA TÉCNICA, no editorial" en su descripción, para que no se confundan con una decisión editorial real sobre dopamina): un `broll` y una `image` con consultas visuales concretas, una `image` con una consulta deliberadamente sin sentido (para confirmar que el sistema la rechaza y la deja pendiente con motivo, en vez de insertar algo genérico), y un `graphic`/`stat` con un dato de prueba.

Para correrla, una vez que el secreto de Pixabay exista y el stack esté actualizado:

```bash
curl -X POST https://<host-del-motor>/jobs \
  -H "Content-Type: application/json" \
  -d @public/jobs/dopamina-fase3b-prueba-pixabay.json
```

Con el `jobId` que devuelva, `GET /jobs/<jobId>` muestra cuándo termina (debería ser cuestión de segundos: sin transcripción, sin modelo, sin render), y leer el job guardado en disco (`uploads/jobs/<jobId>.json`) muestra `resources` (con `resolvedAsset` o `acquisitionFailureReason` por recurso) y `pendingResources`.

## Qué necesito de Alex

**Secreto de Pixabay en Portainer**, mismo patrón que la clave de Anthropic:

1. Crear una cuenta gratuita en pixabay.com (no pide tarjeta, según su propia documentación) y generar una API key en su panel.
2. En Portainer → Secrets, crear un secreto llamado **`vfpixabay_api_key`** con el contenido: solo la clave, sin comillas ni nombre de variable delante (igual que `vfanthropic_api_key`).
3. Cuando decidas actualizar el stack (no antes, y no lo hago yo): el `docker-stack.yml` de este repo necesita este agregado, que preparo pero NO comiteo todavía (para no romper la regla de que este archivo refleje exactamente lo que hay en Portainer en cada momento):

```yaml
# en "environment":
PIXABAY_API_KEY_FILE: "/run/secrets/pixabay_api_key"
# en "secrets" del servicio:
- source: vfpixabay_api_key
  target: pixabay_api_key
# en "secrets" (nivel raíz):
vfpixabay_api_key:
  external: true
```

Cuando crees el secreto y aplique el cambio en Portainer, decímelo y yo hago el commit de este agregado a `docker-stack.yml` en ese mismo momento (no antes).

## Límites respetados

Sin gasto nuevo (la prueba corta no llama a Claude; Pixabay es gratis). Sin cuentas creadas por mí, sin credenciales pedidas en el chat. Sin tocar ni reiniciar el stack — el `docker-stack.yml` del repo no cambió todavía, a propósito. Sin música/SFX/Pexels/get-brolls/Fase 3C. No se resolvieron los 4 recursos pendientes de dopamina (document-reference/esenciales, fuera de este alcance por diseño). Sin cambios de visibilidad de repositorios.
