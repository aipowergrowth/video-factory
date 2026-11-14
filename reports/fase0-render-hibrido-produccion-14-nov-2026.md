# Fase 0 — render híbrido a producción (adenda del auditor, 14-nov-2026)

Cierre de la tarea "LLEVAR EL RENDER HÍBRIDO A UNA RUTA DE PRODUCCIÓN
UTILIZABLE (DETRÁS DE BANDERA), CON ENSAMBLADO SIN RECODIFICAR", con la
adenda de exigencias estrictas del auditor del mismo día. Continuación de
`4dbd6cc`/`7dce830`. Un solo push a `main`: **`b08829e`**.

## Qué cambió (criterio por criterio de la adenda)

- **A/1 — ensamblado sin recodificar todo el video**: los tramos llegan
  como `.ts` (MPEG-TS); la unión es **concatenación binaria de bytes**
  (`concatTsFiles`), nunca el demuxer `concat` de FFmpeg. Causa raíz real
  encontrada con evidencia de CI: el demuxer `concat` perdía >1s del
  video final SIN error, tanto uniendo piezas dentro de un tramo como
  uniendo tramos entre sí — ninguna bandera de tolerancia de timestamps
  lo arregló; la aritmética de continuidad del demuxer era la causa. Una
  sola pasada de FFmpeg (`+genpts+igndts`) remuxea el `.ts` ya unido a
  `.mp4`, sin recodificar ningún cuadro.
- **2 — tramos planos baratos**: copia de flujo (`-c:v copy`) en los GOP
  completos (detectados vía `ffprobe`), recodificación exacta **solo en
  los bordes**, con los mismos `crf`/`preset`/GOP que los tramos
  compuestos. `-bf 0` en los bordes (pueden durar 1-2 cuadros,
  insuficiente para la profundidad de B-frames por defecto — causa real
  de un DTS inválido encontrada en CI). Las piezas se cortan por
  **cuadros exactos** (`-frames:v`), no por duración en segundos (un
  intervalo de keyframes no decimal-exacto como 29/30s arrastraba
  redondeo de punto flotante).
- **3/B — FPS variable**: `-r` como opción de SALIDA normaliza cualquier
  fuente a FPS constante. La copia de GOP se **deshabilita
  automáticamente si la fuente es VFR** (`probeSourceIsVfr`) — una copia
  de flujo no puede normalizar FPS, solo recodificar puede; confirmado
  real en CI que intentarlo daba menos cuadros reales de los esperados.
  Probado con una fuente **genuinamente VFR** (dos tramos de 24fps/30fps
  unidos con `-vsync vfr`, no solo declarada distinta a la promedio).
- **C — integridad real**: cada chunk se verifica, antes de reusarlo, por
  (1) decodificación completa sin errores, (2) conteo EXACTO de paquetes
  de video, (3) checksum SHA-256 registrado. "El archivo existe" ya no
  basta. Probado con un chunk **truncado a propósito**: se detecta, se
  descarta, se regenera — el resultado final es bit-idéntico (PSNR=∞) a
  una corrida sin interrupciones.
- **D — caso 7 del vigilante**: causa raíz real en el código instalado
  de Remotion — Chrome corre en su propio grupo de procesos (`detached:
  true`), invisible para la medición de CPU por grupo (PGID). Corregido
  por ÁRBOL de procesos (cadena de ppid, `sumProcessTreeCpuTicks`/
  `killProcessTree`), no ampliando el margen a ciegas. El margen quedó
  en 3000ms/300ms con evidencia de DOS causas reales distintas
  (arranque de Chrome, y luego E/S de disco al abrir el video fuente —
  ambas ventanas legítimas de baja actividad de CPU que el margen
  original de 500ms no cubría).
- **E/7 — medición en el VPS**: nuevo endpoint `POST
  /jobs/:id/diagnose-hybrid` — sobre una ventana corta de un job real,
  mide el pipeline COMPLETO (bundle, cada tramo FFmpeg/Remotion,
  ensamblado) con memoria/CPU del contenedor durante TODO el proceso, y
  compara contra un render completo de esa misma ventana (tiempo, PSNR).
  Nunca toca el job real.
