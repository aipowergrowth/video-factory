# Fase 0 — corrección de lo que la medición real en el VPS dejó en evidencia

**14-nov-2026.** Continuación de `b08829e`/`e8c9cdc`. Sigue detrás de
`RENDER_MODE=hybrid` (por defecto `"full"` — sin cambios de producción).
Commit único a `main`: **`0b54615`**.

## Qué cambió (por criterio de aceptación)

**Criterio 1 — FPS variable por MEDICIÓN, no por texto.**
`classifyFrameTimingVariability` (`server/segment-render.mjs`) mide los
intervalos reales entre cuadros (tiempo de presentación, ordenados —
`ffprobe` los da en orden de decodificación) contra el intervalo esperado
del FPS declarado, con una tolerancia justificada con los datos reales del
VPS (15% por intervalo, 1% máximo de intervalos irregulares). Reemplaza la
comparación textual `r_frame_rate === avg_frame_rate` que causaba
`copiedFraction=0` siempre en el job real (0,004% de diferencia real,
puro redondeo del contenedor, pero textualmente siempre distinto).

Durante esta misma tarea, la **segunda corrida de CI real** reveló una
causa adicional que la medición de variabilidad sola no cubre: una fuente
puede ser perfectamente CFR (constante) y aun así dar un conteo de cuadros
equivocado si su **FPS nativo no es el mismo que el FPS de salida del
motor** — una copia de flujo preserva los cuadros reales del archivo, sin
remuestrearlos; eso solo lo hace `-r <fps>`, una recodificación. Se agregó
`nativeFpsMatchesDestination` (2% de tolerancia — cubre el redondeo NTSC
real, 29,97 vs 30 = 0,1%, sin tolerar una fuente genuinamente distinta,
24 vs 30 = 20%). `probeSourceDisablesStreamCopy` mide y combina ambas
causas, y deja constancia en el log SIEMPRE (no solo cuando desactiva la
copia) — observabilidad real desde Portainer.

Fail-safe invertido: si el sondeo de FPS falla, ahora se asume que **no**
es seguro copiar (se recodifica) — la primera versión de esto asumía lo
contrario, el camino arriesgado, con un razonamiento incorrecto (que
`verifyChunkIntegrity` lo atraparía después; no hay recodificación de
respaldo automática, el chunk entero falla y lanza).

**Criterio 2 — equivalencia visual confiable.**
`compareVideosPsnr` (`server/video-compare.mjs`) ahora fuerza `-r <fps>`
en AMBOS decodes al comparar — empareja cuadros por tiempo de
presentación, no por posición, eliminando el desacople en los empalmes que
causaba el mínimo de 13,8dB y `frameCountMismatch=true` medidos en el VPS.
`summarizePsnrByChunks` da PSNR por tramo y por empalme (±5 cuadros),
nunca solo un promedio global que puede esconder un defecto localizado.

**Criterio 3 — memoria real.**
`container-metrics.mjs` ahora expone memoria **anónima** (`memory.stat`,
campo `anon` — la que de verdad puede causar un OOM-kill) por separado de
la memoria total con caché de archivos reclamable (`memory.current`, lo
que se medía antes). `hasMemoryHeadroomForAnotherTask` compara la memoria
anónima real contra el límite del contenedor con 25% de margen.

**Criterio 4 — paralelismo con evidencia.**
`renderAllChunks` corre los tramos planos (FFmpeg) EN PARALELO con los
compuestos (Remotion/Chrome) cuando el plan tiene de ambos
(`parallelPlainWithComposite`, `true` por defecto) — usa el 55,6% de CPU
promedio y el margen de memoria medidos en el VPS como holgura real, no
supuesta. Antes de cada tramo plano paralelo se espera por memoria
anónima disponible (hasta 30 intentos de 2s). `false` vuelve al
comportamiento secuencial anterior si hiciera falta compararlo.

