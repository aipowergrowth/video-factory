# Video Factory — Informe de investigación
## Bancos audiovisuales y herramientas para Fase 3B (broll, image, graphic, music, sfx)
**31 de octubre de 2026 — solo investigación, nada implementado**

Fecha de consulta de todas las fuentes externas: 31 de octubre de 2026 (salvo que se indique otra). Esta etapa no instaló nada, no creó cuentas, no modificó el motor ni gastó dinero — es exactamente lo que pidió el dictamen.

---

## A. Recomendación principal

**Para empezar a ver resultados cuanto antes, sin gasto y sin riesgo legal nuevo:**

1. **`graphic` (gráficos/diagramas) — no se necesita ningún banco externo.** Video Factory ya tiene `GraphicOverlay` (chart/cycle/stat, código React+SVG, [src/types.ts:39-67](../src/types.ts)) funcionando desde hace rounds. Hoy el planificador editorial no lo usa para el tipo de recurso `"graphic"` — es la ganancia más rápida y de menor riesgo de toda esta investigación: enseñarle al planificador a proponer `chart`/`cycle`/`stat` en vez de (o además de) una descripción genérica. Cero licencias, cero API, cero dependencia nueva.
2. **`image`/`broll` — Pixabay como fuente por defecto, Pexels como respaldo.** Licencia propia (Content License) que permite uso comercial sin atribución obligatoria, API gratuita sin tope de plan, sin costo. Pexels cubre los huecos donde Pixabay no tenga un resultado relevante, con la única condición real de mostrar atribución cuando se usa vía API.
3. **`music`/`sfx` — Pixabay Music/SFX como fuente por defecto.** Misma licencia, mismo costo cero, y es la única opción gratuita de esta lista que cubre explícitamente los tres destinos (YouTube, Instagram, TikTok) sin la restricción "solo para YouTube" que sí tiene la Biblioteca de Audio de YouTube.
4. **La selección editorial (qué, cuándo, cuánto dura, por qué) la sigue haciendo nuestro propio planificador con Claude** — ninguna herramienta externa investigada reemplaza esa capa; todas son, como mucho, motores de búsqueda. La única pieza nueva de software es un paso de **"adquisición de recursos"** entre el plan ya aprobado y el render: toma cada `resource` que el planificador ya decidió (tipo, intervalo, descripción) y lo resuelve contra la fuente que corresponda, guardando la licencia de cada archivo.
5. **`get-brolls` (GitHub, MIT, instalable como skill/plugin de Claude Code) es el candidato externo más serio encontrado** — pero antes de integrarlo hace falta evaluarlo en un entorno aislado (requisito explícito del dictamen): usa `yt-dlp`/Playwright para ir a buscar la fuente *literal* de lo que se cita (persona, hecho, pantalla real), lo que acerca herramienta a Fase 3C — y también lo que trae más riesgo legal (descargar de YouTube/Instagram no es lo mismo que usar un banco con licencia explícita). Queda recomendado como **segunda etapa**, no para el primer resultado visual.

**Por qué este orden y no otro:** resuelve primero lo que no tiene ningún riesgo legal ni de mantenimiento (gráficos propios), después lo que tiene menor riesgo y mayor cobertura gratuita (Pixabay/Pexels), y deja para después lo que necesita más cuidado (herramientas de terceros que descargan de plataformas de video).

---

## B. Comparativa de bancos audiovisuales

### Aclaración obligatoria de términos (pedida explícitamente)

| Término | Qué significa | Qué NO significa |
|---|---|---|
| **Gratuito** | No cuesta dinero descargarlo. | No dice nada sobre si se puede usar comercialmente, ni sobre atribución. |
| **Royalty-free** | Se paga (o no) una vez, no por cada uso/reproducción. | No es lo mismo que "sin derechos de autor" — el autor sigue siendo el titular; "royalty-free" describe el modelo de pago, no la propiedad. |
| **Creative Commons** | Familia de licencias con condiciones específicas por variante (CC0, CC BY, CC BY-SA, CC BY-NC, etc.) — hay que leer CUÁL. | CC BY-NC prohíbe uso comercial; CC BY exige atribución. Ninguna CC excepto CC0 es "sin condiciones". |
| **Dominio público** | No hay titular de derechos de autor (obra muy antigua, o el gobierno de EE.UU. así lo declara para su propio contenido, p.ej. NASA). | La mayoría del contenido "gratuito" de internet NO es dominio público — es contenido con derechos de autor bajo una licencia permisiva. |

