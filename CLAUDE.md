# Video Factory — guía permanente para Claude Code

Este archivo es breve y estructural a propósito: dice **cómo trabajar aquí**,
no **en qué fase estamos**. El estado de las fases vive en `reports/` y en
`git log`, no en este archivo (ver "Dónde está el estado", más abajo).

Ante una contradicción entre documentos, código, y una decisión de Alex:
comprobar el código y la decisión vigente de Alex, informar la
contradicción, y corregir la documentación afectada. **El código no manda
sobre una decisión de Alex** — manda sobre lo que el código mismo hace.

## Qué es esto

Motor de fabricación de videos (`VideoEngine`, Remotion) para los canales de
Alex — YouTube 16:9 y también formatos verticales (Shorts, Reels, TikTok).
Arquitectura resumida y esquema de trabajo: ver [`README.md`](README.md).
Despliegue en Portainer (clic a clic): ver [`DEPLOY.md`](DEPLOY.md). El motor
vive en `src/`; el servicio HTTP que expone la API para n8n vive en
`server/index.mjs`.

## Autoridad

**Alex decide** alcance, gasto, herramientas y prioridades. El auditor (quien
revisa este proyecto) **aconseja** — sus dictámenes guían el trabajo técnico
pero **no autorizan** operaciones en producción ni gastos; eso solo lo
autoriza Alex. Alex trabaja solo, es directo, y quiere resultados operativos
verificables, no informes largos ni perfección.

## Honestidad de evidencia

Los informes propios **no son hechos hasta comprobarse**. Distingue siempre,
en cualquier entrega, estos cuatro niveles — y dilo explícitamente, no lo
den por entendido:

1. **Código escrito** (existe, compila/pasa lint).
2. **Prueba automática con datos simulados** (inyectados — nunca llama a una
   API real ni gasta dinero).
3. **Ejecución real** (contra Pixabay/Anthropic/FFmpeg reales, un job real).
4. **Calidad real verificada** por el mecanismo definido para ese caso —
   hoy, un validador con IA (p. ej. la Capa C de relevancia visual de
   recursos) para lo que ese mecanismo cubre; la revisión manual de Alex
   queda para validaciones de producto (el video final), no para revisar
   cada recurso uno por uno. Di siempre cuál de los dos se usó.

Ninguna cantidad de pruebas del nivel 2 reemplaza una corrida del nivel 3 —
y esto también aplica a SUPUESTOS sobre una API externa (p. ej. qué hace por
defecto), no solo a pruebas propias: confírmalos contra su documentación
oficial vigente antes de afirmarlos, nunca por cómo se comportó antes o por
memoria del entrenamiento. Ejemplos reales (con fecha y detalle) en
`reports/` — ver "Dónde está el estado".

## Observabilidad para Alex

**Alex no tiene acceso al disco del VPS ni a SSH.** Solo ve los logs del
servicio en Portainer y las respuestas de la API/n8n. Toda función nueva
debe dejar en el log lo necesario para verificarla desde ahí: qué decidió,
por qué, el costo real de cualquier llamada de pago, y enlaces o ids
verificables (p. ej. la página de Pixabay del recurso elegido). **Una
función sin log verificable desde Portainer no está terminada.** Nunca
imprimas una clave/secreto en ningún log.

## Cómo entregar una prueba a Alex

Cada entrega que requiera que Alex corra algo debe decir, explícitamente:

- El **archivo de job exacto** (`public/jobs/...json`) o el **endpoint**
  exacto a llamar.
- Si sirve un **workflow de n8n ya existente** (indicá cuál y qué campo
  cambiar: URL, cuerpo, o `jobId`) o hace falta importar uno nuevo. Los
  workflows que CREAN jobs con costo real (render, llamadas de pago) van
  aparte de los que solo prueban/diagnostican — una prueba reutiliza un
  workflow existente cambiando solo el campo necesario, nunca crea uno
  nuevo por cada prueba. Lo que hay en `n8n/` dentro de este repo es lo
  que está versionado, **no necesariamente lo que Alex tiene cargado en su
  n8n real** — confirma con él cuál es el workflow activo antes de asumirlo.