**Criterio 5 — velocidad del preset de x264.** Mecanismo listo
(`x264Preset` como override por request en `/jobs/:id/diagnose-hybrid`,
también expuesto en el workflow de n8n) — la medición de velocidad/calidad
en sí es VPS-only, queda pendiente de que Alex la corra (ver "Qué sigue
sin comprobarse").

**Criterio 6 — mensaje "undefined corrida(s)".** Corregido en
`segment-planner.mjs#decideRenderMode`: el campo `plan.compositeRuns` no
existe en lo que devuelve `planChunks()` (solo en `planSegments()`) — el
conteo de corridas compuestas ahora se calcula inline desde
`plan.chunks`. Prueba de regresión usa `planChunks` (la forma real de
producción), no `planSegments`, para que el defecto no se vuelva a
esconder detrás del helper equivocado.

**Criterio 7 — ventana representativa + medición completa.**
`chooseRepresentativeWindow` centra la ventana de medición en un tramo
compuesto real, apuntando a <15% de cuadros compuestos por defecto — la
ventana anterior (desde el cuadro 0, sin control de proporción) dio 63%
compuesto en un job que en total es 5,4% compuesto, nada representativo.
`render-diagnose-hybrid.mjs` ahora también mide duración exacta en
cuadros (conteo real de paquetes) y sincronía de audio, y corrige un bug
real: el render de línea base comparaba siempre los cuadros `0-N`, lo cual
era la porción EQUIVOCADA del video en cuanto la ventana no arranca en el
cuadro 0 (como pasa casi siempre ahora que se centra en el tramo
compuesto). `n8n/workflow-render-diagnostico-hibrido.json` actualizado al
nuevo shape de respuesta (`windowStartFrame`, `achievedCompositeFraction`,
`equivalencia` ampliada con `bySegment`, métricas de memoria anónima) y a
los nuevos parámetros de entrada (`maxWindowFrames`, `x264Preset`,
`parallelPlainWithComposite`) — jobId real ya precargado.

**Criterio 7b — comparación medida.** Cubierto por el mismo
`render-diagnose-hybrid.mjs`: duración exacta en cuadros, sincronía de
audio, PSNR por tramo/empalme, y memoria/CPU del contenedor, todo dentro
del tiempo medido (`renderMs` incluye bundle + tramos + ensamblado).

**Criterio 8 — extrapolación.** No requiere código nuevo — los
`segments[]` por tipo (plano/compuesto) ya traen velocidad real medible
(cuadros / `renderMs`); cualquier extrapolación a la duración completa del
job o a videos de 45-60min debe marcarse explícitamente **[CALCULADO]**, no
medido, usando esos datos por tipo.

## Qué se comprobó en cuál nivel (de los 4 de `CLAUDE.md`)

- **Nivel 1** (código escrito, compila/pasa lint): sí — `npm run lint`
  limpio en cada commit.
- **Nivel 2** (prueba simulada con datos hechos a mano): sí, extenso —
  24 archivos de prueba locales, incluyendo el nuevo
  `server/test-video-compare.mjs` (PSNR por tramo/empalme) y nuevas
  secciones en `test-segment-render.mjs` (`classifyFrameTimingVariability`
  contra los números EXACTOS del VPS real y un caso VFR genuino;
  `nativeFpsMatchesDestination` contra NTSC real vs un mismatch genuino),
  `test-segment-planner.mjs` (ventana representativa, recorte de rango) y
  `test-container-metrics.mjs` (memoria anónima vs total). Todas pasan.
- **Nivel 3** (ejecución real): sí, en CI — `audio-regression-tests.yml` y
  `captions-destination-test.yml` verdes en la rama antes del merge,
  incluyendo el render híbrido real de los 3 casos (A: mixto plano/
  compuesto en paralelo con copia de flujo real del 64-83%; B: fuente con
  FPS nativo distinto al de salida, confirmando que el fix de esta tarea
  resuelve exactamente el defecto que el propio proceso de prueba de esta
  tarea expuso en CI — ver abajo; C: truncado/reanudación con verificación
  de integridad). Las tres corridas de CI de este proceso (dos con fallos
  reales, corregidos en el acto con evidencia del propio log, no
  adivinando) son evidencia nivel 3 honesta de cómo se llegó al estado
  final, no solo del resultado.
- **Nivel 4** (calidad validada por IA o por Alex): no aplica a este
  cambio (no toca contenido editorial ni recursos).

### Nota de proceso (honestidad de evidencia)

La primera corrida real de CI de esta tarea **falló** en el caso B (fuente
VFR de prueba): un tramo plano se copió sin recodificar y dio 110 cuadros
reales donde se esperaban 120. La causa NO fue la que se sospechaba
primero (un fallo silencioso del sondeo de VFR) sino una real: la fuente
de prueba resultó ser CFR genuina (0,48% de intervalos irregulares, bajo
el umbral de VFR) pero con un FPS nativo (24fps) distinto al de salida del
motor (30fps) — algo que ninguna versión anterior del código, ni la de
antes de esta tarea, comprobaba. Se corrigió con evidencia real del log
(agregado en el mismo commit que reveló el problema), no por suposición,
y la tercera corrida confirmó la corrección. Esto es exactamente el tipo
de causa raíz real que el criterio 1 pedía exponer con evidencia.

## Qué sigue sin comprobarse

- **La medición real en el VPS con ventana representativa (criterios 7/7b)**
  — todo el código está listo y probado hasta nivel 3 en CI, pero la
  medición real de recursos del VPS (memoria anónima real, CPU, velocidad
  real con paralelismo) solo la puede dar una corrida real en el VPS.
- **El sondeo de preset de x264 (criterio 5)** — mecanismo listo
  (`x264Preset` en el workflow de n8n), la medición de velocidad/calidad
  real es VPS-only.
- **Si el paralelismo (criterio 4) realmente ayuda en el VPS real** — el
  mecanismo está probado en CI (corre sin lanzar, respeta el gate de
  memoria), pero el beneficio de velocidad real solo se ve en el VPS con
  el job real.

## Decisiones pendientes de Alex

1. **Autorizar la nueva medición en el VPS** (criterio 7/7b) — un solo
   clic en el workflow de n8n ya actualizado, jobId ya cargado.
2. **Decidir el preset de x264** de producción después de ver el sondeo
   (criterio 5) — hoy sigue sin cambios (el que ya estaba en producción).
3. **Cuándo activar `RENDER_MODE=hybrid`/`HYBRID_PARALLEL_PLAIN_WITH_COMPOSITE`
   en producción** — sigue fuera de esta tarea; requiere ver los
   resultados de la medición del VPS primero.

## SHA del commit

Un solo push a `main`: **`0b54615`**.

## ¿Exige actualizar la imagen en Portainer?

**Sí** — este cambio toca `server/` (lógica de render híbrido, métricas de
contenedor, comparación de video). El push a `main` ya disparó
`docker-publish.yml` solo (publica la imagen nueva en GHCR) —
**ese workflow nunca despliega nada a Portainer**; actualizar el stack ahí
sigue siendo una acción manual de Alex, solo necesaria cuando Alex decida
correr la medición del VPS con el código nuevo.

## Pasos exactos y mínimos de Alex

Para la medición representativa en el VPS (criterios 7/7b, y de paso el
sondeo de preset del criterio 5 si quiere compararlo en la misma corrida):

1. Actualizar la imagen en Portainer al build nuevo (gatillado por
   `0b54615`) — necesario antes de medir, porque este cambio vive en
   `server/`.
2. En n8n, abrir el workflow **"Fabrica Videos - Render de diagnóstico
   híbrido"**.
3. En el nodo **"jobId a diagnosticar (híbrido)"**: el `jobId` ya está
   precargado con el job real de 23min (`1fd239de-8f9e-4642-8e42-d848b17d8481`).
   No hace falta cambiar nada para una corrida estándar — `minWindowFrames`/
   `maxWindowFrames`/`x264Preset`/`parallelPlainWithComposite` ya tienen
   valores por defecto razonables (y notas explicando qué hace cada uno si
   se quiere sondear algo específico, p. ej. dejar `x264Preset` vacío para
   el preset real de producción, o poner `"veryfast"` para compararlo).
4. Ejecutar el workflow (clic en "Ejecutar manualmente").
5. Leer el resultado en el nodo **"Resumen del diagnóstico híbrido"** —
   trae `ventanaMedida` (confirma que la ventana sí quedó representativa,
   <15% compuesto), `factorDeAceleracion`, `equivalenciaVisual` (duración
   exacta, sincronía de audio, PSNR por tramo y por empalme) y
   `memoriaYCpuDelContenedor` (con el desglose anónima/caché).

No hace falta ninguna corrida adicional — una sola basta para los
criterios 7/7b. Si además se quiere el sondeo de preset (criterio 5),
repetir el paso 4 cambiando solo `x264Preset` en el nodo del paso 3 y
comparar `msTramos`/`equivalenciaVisual.porTramo` entre corridas.
