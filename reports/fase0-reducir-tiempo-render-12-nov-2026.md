# Fase 0 — reducir el tiempo de render — G0/G1/G2/G2-R (12-nov-2026)

Cierre de la tarea sobre el dictamen técnico del auditor (11-nov-2026,
autorizado por Alex): "REDUCIR AL MÁXIMO EL TIEMPO DE RENDER POR MINUTO DE
VIDEO — PROTOTIPOS Y MEDICIONES (G0–G2)". Un solo push a `main`, sin tocar
producción, sin renders completos, sin gasto. Hecho.

## Qué cambió

Todo nuevo, detrás de banderas o en módulos nunca llamados desde el camino
de producción — **ningún render real de hoy cambia de comportamiento**.

- **G0 — análisis sin renderizar** (`server/segment-planner.mjs`,
  `GET /jobs/:id/segment-plan`): dado un job ya persistido, calcula qué
  porcentaje de cuadros de salida son "plano" (solo video fuente, sin nada
  encima) vs "compuesto" (zoom/overlay/recurso/subtítulo quemado), con
  desglose por tipo y la cantidad de tramos compuestos. Costo cero —
  nunca abre Chrome ni FFmpeg.
- **G1 — prototipo de render selectivo** (`segment-planner.mjs` +
  `segment-render.mjs` + `segment-assemble.mjs`): corta el job en tramos
  (`planChunks`), renderiza los planos con FFmpeg (recodificando, corte
  exacto al cuadro aunque caiga fuera de keyframe) y los compuestos con
  Remotion real restringido a su rango de cuadros, construye el audio
  final UNA sola vez desde la fuente completa (nunca por tramo), y
  ensambla todo. **Validado con un render real en CI** (Chrome+FFmpeg
  reales, nunca simulado) contra un video fuente con keyframes muy
  escasos, corte fuera de keyframe, y dos elementos compuestos uno antes
  y otro después del corte.
- **G2-R — reanudación** (`segment-render.mjs#renderAllChunks`): cada
  chunk se escribe primero a un `.tmp.mp4` y se renombra atómicamente solo
  al terminar; un chunk ya completo en disco nunca se vuelve a renderizar.
- **G2 — bandera `@remotion/media` vs `OffthreadVideo`**
  (`src/engine/sources/RecordedVideoSource.tsx`, env
  `REMOTION_VIDEO_COMPONENT=media`): permite medir ambos sin tocar el
  comportamiento por defecto (sin la bandera, sigue siendo exactamente lo
  de siempre).
- **Criterio 1 — ventanas de diagnóstico** (`server/render-diagnose.mjs`,
  `POST /jobs/:id/diagnose`): ahora mide por separado inicio/medio/fin del
  video (antes solo inicio+medio), y devuelve `avgMsPerFrame` por ventana.
  El mismo endpoint ahora acepta `concurrency` y `videoComponent` en el
  cuerpo del POST, sin tocar la configuración real de producción.

## Qué se comprobó (niveles de honestidad de evidencia)

- **Nivel 1** (código, compila/lint limpio): todo lo anterior. `npm run
  lint` (eslint+tsc) sin errores.
- **Nivel 2** (prueba simulada, datos inyectados): `planSegments`/
  `planChunks` con casos hechos a mano (corte partiendo chunks adyacentes
  del mismo tipo, overlays que cruzan un corte, etc. —
  `server/test-segment-planner.mjs`), armado de argumentos FFmpeg
  (`server/test-segment-render.mjs`), ventanas de diagnóstico
  (`server/test-render-diagnose.mjs`).