- **Qué esperar en el log** (líneas, campos, costo esperado).
- Si el cambio exige **actualizar la imagen en Portainer** antes de probar.

Una sola corrida bien indicada basta. No pidas varias corridas de lo mismo.

## Fail-safe como principio

Ante cualquier duda —umbral límite, respuesta ambigua del modelo, fallo o
timeout de una API, falta de un recurso pertinente— el sistema deja el
recurso **pendiente, con motivo**, y conserva al presentador en pantalla. Es
preferible no insertar nada a insertar algo equivocado. Nunca se inventan
cifras, handles, citas ni datos — ni en el contenido del video ni en un
informe.

## Recursos (B-roll, imágenes, gráficos)

Solo se usan si aportan valor real al video — nunca para llenar espacio. Todo
recurso lleva su licencia y procedencia verificable y registrada en el job
(`resolvedAsset`). Bancos gratuitos primero; un recurso pago solo ante una
necesidad concreta y avisando el costo antes. Referencias documentales,
capturas auténticas y recursos que deben ser reales (no genéricos de banco)
son **Fase 3C**, todavía no resuelta — no se resuelven con bancos de stock.

## Reglas editoriales permanentes

Viven en el código (`server/editorial.mjs`) y en
`public/channels/<canal>/profile.json` — no se duplican aquí porque cambian
por canal y se desactualizarían. Como referencia de qué existe (sin copiar
los valores): CTA de suscribirse/like/compartir en el inicio, la mitad y el
final del video; subtítulos pegados solo en formatos verticales
(Shorts/Reels/TikTok) — en YouTube 16:9 va un `.srt` aparte; un video
horizontal nunca se recorta para convertirlo en short.

## Operaciones

- Credenciales **nunca** en chat, commits ni logs. El patrón del proyecto es
  `*_FILE` (variable de entorno que apunta a un secreto de Docker Swarm
  montado en `/run/secrets/...`), nunca la clave en texto plano — ver
  `docker-stack.yml` y `DEPLOY.md`.
- No se inicia un render completo sin autorización explícita de Alex.
- No se actualiza ni reinicia el servicio con un render en curso.
- Antes de cualquier llamada nueva a una API de pago, se informa el costo
  estimado (y, una vez corrida, el costo real medido).
- Cada push a `main` dispara `docker-publish.yml`, que publica sola una
  imagen nueva en GHCR — **ese workflow nunca despliega nada a Portainer**;
  actualizar el stack ahí es siempre una acción manual de Alex.
- **Toda llamada nueva a la API de Mensajes de Anthropic debe decidir
  explícitamente qué hacer con `thinking` — nunca asumir que está apagado.**
  La API lo tiene encendido por defecto; confírmalo en la documentación
  oficial vigente antes de asumir el comportamiento de un modelo nuevo.

## Alcance por fases

Se trabaja solo la prioridad vigente (ver "Dónde está el estado"). No se
abren fases o funciones fuera del roadmap vigente sin autorización explícita
de Alex — lo demás se anota como pendiente y se aparca, no se implementa
"ya que estamos". Se preservan las funcionalidades estables; se permiten
mejoras cuando las justifica un defecto real, evidencia, o una decisión de
Alex — minimizando los cambios colaterales sobre lo que ya funciona.

## Reutilizar antes de construir

Antes de escribir código nuevo: ¿ya existe esta capacidad en el proyecto, o
en una herramienta externa ya evaluada? Herramientas externas señaladas por
Alex se evalúan caso por caso — **no se descartan en bloque**; el informe
vigente de evaluación vive en `reports/` (ver "Dónde está el estado") y
tiene una tabla de veredictos por herramienta, no un rechazo general.
Prioriza la causa raíz de un defecto sobre un parche sucesivo encima de otro.
Las pruebas deben ser proporcionales al cambio — no sobre-probar un ajuste
trivial ni sub-probar uno que toca una capa de validación/costo.

## Cierre fijo de cada tarea