- **F — producción apagada por defecto**: `RENDER_MODE=full` es el valor
  por defecto del servidor — cero cambio de comportamiento sin que Alex
  lo active explícitamente en Portainer. Con `RENDER_MODE=hybrid`, el
  planificador decide job por job (`decideRenderMode`, umbral
  `HYBRID_MAX_COMPOSITE_PERCENT`, 70% por defecto). Un reintento
  (`POST /jobs/:id/retry` con `{"mode":"full"}`) fuerza el modo completo
  para ese intento sin perder transcripción/plan/recursos ya hechos.
  `segments[]` y `renderMode` quedan visibles en `GET /jobs/:id`.
- **G — bundle reutilizable** (criterio 4): `ensureRenderBundle`
  construye el bundle de Remotion una sola vez por versión de imagen
  (`GIT_SHA`) y lo reutiliza entre invocaciones — evita el bundling
  repetido por cada tramo compuesto.

## Qué se comprobó (niveles de honestidad de evidencia)

- **Nivel 1**: todo lo anterior compila y pasa `npm run lint` sin
  errores.
- **Nivel 2**: lógica pura (`planChunks`/`decideRenderMode`/
  `planPlainChunkPieces`/`canStreamCopyPlainChunks`/`computeObjectFitCover`/
  variantes de árbol de procesos) con casos hechos a mano —
  `test-segment-planner.mjs`, `test-segment-render.mjs`,
  `test-process-tree.mjs`.