Ningún banco de esta lista se describe como "sin derechos de autor" en este informe — todos tienen un titular y una licencia específica, incluso cuando no cobran.

### Fotografías e ilustraciones

| Proveedor | Licencia | Uso comercial/monetización | Atribución | API | Límites/precio | Riesgo Content ID |
|---|---|---|---|---|---|---|
| **Pixabay** | [Content License](https://pixabay.com/service/terms/) (propia, no es CC) | Sí, explícito, incluye monetización en redes | No obligatoria (se agradece) | [Sí, gratuita](https://pixabay.com/api/docs/), requiere cuenta | 100 req/60s, caché de 24h obligatorio, sin plan pago | Bajo para imágenes (no aplica Content ID a fotos) |
| **Pexels** | [Licencia Pexels](https://www.pexels.com/terms-of-service/) (propia) | Sí, comercial y no comercial | No obligatoria para descarga manual; **obligatoria vía API** (crédito al fotógrafo con enlace) | Sí, gratuita | Límite inicial bajo, se levanta "gratis" si se muestra atribución | Bajo |
| **Unsplash** | [Unsplash License](https://unsplash.com/license) (propia) | Sí, comercial | No obligatoria en el sitio; **obligatoria vía API** (crédito al fotógrafo con enlace a su perfil) | Sí | Demo: 50 req/hora; producción (tras aprobación): 5000 req/hora | Bajo |
| **Freepik** | Licencia propia (Free/Premium/Merchandise) | **Plan gratis: NO permite uso comercial, ni con atribución**; plan pago sí, con restricción de "elemento secundario" | Obligatoria en plan gratis; no obligatoria en planes pagos | Solo en planes Premium/Premium+ (por créditos) | Pago desde el nivel con API | Bajo, pero cuidado con ilustraciones con elementos de marca |
| **Openverse** (agregador: Wikimedia, Flickr CC, Rawpixel, etc.) | **Varía por archivo** — CC0, PDM, CC BY, CC BY-SA, CC BY-NC, CC BY-ND y combinaciones | Depende de la licencia de CADA archivo — filtrable por API (`license_type=commercial`) | Depende del archivo | [Sí, API pública sin key](https://api.openverse.org/) | Gratis | Bajo, pero hay que guardar la licencia exacta de cada resultado, nunca asumir una licencia "de la plataforma" |
| **Wikimedia Commons** (directo) | Varía por archivo (igual que Openverse, es una de sus fuentes) | Depende del archivo; CC BY-NC está prohibida en Commons por política propia, así que lo que hay ahí suele admitir uso comercial, pero verificar | Depende del archivo (CC BY/BY-SA exigen crédito) | Sí (MediaWiki API) | Gratis | Bajo |

Fuentes: [Pixabay Content License summary](https://pixabay.com/service/license-summary/) · [Pixabay API docs](https://pixabay.com/api/docs/) · [Pexels Terms](https://www.pexels.com/terms-of-service/) · [Unsplash API terms explained](https://medium.com/unsplash/unsplash-api-our-terms-explained-c95f84894360) · [Freepik Premium licenses](https://support.freepik.com/s/article/What-are-Freepik-Premium-licenses?language=en_US) · [Openverse API](https://api.openverse.org/) · [Wikimedia Commons reuse guide](https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia/licenses).

### Video de apoyo / B-roll

| Proveedor | Licencia | Uso comercial | Atribución | API | Precio/límites | Nota |
|---|---|---|---|---|---|---|
| **Pixabay Video** | Content License (misma que fotos) | Sí | No obligatoria | Sí, misma API | Gratis | Catálogo más chico que fotos |
| **Pexels Video** | Licencia Pexels (misma que fotos) | Sí | Obligatoria vía API | Sí | Gratis | Buen catálogo de B-roll genérico |
| **Mixkit** | Licencia propia **por ítem** (Free vs. Restricted) | Depende del ítem — hay que revisar la etiqueta de CADA clip, no asumir | No obligatoria (se agradece) | **No tiene API oficial documentada** — habría que automatizar por scraping, que no es confiable ni recomendable | Gratis | Riesgo operativo: sin API no es automatizable de forma robusta |
| **Videvo** | Mixta: Royalty-Free (sin atribución) / Videvo Attribution / CC 3.0 — varía por clip | Sí, en los tres tipos | Obligatoria salvo en el tipo "Royalty-Free" o plan pago | No confirmada una API pública estable | Gratis + plan pago (quita atribución) | Hay que leer la licencia de cada clip individualmente |
| **Storyblocks** (pago) | Licencia por suscripción | Sí | No | Sí (plan empresarial) | Desde unos $15-30/mes según plan; **el derecho de uso de lo descargado expira si se cancela la suscripción**, salvo plan "Business" ($6000+/año) | Importante para nuestra idea de "biblioteca reutilizable": con planes normales, lo descargado deja de estar licenciado si se cancela |
| **Artlist (Footage)** | Licencia por suscripción (Artlist Max) | Sí, ilimitado mientras se publique estando suscrito | No | No pública para integración automatizada confirmada | Desde ~$39.99/mes (Max) | Lo publicado mientras se estaba suscrito queda cubierto después de cancelar; lo que no se usó, no |

Fuentes: [Pixabay](https://pixabay.com/service/terms/) · [Pexels](https://www.pexels.com/terms-of-service/) · [Mixkit license info (vía reseñas verificadas, Mixkit no publica una página de términos única por tipo de activo)](https://noncopyrighted.com/creator/mixkit/) · [Videvo license guide](https://www.licenseorg.com/guide/video/videvo) · [Storyblocks cancelación/licencia](https://help.storyblocks.com/en/articles/3622216-if-i-cancel-before-my-subscription-ends-will-i-be-refunded-for-any-unused-time) · [Artlist license](https://artlist.io/help-center/privacy-terms/artlist-license/).

### Música de fondo

| Proveedor | Licencia | Cobertura de plataformas | Atribución | Content ID | Precio |
|---|---|---|---|---|---|
| **Pixabay Music** | Content License | **Todas** (YouTube, Instagram, TikTok, cualquier plataforma) | No obligatoria | Bajo-medio (ver nota general abajo) | Gratis |
| **YouTube Audio Library** | Mixta: licencia propia de YouTube (**restringida a videos de YouTube únicamente** — usarla en Instagram/TikTok viola sus términos) o CC BY 4.0 (sí multiplataforma, con crédito) | **Solo YouTube** para la mayoría de pistas | Solo en pistas marcadas "CC BY" | Bajo en YouTube (gestionado por YouTube mismo) | Gratis |
| **Uppbeat** | Licencia propia por plan | Todas, en plan gratis (con crédito obligatorio) y pagos | **Obligatoria en plan gratis** (frase exacta: "Music by [Artista] en Uppbeat") | Riesgo si falta el crédito exacto | Gratis (3-10 descargas/mes) + planes pagos (Pro para freelance, Business para empresas) |
| **Epidemic Sound** | Licencia por suscripción | Todas | No | **Mecanismo propio de "whitelist" en YouTube Content ID** — reduce el riesgo operativo de reclamos, no solo el legal | Desde $9.99/mes (Creator) |
| **Artlist** | Licencia por suscripción | Todas, hasta 3 canales por plataforma en plan Pro | No | No confirmado un sistema de whitelist propio | Desde $9.99/mes (Music), $16.58-24.92/mes según nivel |
| **Mixkit Music** | Licencia propia (igual filosofía que su video) | Todas | No obligatoria | Bajo | Gratis |

Fuentes: [YouTube Audio Library — restricción a YouTube](https://www.licenseorg.com/guide/music-audio/youtube-audio-library) · [Uppbeat license guide](https://www.licenseorg.com/guide/music-audio/uppbeat) · [Epidemic Sound Content ID whitelist](https://servdigest.com/en/reviews/epidemic-sound-partner/) · [Epidemic Sound API](https://www.epidemicsound.com/tools/api/) · [Artlist pricing](https://artlist.io/page/pricing/max).

**Nota crítica que afecta a TODA la tabla de música (pedida explícitamente en la orden):** tener una licencia legal no es garantía de no recibir un reclamo de Content ID. Content ID identifica audio por huella digital, no por licencia — ha habido casos documentados de música "royalty-free" legítimamente licenciada generando reclamos igual, porque el proveedor (o un tercero) registró la pista en el sistema de Content ID sin coordinarlo con los usuarios de la licencia. Esto es exactamente por lo que Epidemic Sound vende su sistema de "whitelist" como un diferencial pagado — no es un problema que una licencia por sí sola resuelva. Fuente: [freetouse.com — por qué música "sin copyright" puede tener reclamos](https://freetouse.com/blog/no-copyright-music-subject-to-copyright-claims).

### Efectos de sonido

| Proveedor | Licencia | Atribución | Variante por archivo | API | Precio |
|---|---|---|---|---|---|
| **Pixabay SFX** | Content License | No | No (toda la plataforma, misma licencia) | Sí, misma API | Gratis |
| **Freesound.org** | **Varía por archivo**: CC0, CC BY, o CC BY-NC | Depende del archivo — CC BY y CC BY-NC exigen crédito, CC0 no | **Sí, archivo por archivo** — nunca asumir que todo Freesound es CC0 | Sí, [API documentada](https://freesound.org/docs/api/) | Gratis |
| **Zapsplat** | Licencia propia (Standard) | **Obligatoria en cuenta gratis** (crédito a "ZapSplat"); se puede quitar con cuenta de pago | No (cuenta gratis exige siempre atribución) | No hay API pública oficial confirmada para automatización | Gratis (con cuenta) + plan Gold (sin atribución) |
| **Mixkit SFX** | Licencia propia | No obligatoria | No | No confirmada | Gratis |

Fuentes: [Freesound license types](https://freesound.org/help/faq/) · [Zapsplat Standard License](https://www.zapsplat.com/license-type/standard-license/).

### Riesgo general de Content ID — separado de la legalidad (pedido explícitamente)

Dos preguntas distintas, nunca la misma:
1. **¿Tengo permiso legal para usar esto comercialmente?** — la responde la licencia.
2. **¿Puede un sistema automático (Content ID de YouTube, o equivalentes de Meta/TikTok) marcar mi video igual?** — la responde la huella digital del archivo, y el hecho de que el proveedor (o alguien que subió el mismo archivo a otra plataforma) lo haya registrado o no en ese sistema.

Pixabay/Pexels/Unsplash/Freesound/Openverse no ofrecen ningún mecanismo de "whitelist" — si un reclamo llega, se resuelve por disputa manual mostrando la prueba de licencia (por eso la Sección I de este informe insiste en guardar evidencia por recurso). Epidemic Sound es la única opción investigada con un sistema de prevención activo incorporado al precio de la suscripción.

---

## C. Comparativa de repositorios, skills y herramientas

| Candidato | Qué hace | Licencia / reutilizable | Mantenimiento real (verificado) | Clasificación |
|---|---|---|---|---|
| **[get-brolls](https://github.com/engenheirodevideo/get-brolls)** | Skill de Claude Code/Codex: busca B-roll (stock o "fuente literal" vía yt-dlp/Playwright), genera un storyboard local para revisión humana, entrega el clip final en MP4 con registro de fuente/licencia/aprobación. | **MIT** — sí se puede copiar/modificar/integrar libremente | **Verificado en vivo hoy** (no solo por el README): 180 ⭐, 18 forks, release v2.5.2 publicada el 23-oct-2026, push más reciente el 31-oct-2026. CI real: **los jobs de pruebas funcionales pasan en Ubuntu/Windows/macOS × Python 3.11/3.13/3.14**; solo falla un job de estilo de código (`pylint`), no de funcionamiento. | **Adaptable** — real y mantenido, pero requiere evaluación en entorno aislado antes de confiar en producción (usa Playwright + yt-dlp, dependencias pesadas con riesgo legal propio si se apunta a YouTube/Instagram sin cuidado) |
| **[reactvideoeditor/remotion-templates](https://github.com/reactvideoeditor/remotion-templates)** | Colección comunitaria de 80+ escenas/efectos de Remotion listos para copiar como componentes React. | **Sin archivo LICENSE detectable** (`gh api .../license` devuelve 404) — legalmente, sin una licencia explícita, el código es "todos los derechos reservados" por defecto aunque el repositorio sea público; copiarlo sin permiso es un riesgo legal real, no solo teórico | 281 ⭐, 39 forks, último push abril-2026 — actividad real pero más lenta que get-brolls | **Descartado para copiar código directamente** (sin licencia clara); **útil solo como referencia/inspiración visual**, nunca para pegar su código tal cual sin preguntar |
| **[zcxy-dev/fineframe](https://github.com/zcxy-dev/fineframe)** | Editor de video "totalmente automático" en desarrollo (footage + duración objetivo → corte con subtítulos). | Licencia `NOASSERTION` (no declarada claramente) | 2 ⭐, 4 issues abiertos, descripción dice explícitamente "in development" | **Experimental** — ni la licencia ni la madurez están probadas |
| **[OpenAnalystInc/10x-Brolls](https://github.com/OpenAnalystInc/10x-Brolls)** | "Producción profesional con gestión de marca usando Remotion". | **Sin licencia** | Un solo commit, nunca más actividad desde marzo-2026 | **Descartado** — abandonado, sin licencia |
| **CLIP / [open_clip](https://github.com/mlfoundations/open_clip)** | Modelo de similitud semántica texto↔imagen (no un producto, una pieza de modelo). | **MIT** (CLIP original de OpenAI) | Maduro, muy usado como pieza base en motores de búsqueda de imágenes desde 2021 | **Adaptable** — útil como filtro de relevancia semántica adicional sobre resultados de Pixabay/Pexels, pero exige correr un modelo propio (GPU recomendada, latencia, infraestructura nueva); no es un "producto" que se integre en un día |
| **[Openverse API](https://api.openverse.org/)** | Buscador unificado de contenido con licencia CC/dominio público (agrega Wikimedia, Flickr CC, Rawpixel y más). | API pública, sin key, bajo los términos de Openverse (proyecto de la Wikimedia Foundation/Automattic) | Mantenido activamente por la comunidad Openverse/WordPress | **Reutilizable directamente** como fuente de búsqueda adicional, especialmente para contenido verdaderamente CC0/dominio público |
| **n8n community node `n8n-nodes-pexels`** | Nodo de n8n para llamar la API de Pexels desde un workflow. | Depende del paquete npm (a verificar su licencia puntual antes de instalar) | No confirmada su actividad de mantenimiento en esta sesión | **Experimental** — no verificado lo suficiente como para calificarlo de confiable; de todas formas, nuestra arquitectura ya llama APIs HTTP directamente desde `server/` sin necesitar n8n como intermediario para esto |
| **"AI Video Editor" / "Edit-Mind" / "B-Roll Finder" (nombres genéricos encontrados en búsquedas)** | Proyectos descritos en blogs/agregadores de temas de GitHub, sin un repositorio concreto y verificable identificado con ese nombre exacto. | No verificable | No verificable | **No evaluado** — no se encontró un repositorio específico y confirmable detrás de estos nombres; no se presentan como probados, siguiendo la instrucción explícita de este encargo |

### Lo que NO existe como herramienta lista para usar

No se encontró ningún proyecto open source maduro que haga **selección editorial inteligente de B-roll** (entender la intención narrativa completa, decidir si conviene B-roll o mantener al presentador, decidir la duración exacta) de forma autónoma y confiable. Lo que sí existe (get-brolls, CLIP) son herramientas de **búsqueda/recuperación** que necesitan una capa de decisión encima — exactamente el rol que ya cumple nuestro planificador editorial con Claude. Esto confirma la recomendación de la sección A: no hay nada que reemplace esa pieza, solo piezas que la alimenten.

---

## D. Componentes existentes que podemos reutilizar

**Dentro de Video Factory, ya funcionando:**
- `GraphicOverlay` ([src/types.ts](../src/types.ts), componentes en `src/engine/`) — chart/cycle/stat generados en código, cero dependencia externa. Resuelve una parte real de `graphic` HOY, sin ningún banco.
- `remapRangeToOutput`/`buildTimeline` (`server/timeline.mjs`, `src/engine/timeline.ts`) — ya traduce cualquier tiempo "del original" a tiempo "editado"; cualquier recurso adquirido se posiciona con la MISMA lógica que ya usan CTA y subtítulos, sin inventar un segundo mecanismo.
- `remapResourcesWithCtaGuarantee`/`computePendingResources` (`server/cta-guarantee.mjs`) — ya separa "recurso que se puede renderizar hoy" de "recurso pendiente", y ya seguiría funcionando igual si `broll`/`image`/`music`/`sfx` empiezan a tener un archivo real detrás.
- `@anthropic-ai/sdk` (ya en `package.json`) — la misma integración que usa el planificador editorial puede usarse para la verificación de relevancia semántica ("¿esta imagen/clip de verdad corresponde a esta descripción?") sin agregar una dependencia de IA nueva.
- El patrón de `server/drive.mjs` (descarga con reintentos, subida con manejo de errores) — mismo patrón aplicable a descargar un asset de Pixabay/Pexels y subir evidencia de licencia.
- El patrón de registro de incidencias ya usado en `cutIssues`/`pendingResources`/los informes de calidad de audio — el mismo patrón ("nunca fallar en silencio, siempre registrar la razón") aplica directo a "no se encontró un recurso con licencia confirmada para esta descripción".

**Lo que NO encontramos en el repositorio:**
- Ningún archivo correspondiente a "la investigación de herramientas solicitada por el auditor el 30 de octubre" ni a "la propuesta anterior de motion graphics" — se buscó en todo el repositorio (`grep` por esos términos) y no aparece ningún documento. Si existen fuera del repositorio (otro chat, un documento de Alex), pedimos que se comparta el archivo o el enlace — este informe se escribió sin ese antecedente porque no estaba disponible.

---

## E. Arquitectura de integración recomendada (sin implementar todavía)

```
Planificador editorial (ya existe, sin cambios en su lógica de decisión)
        │ decide: tipo, intervalo, descripción, editorialGoal — igual que hoy
        ▼
[NUEVO] Paso de adquisición de recursos (server/resource-acquisition.mjs, propuesto)
        │
        ├─ type === "graphic"  → NO llama a ningún banco; traduce la descripción a
        │                         props de chart/cycle/stat y usa GraphicOverlay (ya existe)
        │
        ├─ type === "image" / "broll" → consulta Pixabay API (principal) y Pexels API
        │                                (respaldo) con las palabras clave de `description`;
        │                                opcional: verificación de relevancia con Claude
        │                                (reutiliza @anthropic-ai/sdk) antes de aceptar el
        │                                resultado -- acá es donde se diferencia "encontrar
        │                                un archivo" de "elegir el archivo correcto"
        │
        ├─ type === "music" / "sfx"    → Pixabay Music/SFX por defecto
        │
        └─ cada recurso resuelto guarda un registro de licencia (proveedor, id del
           archivo, nombre de la licencia, URL de los términos, si exige atribución,
           fecha de descarga) -- mismo patrón que ya usa job.cutIssues/pendingResources,
           persistido junto al job

        ▼
remapResourcesWithCtaGuarantee (SIN CAMBIOS -- ya sabe posicionar en tiempo editado)
        ▼
VideoEngine.tsx (Remotion) -- ResourceRenderer ya existe; se extiende para
        pintar Img/OffthreadVideo/Audio con el archivo ya descargado localmente
        (igual patrón que RecordedVideoSource, que ya usa OffthreadVideo+staticFile)
```

**Por qué esta forma y no otra:** no se agrega ningún motor de edición nuevo ni un segundo sistema de decisión — se inserta UN solo paso nuevo entre "el plan ya está decidido" y "el motor ya sabe renderizarlo", reutilizando en ambos lados código que ya existe y ya está probado.

---

## F. Alternativas descartadas

- **Freepik (plan gratis)** — descartado para uso automatizado porque su plan gratis prohíbe uso comercial incluso con atribución; usarlo exigiría una suscripción paga desde el día uno solo para empezar a probar.
- **Mixkit** — descartado como fuente PRIMARIA (no secundaria) por no tener una API pública documentada; automatizarlo exigiría scraping, frágil y contra el espíritu de "sin búsquedas manuales constantes" del propio encargo.
- **`reactvideoeditor/remotion-templates`** — descartado para copiar código directamente por no declarar ninguna licencia (ver sección C); puede seguir usándose como inspiración visual, nunca como código pegado sin preguntar.
- **`zcxy-dev/fineframe` y `OpenAnalystInc/10x-Brolls`** — descartados por inmadurez/abandono verificado (no por falta de popularidad, sino por evidencia real de actividad y licencia).
- **YouTube Audio Library como fuente única de música** — descartada como fuente ÚNICA (no como opción) porque su licencia estándar no cubre Instagram ni TikTok, y nuestros 3 canales publican en vertical-9-16 además de YouTube.
- **Construir nuestro propio buscador semántico con CLIP desde cero, ahora** — descartado para esta etapa: es una pieza de infraestructura de modelo (GPU, latencia, mantenimiento de embeddings) que no se justifica antes de confirmar que la búsqueda por palabras clave de Pixabay/Pexels no alcanza. Queda anotado como mejora futura, no como parte de la primera versión.
- **Cualquier herramienta tipo SaaS cerrado (Opus Clip, Submagic, Descript, etc.)** — no investigadas a fondo porque no son compatibles con nuestra arquitectura auto-hospedada (Remotion + FFmpeg + Docker propio); son productos para operar manualmente desde su propia interfaz, no piezas que se integren a nuestro pipeline.

---

## G. Orden propuesto de integración

1. **Primero — `graphic` con `GraphicOverlay`.** Cero nuevas dependencias, cero licencias que gestionar, reutiliza código ya probado. Resultado visual más rápido posible.
2. **Segundo — `image`/`broll` con Pixabay (+ Pexels de respaldo).** Gratis, API ya documentada, sin suscripción que gestionar. Requiere: el paso nuevo de adquisición + el registro de licencia por recurso.
3. **Tercero — `music`/`sfx` con Pixabay.** Mismo trabajo de integración que el punto 2, reutilizando el mismo cliente de API.
4. **Después, solo si Alex decide que la variedad/calidad de Pixabay no alcanza — evaluar Epidemic Sound o Artlist para música** (gasto nuevo, requiere su autorización explícita).
5. **En paralelo, sin bloquear nada de lo anterior — evaluar `get-brolls` en un entorno aislado** (no en la Mac de Alex en producción) para medir si de verdad acelera la adquisición de B-roll "literal" y si su huella de dependencias (Playwright, yt-dlp) es manejable en nuestro Docker.

---

## H. Costos estimados

| Partida | Costo | Tipo |
|---|---|---|
| Pixabay (fotos, video, música, SFX) + API | **$0** | Gratuito, sin plan pago que ofrecer |
| Pexels (respaldo de fotos/video) + API | **$0** | Gratuito |
| Openverse (búsqueda adicional CC) | **$0** | Gratuito |
| Verificación de relevancia con Claude (opcional, sección E) | Consumo de tokens de la API de Anthropic ya en uso — variable, depende de cuántos recursos se verifiquen por job; **no estimado aquí porque no se implementó nada que medir** | Variable, ya facturado por el uso actual de la API |
| Epidemic Sound (si se decide más adelante) | Desde $9.99/mes (Creator) | Suscripción, **no recomendada para la primera versión** |
| Artlist (si se decide más adelante) | Desde $9.99-39.99/mes según plan | Suscripción, **no recomendada para la primera versión** |
| Evaluación de `get-brolls` en entorno aislado | $0 de licencia (MIT) — tiempo de ingeniería para probarlo, no cuantificado aquí | Tiempo, no dinero |

No se inventó ningún precio no confirmado: todo lo de esta tabla viene de las páginas oficiales citadas en la sección B/C.

---

## I. Fuentes verificables

Todas consultadas el 31 de octubre de 2026.

**Bancos audiovisuales:**
- [Pixabay — Content License summary](https://pixabay.com/service/license-summary/)
- [Pixabay — Terms of Service](https://pixabay.com/service/terms/)
- [Pixabay — API docs](https://pixabay.com/api/docs/)
- [Pexels — Terms and Conditions](https://www.pexels.com/terms-of-service/)
- [Pexels — API](https://www.pexels.com/api/)
- [Unsplash — API terms explained](https://medium.com/unsplash/unsplash-api-our-terms-explained-c95f84894360)
- [Freepik — Premium licenses](https://support.freepik.com/s/article/What-are-Freepik-Premium-licenses?language=en_US)
- [Openverse — API](https://api.openverse.org/)
- [Wikimedia Commons — Reusing content outside Wikimedia](https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia/licenses)
- [Freesound — FAQ (licencias)](https://freesound.org/help/faq/)
- [Freesound — API docs](https://freesound.org/docs/api/)
- [Zapsplat — Standard License](https://www.zapsplat.com/license-type/standard-license/)
- [YouTube Audio Library — guía de licencia (restricción a YouTube)](https://www.licenseorg.com/guide/music-audio/youtube-audio-library)
- [Uppbeat — guía de licencia](https://www.licenseorg.com/guide/music-audio/uppbeat)
- [Epidemic Sound — API](https://www.epidemicsound.com/tools/api/)
- [Epidemic Sound — reseña técnica (whitelist de Content ID)](https://servdigest.com/en/reviews/epidemic-sound-partner/)
- [Artlist — Pricing](https://artlist.io/page/pricing/max)
- [Artlist — licencia](https://artlist.io/help-center/privacy-terms/artlist-license/)
- [Storyblocks — qué pasa al cancelar](https://help.storyblocks.com/en/articles/3622216-if-i-cancel-before-my-subscription-ends-will-i-be-refunded-for-any-unused-time)
- [Videvo — guía de licencia](https://www.licenseorg.com/guide/video/videvo)
- [NASA — Guidelines for Images and Media](https://www.nasa.gov/nasa-brand-center/images-and-media/)
- [freetouse.com — por qué música "sin copyright" puede recibir reclamos de Content ID igual](https://freetouse.com/blog/no-copyright-music-subject-to-copyright-claims)

**Herramientas y repositorios** (verificados en vivo vía API de GitHub el 31-oct-2026, no solo por su README):
- [github.com/engenheirodevideo/get-brolls](https://github.com/engenheirodevideo/get-brolls) — 180 ⭐, MIT, release v2.5.2, CI funcional en verde (solo falla un chequeo de estilo de código)
- [github.com/reactvideoeditor/remotion-templates](https://github.com/reactvideoeditor/remotion-templates) — 281 ⭐, sin LICENSE detectable
- [github.com/zcxy-dev/fineframe](https://github.com/zcxy-dev/fineframe) — 2 ⭐, licencia no declarada, "in development"
- [github.com/OpenAnalystInc/10x-Brolls](https://github.com/OpenAnalystInc/10x-Brolls) — 4 ⭐, sin licencia, sin actividad desde marzo-2026
- [github.com/openai/CLIP](https://github.com/openai/CLIP) — MIT
- [github.com/mlfoundations/open_clip](https://github.com/mlfoundations/open_clip) — implementación abierta de CLIP

**Dato no confirmado de forma independiente en esta sesión** (señalado explícitamente, no presentado como comprobado): la actividad de mantenimiento del paquete npm `n8n-nodes-pexels` y la existencia de proyectos concretos detrás de los nombres genéricos "AI Video Editor"/"Edit-Mind"/"B-Roll Finder" encontrados en agregadores de blogs — no se identificó un repositorio específico y verificable para estos tres últimos.

---

## J. Requisitos para avanzar (decisiones de Alex)

Nada de esto se ejecuta sin que Alex decida:

1. **Confirmar el orden de la sección G** (o pedir otro orden).
2. **Autorizar crear las cuentas gratuitas de Pixabay y Pexels** para obtener las API keys (gratis, sin tarjeta de crédito en Pixabay; a confirmar si Pexels pide alguna forma de verificación) — las claves se gestionarían como secretos de Docker, nunca en el chat ni en el repositorio, igual que las credenciales de Drive actuales.
3. **Decidir si se evalúa `get-brolls`** en un entorno aislado (no en la Mac de producción) como siguiente paso exploratorio, y con qué alcance de fuentes (¿solo NASA/bancos con licencia explícita, o también yt-dlp contra YouTube/Instagram, aceptando ese riesgo legal específico?).
4. **Decidir si, más adelante, se justifica una suscripción paga de música** (Epidemic Sound o Artlist) una vez que se vea en la práctica si el catálogo gratuito de Pixabay Music alcanza para los tres canales.
5. Compartir, si existen fuera del repositorio, los documentos de "la propuesta anterior de motion graphics" y "la investigación de herramientas del 30 de octubre" mencionados en el encargo — no se encontraron en el repositorio (ver sección D).

No se avanza a implementación, no se instala nada, no se crean cuentas ni se gasta dinero hasta recibir esas decisiones.