Toda entrega termina, breve, con: **qué cambió**, **qué se comprobó** (en
cuál de los 4 niveles de "Honestidad de evidencia"), **qué sigue sin
comprobarse**, y **qué decisión necesita Alex** (si alguna).

## Dónde está el estado

Este archivo **no contiene el estado de las fases** — se desactualizaría de
inmediato. Antes de empezar cualquier tarea, revisa:

- `reports/*.md` — un informe por decisión/cierre de fase, con fecha en el
  nombre del archivo. Cada informe debe dejar claro qué está aprobado por
  Alex, qué está implementado, qué sigue pendiente, y qué es una propuesta
  todavía sin autorizar — esa separación vive ahí, no se duplica aquí.
- `git log --oneline` — qué se implementó realmente, en orden.

Hoy no existe un `ROADMAP.md` separado; si se crea uno, actualiza esta
sección para apuntar ahí.

## Seguridad y visibilidad — cómo comprobarlo

No se escriben aquí valores que cambian (visibilidad del repo, modelo en
uso, etc.) porque se desactualizan solos. Cómo confirmarlos:

- **Visibilidad del repositorio:** `gh repo view aipowergrowth/video-factory --json visibility`.
- **Visibilidad del paquete de imagen en GHCR:** panel de GitHub →
  `aipowergrowth` → Packages → `fabrica-videos-engine` → Package settings
  (la API de paquetes puede devolver 404 con un token sin el alcance
  `read:packages`/`admin:org` — eso no es evidencia de que el paquete no
  exista ni de su visibilidad real).
- **Modelo de la IA editorial:** `server/editorial.mjs` (`DEFAULT_MODEL`,
  configurable con `EDITORIAL_MODEL`).
- **Modelo de las capas de relevancia de recursos (Fase 3B):**
  `server/resource-acquisition.mjs` (`RELEVANCE_MODEL`).
- **Endpoints reales de la API:** `server/index.mjs` — las tablas de
  `README.md`/`DEPLOY.md` pueden no estar actualizadas; tratarlas como
  orientativas, confirmar contra el código.

Hallazgos puntuales con fecha (p. ej. una inconsistencia encontrada en
`DEPLOY.md`, o el efecto de cambiar una visibilidad) van a un informe en
`reports/`, no a esta sección.

## Comandos comprobados

```console
npm run lint             # eslint src && tsc (tsc usa noEmit:true de tsconfig.json)
npm run server            # node server/index.mjs
```

Pruebas automáticas (todas con datos simulados — nunca llaman a una API
real ni gastan dinero), corren directo con Node, sin framework:

```console
node server/test-audio-analysis.mjs
node server/test-cta-guarantee.mjs
node server/test-drive-simulated.mjs
node server/test-editorial-simulated.mjs
node server/test-quality-gate.mjs
node server/test-resource-acquisition.mjs
node server/test-image-generation.mjs
node server/test-subtitles.mjs
node server/test-timeline.mjs
node server/test-atomic-json-store.mjs
node server/test-video-normalization.mjs
node server/test-channel-editorial-loader.mjs
node server/test-captions-grouping.mjs
node server/test-render-worker.mjs
node server/test-container-metrics.mjs
node server/test-job-retry.mjs
node server/test-source-video-diagnostics.mjs
```

Estas **no** corren en esta Mac (necesitan FFmpeg/Chrome reales, que
macOS 12 no puede ejecutar aquí — ver `README.md`) — corren solo en GitHub
Actions, disparadas automáticamente en cada push a `main` que toque las
rutas correspondientes:

```console
node server/test-audio-regression.mjs             # .github/workflows/audio-regression-tests.yml
node server/test-video-conversion-regression.mjs  # .github/workflows/audio-regression-tests.yml
node server/test-captions-render.mjs              # .github/workflows/captions-destination-test.yml
node server/test-render-observability.mjs         # .github/workflows/captions-destination-test.yml
```

## Mantenimiento

Cualquier sesión que detecte un dato obsoleto en este archivo debe
corregirlo y decirlo explícitamente en el mensaje de commit (p. ej. "CLAUDE.md:
corrige el modelo editorial, ya no es X").