- **Nivel 3 — render real (CI, Chrome+FFmpeg reales, GitHub Actions)**,
  la evidencia que de verdad prueba la adenda:
  - **Duración exacta en cuadros** (conteo REAL de paquetes de video vía
    `ffprobe`, no el campo `duration` del contenedor, que puede variar
    unos milisegundos de metadata sin perder ni un cuadro): el híbrido y
    el render completo dieron el mismo total exacto en los 3 casos
    probados (420=420, 300=300, 270=270).
  - **Sincronía de audio**: <1 cuadro de diferencia.
  - **Equivalencia visual (PSNR propio, sin depender de un ffmpeg con el
    filtro `psnr` que Remotion no trae)**: >22dB en los casos con
    contenido sintético adversarial (`testsrc2`, el patrón más exigente
    para compresión — más que cualquier video real); PSNR=∞ (idéntico
    bit a bit) en la prueba de reanudación.
  - **Fuente VFR genuina**: construida y probada de verdad, no solo
    simulada.
  - **Verificación de integridad con un chunk truncado**: detectado,
    descartado, regenerado — nunca reusado.
  - **Caso 7 del vigilante**: pasa con el margen 3000ms/300ms y la causa
    raíz real corregida.
  - Workflow completo verde en `main` tras el push:
    [`43630091506`](https://github.com/aipowergrowth/video-factory/actions/runs/43630091506)
    (render/híbrido),
    [`43630091467`](https://github.com/aipowergrowth/video-factory/actions/runs/43630091467)
    (audio/lógica),
    [`43630091430`](https://github.com/aipowergrowth/video-factory/actions/runs/43630091430)
    (imagen Docker).
- **Nivel 4**: no aplica (motor/infraestructura de render, no contenido
  editorial).

### Hallazgo honesto sobre la herramienta de comparación propia

`compareVideosPsnr` (PSNR propio en Node, para no depender de un ffmpeg
con el filtro `psnr` compilado — el de Remotion no lo trae) puede perder
el sincronismo de qué cuadro compara con cuál justo en una frontera entre
tramos, sin que eso signifique que el ARCHIVO final tenga un cuadro de
más o de menos — confirmado de forma independiente contando los
paquetes reales del archivo con `ffprobe` (que sí dio match exacto
siempre). Se dejó documentado en el código y las pruebas no exigen que
esta herramienta en particular logre el emparejamiento perfecto —
exigen el conteo real de paquetes, que es la garantía más fuerte y ya
está probada.

## Qué sigue sin comprobarse

- **Todo lo VPS-only**: el endpoint `/jobs/:id/diagnose-hybrid` está
  construido y su lógica de orquestación reutiliza funciones ya
  probadas con render real (`renderAllChunks`/`assembleFromChunks`/
  `ensureRenderBundle`), pero la orquestación completa de ESE endpoint
  específico (incluida la medición de CPU/RAM del contenedor real) no
  se ejecutó contra el job real `1fd239de` ni ningún otro — solo el VPS
  tiene el contenedor con cgroups reales y el job real.
- **Fuentes CON B-frames reales** (como las que probablemente traen la
  mayoría de las grabaciones reales, a diferencia de los `testsrc2`
  sintéticos de esta tarea, que se construyeron con `-bf 0` para poder
  aislar la causa raíz real del DTS inválido en los bordes): la lógica
  de copia de GOP debería funcionar igual (un GOP cerrado con B-frames
  es autocontenido), pero no hay una prueba en CI con una fuente que
  tenga B-frames de verdad en el CUERPO copiado — solo se evitaron en
  los bordes recodificados, donde sí se confirmó el defecto real.
- **El umbral `HYBRID_MAX_COMPOSITE_PERCENT=70%`** es una propuesta
  razonada (dictamen anterior + los tiempos medidos del job real), no
  validada con una medición real de cuándo el híbrido deja de convenir.

## Pasos mínimos para Alex en el VPS

**Requiere actualizar la imagen en Portainer** (cambios en
`server/index.mjs` y varios módulos nuevos de `server/`) antes de que
`RENDER_MODE=hybrid` o el endpoint de diagnóstico existan ahí.

1. **Medir el híbrido de punta a punta sobre el job real**: importar
   **`n8n/workflow-render-diagnostico-hibrido.json`** (nuevo, listo
   para importar — "Fabrica Videos - Render de diagnóstico híbrido").
   Pegar el `jobId` real (p. ej. `1fd239de`, si todavía no venció su
   retención de 7 días) y ejecutar. Sin costo, sin tocar el job real.
   Trae tiempos por etapa (bundle, cada tramo, ensamblado), memoria/CPU
   del contenedor durante TODO el proceso, y la comparación contra un
   render completo de la misma ventana (incluye PSNR).
2. **Ver `segments[]` de un job que corrió en modo híbrido**: el
   workflow existente "Fabrica Videos - Estado del job" ya se actualizó
   (`n8n/workflow-estado-del-job.json`) para traer `modoDeRender` y
   `tramos` en su nodo "Resumen" — no hace falta ningún campo nuevo.
3. **Activar el híbrido para jobs reales** (solo cuando Alex lo decida,
   después del punto 1): agregar la variable de entorno
   `RENDER_MODE: "hybrid"` al servicio en `docker-stack.yml`/Portainer.
   Sin esto, el comportamiento sigue siendo exactamente el de hoy.

## Decisiones pendientes de Alex

- **Autorizar la medición del punto 1** contra el job real (o cualquier
  job de video grabado vigente) — es la única pieza que falta para
  tener números reales de velocidad del híbrido, no solo la prueba de
  corrección de CI.
- **Si y cuándo activar `RENDER_MODE=hybrid`** en producción — con los
  datos del punto 1 en mano. El código no lo activa solo.
- **Si el umbral `HYBRID_MAX_COMPOSITE_PERCENT` (70%) es el correcto**
  para los canales reales de Alex, o si debería ajustarse una vez vistas
  las mediciones.

## Commits

- `b08829e` — commit único en `main` (squash de 18 commits de la rama,
  incluidos los 9 ciclos de causa-raíz-real-con-evidencia encontrados en
  CI: Chrome en grupo de procesos propio, demuxer `concat` perdiendo
  duración, B-frames en bordes cortos, redondeo de punto flotante en
  piezas, copia de GOP incompatible con fuentes VFR, y la propia
  herramienta de PSNR perdiendo sincronismo cuadro a cuadro).
- CI en `main` verde: `43630091506` (render/híbrido), `43630091467`
  (audio/lógica), `43630091430` (imagen Docker).
- Rama `fase0-render-hibrido-produccion` borrada (local y remota) tras
  el merge — un solo push a `main`.