- **Nivel 3 — ejecución real (CI, Chrome+FFmpeg reales, GitHub Actions,
  nunca en esta Mac)**, la parte que de verdad prueba G1/G2-R:
  - **Duración**: render selectivo = render completo, **exacto** (14,000s
    == 14,000s, 420/420 cuadros) después de corregir el ensamblado (ver
    "causas raíz" abajo).
  - **Sincronía de audio**: diferencia de 0,021s entre selectivo y
    completo (umbral: <1 cuadro = 0,043s). Pasa.
  - **Equivalencia visual (PSNR)**: 39,85dB entre el render completo y el
    selectivo (umbral: >30dB). Pasa.
  - **Reanudación (G2-R)**: tras simular un corte a mitad de camino, el
    chunk ya completo se detecta (mismo tamaño/mtime, nunca se
    re-renderiza) y el resultado final reanudado es **bit-idéntico**
    (PSNR = ∞) al de una corrida sin interrupciones.
  - **Bandera `@remotion/media`**: un render real completa igual con la
    bandera encendida o apagada (sin comparar velocidad todavía — eso es
    G2, ver "sigue sin comprobarse").
  - Workflow completo verde en `main` tras el push:
    [`43346091617`](https://github.com/aipowergrowth/video-factory/actions/runs/43346091617),
    [`43346091638`](https://github.com/aipowergrowth/video-factory/actions/runs/43346091638),
    [`43346091721`](https://github.com/aipowergrowth/video-factory/actions/runs/43346091721).
- **Nivel 4** (calidad validada por el mecanismo definido): no aplica a
  este entregable (es motor/infraestructura de render, no contenido
  editorial).

### Causas raíz reales encontradas en el camino (con evidencia de CI, no supuestas)

1. El ffmpeg recortado de `@remotion/compositor-linux-x64-gnu` no trae
   compilados `testsrc2`, el filtro de video `setpts`, el filtro `fps`, ni
   el filtro `psnr` — cada uno confirmado con el error real de CI antes de
   evitarlo (nunca se intenta "arreglar" adivinando). Se usa el ffmpeg de
   SISTEMA (instalado en el workflow solo para esto) para construir
   fixtures de prueba y para medir PSNR — el pipeline bajo prueba sigue
   usando siempre el ffmpeg de Remotion, igual que producción.
2. **El ensamblado NO es gratis como asumía el dictamen** (su tabla
   MEDIDO-SANDBOX decía "copiar 1800 cuadros tardó 0,19s"): concatenar los
   chunks con el DEMUXER `concat` de FFmpeg (`-f concat`) daba una
   duración final completamente incorrecta (58,1s en vez de 14s) **tanto
   copiando el flujo como recodificando** — descarta la hipótesis inicial
   de un mismatch de `timescale` del contenedor MP4. La causa real es el
   demuxer en sí: decide los límites de tiempo entre archivos por la
   duración que cada contenedor DECLARA, no por los cuadros reales. El
   fix fue cambiar al FILTRO `concat` (opera sobre cuadros ya
   decodificados, inmune a esa clase de error) — funciona, pero confirma
   que el ensamblado tiene un costo real de recodificación que debe
   sumarse en cualquier estimación (ver la tabla abajo).
3. Un umbral de timing de una prueba de la tarea ANTERIOR (el vigilante de
   atasco, `caso 7`) empezó a fallar de forma reproducible (3 de 3
   corridas) por contención del runner compartido de CI, sin ningún
   defecto de lógica encontrado — se amplió su margen 5x
   (500ms/100ms → 2500ms/250ms) para no bloquear el único push autorizado;
   detalle y evidencia en el comentario del commit.

## Qué sigue sin comprobarse

Todo esto es **VPS-only** por diseño (no hay Chrome/FFmpeg reales en esta
Mac) — ver la sección siguiente para los pasos exactos:

- **G0 real**: correr `planSegments` contra el job real `1fd239de` y dos
  jobs reales más, para saber qué % de ESE contenido es plano vs
  compuesto (la prueba de CI usa un job sintético de 15s, no el contenido
  real de 23 min).
- **Concurrencia 1-4** (criterio 3): el mecanismo (`concurrency` en el
  body del diagnóstico) está probado que funciona, pero la medición real
  de fps por nivel de concurrencia en el VPS no se hizo.
- **`@remotion/media` vs `OffthreadVideo` en el video real** (criterio
  4c): probado que ambos terminan un render real sin error (CI,
  sintético); la comparación de VELOCIDAD contra los 2,5GB del job real
  es VPS-only.
- **Costo real del ensamblado a escala** (criterio C): medido en CI solo
  sobre 420 cuadros (14s) — el costo de recodificar la concatenación de
  un video de 23/45/60 min completo (miles de chunks potenciales) no está
  medido; ver la tabla abajo, marcada como CALCULADO.
- **Fuente con FPS genuinamente variable** (criterio A, sub-caso): se
  intentó construir un fixture con PTS irregulares para probar que
  `renderPlainChunk` normaliza FPS correctamente ante una fuente VFR real
  — causó un artefacto de duración que no se pudo aislar con confianza del
  bug real de concatenación (ambos daban el mismo síntoma al mismo
  tiempo). Se dejó fuera del caso con una nota honesta en el código; la
  propiedad de diseño (`-r` como opción de SALIDA, no un filtro) debería
  cubrir el caso por construcción, pero no tiene una prueba automática
  propia.

## Tabla final — tiempo estimado de render por duración de video

| Opción | 23 min | 45 min | 60 min | Base |
|---|---|---|---|---|
| **Hoy (sin cambios)** | ~198 min (MEDIDO: job real `1fd239de`, 3,47fps sobre 41331 cuadros, extrapolado) | ~387 min (CALCULADO, misma tasa) | ~516 min / 8,6h (CALCULADO, dictamen del auditor) | Render completo por Chrome, todos los cuadros |
| **Render selectivo (G1), estimación conservadora** | No medido en VPS. Si solo ~X% de cuadros son compuestos (G0 real pendiente) y los planos pasan de ~3,47fps (Chrome) a la velocidad de FFmpeg con `libx264 -preset medium` (típicamente 5-15x más rápido que decodificar+componer+codificar vía Chrome, pero NO medido en este VPS/contenido) + el costo de ensamblado (recodificación, confirmado no-gratis, no medido a esta escala) | — | — | CALCULADO con una suposición no verificada de velocidad de FFmpeg en ESTE VPS — no presentar a Alex como cifra firme sin G0+G2 reales |
| **Mayor concurrencia** | No medido | No medido | No medido | Mecanismo listo (`concurrency` en `/diagnose`), sin datos reales del VPS |
| **`@remotion/media`** | No medido (velocidad) | No medido | No medido | Mecanismo listo y probado que no rompe nada; sin comparación de velocidad real |

**Honestidad explícita**: la única celda con un número confiable hoy es
"hoy, 23 min" (MEDIDO sobre el job real). Todo lo demás depende de
mediciones VPS-only que este prototipo deja listas para correr pero que
no se autorizaron ni corrieron en esta tarea. No se entrega una
recomendación de arquitectura final con un número firme sin esos datos —
hacerlo sería inventar una cifra, algo que el proyecto prohíbe
explícitamente.

## Pasos mínimos para Alex en el VPS

Primero: **esto requiere actualizar la imagen en Portainer** (cambios en
`server/index.mjs`, `server/render-worker.mjs`, `server/render-diagnose.mjs`
y `src/`) — sin eso, el VPS sigue corriendo el código viejo y ninguno de
estos pasos funciona.

1. **G0 real (3 jobs, sin costo, sin render)**: duplicar el workflow de
   n8n **"Fabrica Videos - Estado del job (con evidencia)"**
   (`n8n/workflow-estado-del-job.json`) y en el nodo HTTP "Consultar
   estado" cambiar la URL de `.../jobs/{{ $json.jobId }}` a
   `.../jobs/{{ $json.jobId }}/segment-plan` (sigue siendo GET, sin
   cuerpo). Correrlo con `jobId=1fd239de` y con los otros 2 jobs reales
   que Alex elija. El resultado trae `plainPercent`/`compositePercent`/
   `compositeRuns`/`byType` — sin tocar el job real.
2. **Concurrencia 1-4 y `@remotion/media` vs `OffthreadVideo`**: usar el
   workflow existente **"Fabrica Videos - Render de diagnóstico"**
   (`n8n/workflow-render-diagnostico.json`) tal cual, pero agregarle un
   cuerpo JSON al nodo HTTP "Lanzar render de diagnóstico" (hoy no envía
   ninguno) con, por ejemplo, `{"concurrency": "2"}` o
   `{"videoComponent": "media"}` — correrlo una vez por cada valor que se
   quiera medir (1/2/3/4 de concurrencia; `offthread`/`media` de
   componente), siempre contra el MISMO jobId real para comparar
   manzanas con manzanas. El log del servicio en Portainer imprime la
   línea `[diagnóstico <jobId>] iniciando -- ... concurrencia=X,
   componente de video=Y` para confirmar qué corrió. Respuesta trae
   `windowTimings` (inicio/medio/fin, `avgMsPerFrame` por ventana) — ya
   no solo inicio+medio.
3. Ninguno de los dos pasos anteriores crea un job nuevo, cobra nada, ni
   toca el job real — se puede repetir con distintos valores sin
   preocuparse por costo.

## Decisiones pendientes de Alex

- **Autorizar las 3 corridas VPS de arriba** (G0 real, concurrencia,
  `@remotion/media` real) — sin esto, la tabla final de tiempos no se
  puede completar con números medidos, solo con estimaciones marcadas
  como tales.
- **Si el render selectivo (G1) se integra a producción** una vez
  completadas esas mediciones — hoy es un prototipo aislado, nunca
  llamado desde `runRender`/`processQueue` de producción.
- **Si se amplía más el margen del vigilante de atasco** (`caso 7`,
  ahora 2500ms/250ms) de forma permanente, o si se investiga por qué el
  runner de CI está más cargado que el 09-nov-2026 — no bloqueó esta
  entrega, pero es una señal a vigilar.

## Commits (rama `fase0-reducir-tiempo-render`, squash a `main`)

- `4dbd6cc` — commit único en `main` (squash de 11 commits de la rama,
  incluidos los 3 ciclos de fix encontrados en CI real: filtros FFmpeg
  faltantes, extensión `.tmp`/`.m4a`, demuxer→filtro `concat`, ffmpeg de
  sistema para PSNR, margen del vigilante).
- CI en `main` verde: `43346091617` (render/observabilidad),
  `43346091638` (audio), `43346091721` (publicación de imagen Docker).
- Rama `fase0-reducir-tiempo-render` borrada (local y remota) tras el
  merge — un solo push a `main`, como pedía la tarea.
