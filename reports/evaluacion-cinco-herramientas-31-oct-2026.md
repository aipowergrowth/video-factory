# Video Factory — Informe de evaluación
## Cinco herramientas señaladas por Alex
**31 de octubre de 2026 — solo evaluación, nada instalado ni ejecutado**

Método: toda la evidencia se obtuvo leyendo metadatos, commits, licencias, READMEs y archivos de documentación reales vía la API de GitHub (`gh api`, de solo lectura) — nunca se clonó ni ejecutó código de ninguno de los cinco repositorios, en ninguna máquina. Fecha de consulta de todo: 31-oct-2026.

---

## Tabla de veredictos

| # | Herramienta | Veredicto | Por qué (una línea) |
|---|---|---|---|
| 1 | [HyperFrames](https://github.com/heygen-com/hyperframes) | **No sirve** como motor; su catálogo de componentes, solo como referencia de ideas | Motor de render competidor (HTML→MP4 vía Chrome), no una librería complementaria a Remotion — adoptarlo exigiría reconstruir todo lo que ya tenemos funcionando |
| 2 | [OpenMontage](https://github.com/calesthio/OpenMontage) | **No sirve** | AGPL-3.0 real (confirmado en el archivo LICENSE) — riesgo legal concreto para nuestro servicio cerrado desplegado en red; además está pensado para contenido generado por IA, no para editar una grabación real |
| 3 | [Claude Shorts](https://github.com/AgriciDaniel/claude-shorts) | **Sirve en parte** | El pipeline central (extraer un corto de un video largo) no aplica a Alex; sus componentes de subtítulos animados en Remotion (MIT, sin dependencias Python) sí son código reutilizable si algún día se quieren subtítulos más vistosos |
| 4 | [Ghost Editor](https://github.com/kurbaitaev/ghost-editor) | **Sirve en parte** (ideas, no código) | Corre sobre HyperFrames (no Remotion), solo Mac Apple Silicon, usa Gemini/ElevenLabs — el código no es portable a nuestro Docker Linux; pero sus 3 ideas señaladas son reales, confirmadas en su documentación, y mayormente ya implementables con lo que tenemos |
| 5 | [FFmpeg Skill](https://github.com/kajisho5/ffmpeg-skill) | **No sirve para integrar directo**; su patrón de "doctor" sí, como idea | Exige una build de FFmpeg completa (drawtext, libass, xfade, overlay, cropdetect, …) muy distinta de la mínima que trae el compositor de Remotion que ya usamos en producción — evidencia de mantenimiento y pruebas excelente, pero no resuelve nuestro problema sin cambiar de binario de FFmpeg |

---

## 1. HyperFrames

**Qué hace realmente:** un framework que convierte HTML/CSS/animaciones en MP4 deterministas, renderizado con Chrome headless — "Write HTML. Render video." Se instala como plugin/skill de Claude Code, Codex, Cursor, etc. Trae ~450 bloques/componentes listos (transiciones, gráficos, mapas, 3D) y una CLI (`hyperframes init/preview/render`).

**Licencia:** Apache-2.0 (confirmado en el LICENSE del repositorio) — permisiva, sin problema para uso comercial ni para copiar/modificar código puntual.

**Mantenimiento:** muy activo y verificable — 7014 forks, commits de hoy mismo (01-nov-2026), más de 10 colaboradores reales con cientos/miles de commits cada uno, respaldado por HeyGen (empresa real). La cifra de estrellas (76 678) es inusualmente alta para una herramienta de este nicho en ~8 meses de vida (creado 10-mar-2026) — no pude confirmar de forma independiente si refleja adopción orgánica o promoción agresiva (algo común en este período para herramientas "agentic"); lo señalo como no confirmado, sin acusar nada, ya que la actividad de commits sí es genuina.

**Compatibilidad con Remotion/nuestro FFmpeg:** ninguna — es un motor de render ALTERNATIVO a Remotion, no una pieza que se le agregue. El propio proyecto tiene una skill llamada `/remotion-to-hyperframes` ("traer código o metraje de Remotion a HyperFrames") — está pensado como un REEMPLAZO de Remotion, no un complemento. Sus requisitos declarados son "Node.js 22+, FFmpeg" (genérico, sin precisar si necesita una build mínima o completa — no confirmado).

**Qué se puede aprovechar:** nada de código de forma directa (adoptarlo significa migrar TODO nuestro motor: `VideoEngine.tsx`, `CtaOverlay`, `Captions`, `ResourceRenderer`, toda la lógica de `timeline.mjs`, los tres canales). Su catálogo de ~450 componentes (Apache-2.0) es una referencia legítima de ideas visuales para cuando trabajemos motion graphics más adelante — igual que hizo `ghost-editor` (ver abajo), que estudió sus componentes de subtítulos sin copiar su motor.

**Reafirmación de la conclusión del 30 de octubre:** no tengo acceso a esa investigación anterior (no está en este repositorio ni en mi contexto) — la rehíce desde cero. Mi conclusión independiente coincide: nada de lo nuevo (más actividad, más estrellas, más componentes) cambia el hecho de que es un motor competidor, no una librería — seguiría sin servir para nuestro caso por la misma razón de fondo, no por falta de calidad del proyecto en sí.

**Esfuerzo si se quisiera adoptar como motor:** reconstrucción completa — no cuantificable como "una tarea", es rehacer el proyecto.

---

## 2. OpenMontage

**Qué hace realmente:** "sistema de producción de video agéntico" — un agente de IA que investiga, escribe guion, genera assets (imágenes/video con modelos como Veo, Kling, modelos de imagen), edita el timeline y compone el resultado final con Remotion. Tiene una interfaz local ("Backlot") que muestra el progreso y pide aprobación por escena antes de generar/renderizar.

**Licencia:** **AGPL-3.0, confirmado en el archivo LICENSE del repositorio** (no es una suposición). Esto es relevante de forma concreta para nosotros: la AGPL exige que, si el software se ofrece como servicio a través de una red (exactamente nuestro caso — Video Factory corre como servicio HTTP interno), cualquier código derivado/modificado tendría que publicarse bajo la misma licencia. Copiar o adaptar código de OpenMontage a nuestro motor (cerrado, comercial) sería un riesgo legal real, no teórico.

**Mantenimiento:** activo y real — commits de hace días, "#1 Repositorio del Día" en GitHub Trending (según su propio README, no verificado por un tercero), múltiples colaboradores con historial de commits genuino. Mismo comentario sobre la cifra de estrellas que en HyperFrames (74 077, incluso más alta en proporción a su edad) — no confirmado si es orgánica.

**Compatibilidad con Remotion/FFmpeg:** usa Remotion para la composición final, pero el resto del pipeline (generación de video con modelos de IA pagos, Blender, modelos de imagen) no tiene nada que ver con nuestra arquitectura ni con nuestro caso de uso (editar una grabación real, no generar escenas sintéticas).

**Qué se puede aprovechar:** ideas únicamente, nunca código (por la AGPL) — y aun como idea, el enfoque central (contenido generado por IA) no resuelve nuestro problema: Alex graba contenido real, no pide escenas generadas. La idea de "Backlot" (tablero de aprobación por escena en vivo) es conceptualmente similar a lo que ya hacemos con `pendingResources`/los informes de calidad, así que no aporta algo nuevo.

**Qué problema nuestro resolvería:** ninguno que no tengamos ya cubierto de otra forma, y el que sí resuelve (generar video con IA) no es un problema que tengamos.

---

## 3. Claude Shorts

**Qué hace realmente:** skill de Claude Code que toma un video largo, lo transcribe (faster-whisper + GPU), hace que Claude puntúe candidatos a clip viral (5 dimensiones: hook, coherencia, emoción, densidad, resolución), ajusta los cortes a límites de palabra/silencio, reencuadra a 9:16 siguiendo la cara (MediaPipe) o el cursor (para grabaciones de pantalla), y renderiza con Remotion subtítulos animados (3 estilos) más exportación por plataforma.

**Licencia:** MIT, confirmado — sin restricción para reutilizar código.

**Mantenimiento:** modesto — 1 solo colaborador (el autor), 268 estrellas (cifra plausible, no inusual), último commit el 10-abr-2026 — **7 meses sin actividad** a la fecha de esta evaluación. No hay evidencia de mantenimiento reciente ni de que siga actualizándose.

**Compatibilidad con Remotion:** alta en la PARTE de renderizado — usa Remotion v4 + React 19, igual que nosotros. La carpeta `remotion/src/components/` (`BoldCaptions.tsx`, `BounceCaptions.tsx`, `CleanCaptions.tsx`, `HookOverlay.tsx`) son componentes React independientes del resto del pipeline (no dependen de Python/transcripción/reencuadre) — en principio portables a nuestro `src/engine/` sin arrastrar nada más.

**Punto 7 pedido explícitamente — el caso de Alex:** Alex grava sus Shorts directamente en vertical y no recorta sus videos largos. Esto deja **sin uso real** las etapas 1-4 y 8 del pipeline (preflight, transcripción con GPU/CUDA, detección de tipo de contenido, puntuación de segmentos virales, extracción de clips) y la etapa de reencuadre (face-tracking con MediaPipe, cursor-tracking) — todo eso resuelve "¿qué 40 segundos de un video de 20 minutos vale la pena recortar?", una pregunta que Alex no tiene: él ya decide qué grabar y grabarlo ya en 9:16. Lo que SÍ sirve igual, porque no depende de ese contexto: los componentes de subtítulos animados en Remotion (karaoke por palabra, 3 estilos visuales) — son simplemente "cómo pintar un subtítulo bonito en Remotion", útil sin importar si el video se recortó de otro o se grabó directo.

**Qué se puede aprovechar:** código de los 4-5 componentes de captions (MIT, Remotion, sin dependencias Python/GPU) — esfuerzo bajo si se decide mejorar nuestro `Captions.tsx` actual (hoy es un solo estilo simple) más adelante. El resto (transcripción GPU, reencuadre, scoring) no aplica y traería dependencias pesadas (PyTorch, MediaPipe, OpenCV, CUDA) que no tenemos ni necesitamos en nuestro Docker (CPU-only).

---

## 4. Ghost Editor

**Qué hace realmente:** skill de Claude Code — toma una grabación cruda de cámara (talking-head), transcribe (Whisper), elige la mejor repetición de cada frase, sigue la cara (OpenCV YuNet), y el agente escribe un plan (`reel.json`: tomas, estilo, beats) que `build.mjs` convierte en una composición **de HyperFrames** (no Remotion), renderizada con Chrome headless. 19 estilos visuales predefinidos (Clean OS, Kinetic Doc, News Package, etc.).

**Licencia:** MIT, confirmado. El propio proyecto declara en su documentación de terceros (`docs/THIRD_PARTY/`) exactamente qué tomó de dónde: "Everything was written for this skill; [varias fuentes] fueron estudiadas solo por ideas" — incluye explícitamente: *"ideas only (OpenMontage is AGPL)"* — el propio autor evitó copiar de proyectos AGPL, señal de cuidado legal real.

**Mantenimiento:** modesto pero real — 1 colaborador, 130 estrellas, último commit 30-oct-2026 (ayer). Nota menor: sus primeros commits (oct-2026) están firmados como "Your Name" (el placeholder de git sin configurar) — indicio de que empezó como proyecto personal poco pulido, corregido después; no es descalificante, pero resta algo de confianza comparado con un proyecto con revisión de código de terceros.

**Compatibilidad con Remotion/FFmpeg — confirmado, no solo la pista del operador:**
- **Depende de HyperFrames** para renderizar (`docs/THIRD_PARTY/runtime.md`: "HyperFrames CLI... | lint, snapshot, render") — confirma la pista exactamente. No usa Remotion.
- **Solo Mac con chip Apple**, confirmado textualmente en su propio README: "A Mac with Apple silicon. Linux and Intel Macs are untested." Además, una de sus verificaciones de calidad (el chequeo de contraste/tamaño del subtítulo) usa literalmente `macOS Vision` vía `osascript` — no puede correr en Linux en absoluto, ni con esfuerzo moderado.
- Usa **Google Gemini** (clave propia, los fotogramas que revisa se envían a Google) para varias verificaciones, y **ElevenLabs** solo para narración sintética (no aplica a nuestro caso, Alex narra él mismo).
- Para B-roll usa Pexels (por el enlace público de descarga, no la API oficial) y Mixkit — dato nuevo no cubierto en mi investigación anterior: su propia documentación aclara que la licencia gratuita de Mixkit Video **solo cubre los clips ofrecidos en 2160p**; los de menor resolución son "solo para uso personal" en los términos de Mixkit. Lo anoto como hallazgo útil para el informe de bancos audiovisuales anterior, aunque no es parte de este encargo.

**Las tres ideas pedidas explícitamente — confirmadas con texto literal de su documentación, no solo la paráfrasis del operador:**

1. **"La voz se nivela a -16 LUFS" antes de mezclar** (`docs/HOW-IT-WORKS.md`, paso 1 del pipeline, cita textual). — **Totalmente aprovechable por nosotros, con costo casi cero**: nuestro FFmpeg de producción YA tiene confirmado el filtro `loudnorm` (verificado en la investigación de audio de esta misma semana). No hace falta ninguna dependencia nueva, solo un paso de normalización de audio con el filtro que ya existe en nuestro binario.
2. **"Subtítulos que no tocan la cara"**: cada bloque de subtítulo/tarjeta va debajo del mentón; si no hay espacio, arriba de la cabeza; si tampoco, se encoge — siempre dentro del área segura de la plataforma (instagram/tiktok/shorts) y lejos de los botones de like/comentario (`docs/HOW-IT-WORKS.md`). El MECANISMO que usan (seguimiento de cara con OpenCV YuNet) **no es portable** a nuestro Docker sin agregar una dependencia de visión por computadora que hoy no tenemos. La IDEA sí es valiosa, especialmente para `vertical-9-16` (destino donde SÍ pegamos subtítulos, según la decisión reciente de Alex): hoy nuestro `Captions.tsx` ancla siempre abajo, sin ningún chequeo de si ahí está la cara del presentador. Una versión simple (sin detección de cara real) podría ser una zona segura configurable por canal, en vez de seguimiento en vivo — más barato, menos preciso.
3. **"Revisión de calidad del video terminado"**: tras renderizar, chequea sonoridad, pico real, nivel de cada efecto de sonido contra la voz, y dónde cayó cada subtítulo (`docs/HOW-IT-WORKS.md`, paso 7 "Check"). — **Esto es, en esencia, lo que ya construimos** en la solución estructural de audio de esta semana (`server/quality-gate.mjs`): verificar automáticamente el resultado antes de aceptarlo, en vez de confiar a ciegas. No es una idea nueva para nosotros, es una confirmación de que el camino que ya tomamos es el correcto. Lo único que agregaría (si quisiéramos ir más lejos) es extender nuestra puerta de calidad para medir LUFS (barato, mismo `loudnorm` ya mencionado) y, más adelante, "el subtítulo no tapa la cara" (caro, necesita detección de cara).

**Esfuerzo:** la idea 1 (LUFS) es de horas, con lo que ya tenemos. La idea 3 (extender quality-gate) es de horas a un día. La idea 2 (subtítulos fuera de la cara) de forma simple (zona segura fija) es de horas; de forma real (seguimiento de cara) es un proyecto aparte con una dependencia nueva, no trivial.

---

## 5. FFmpeg Skill

**Qué hace realmente:** una skill/servidor MCP para Claude Code, Cursor y Codex que expone 42 herramientas de FFmpeg (cortar, unir, quitar silencios, encuadrar, subtítulos y karaoke, overlays, HDR→SDR, limpieza de audio, sincronización multicámara, chequeos de entrega) con un contrato legible por máquina y verificación automática del resultado (probar antes y después, mirar el fotograma cuando la imagen cambia).

**Licencia:** MIT, confirmado.

**Mantenimiento y evidencia de funcionamiento — la más sólida de las cinco herramientas:** CI real pasando contra FFmpeg 6.1, 7.1, 8.x y 9.x en Linux/macOS/Windows en cada pull request; un paper académico (Zenodo, con DOI) documentando su disciplina de diseño; decenas de "evals" versionados con resultados medidos (no afirmados) sobre cientos de prompts reales, incluyendo fallos honestos reportados cuando algo no funcionaba. Esto es evidencia de funcionamiento genuinamente verificable, no solo un README que promete.

**Compatibilidad con nuestro FFmpeg de producción — confirmado contra la lista exacta de filtros que la propia investigación de esta semana estableció:**

La herramienta exige, para que `doctor` reporte todo disponible: `libx264`, `aac`, y los filtros `drawtext`, `subtitles` (libass), `loudnorm`, `xfade`, `acrossfade`, `amix`, `overlay`, `scdet`, `silencedetect`, `cropdetect`, `tile`, `tpad`, `boxblur`, `hqdn3d`, `yadif`, `reverse`, `rotate`, `showwaves`, `v360`, `xstack` (cita textual de su README, sección "Requirements").

Contra la lista CONFIRMADA de nuestro FFmpeg de producción (compositor de Remotion, `--disable-filters` + lista explícita de habilitados): tenemos `loudnorm`, `amix` y `silencedetect` — **tres de los veinte**. Nos faltan, confirmado: `drawtext`, `subtitles`/libass, `xfade`, `acrossfade`, `overlay`, `scdet`, `cropdetect`, `tile`, `tpad`, `boxblur`, `hqdn3d`, `yadif`, `reverse`, `rotate`, `showwaves`, `v360`, `xstack`.

**Qué haría falta para que corriera en nuestro Docker:** reemplazar el FFmpeg mínimo que trae el compositor de Remotion por una build completa (la propia herramienta recomienda `apt install ffmpeg` en Debian/Ubuntu, que trae todo lo anterior) — pero eso significa mantener DOS binarios de FFmpeg distintos en la imagen (el de Remotion, que el motor necesita tal cual para que el render siga funcionando; uno completo, para estas herramientas), con el costo de imagen y mantenimiento que eso implica. No es un cambio chico.

**Por qué, de fondo, no es sorprendente:** nuestro FFmpeg es mínimo porque Remotion hace el trabajo VISUAL con Chrome (HTML/CSS/React) — nunca necesitó `drawtext`/`overlay`/`xfade`. `ffmpeg-skill` asume lo contrario: que FFmpeg mismo hace todo el trabajo visual. Son dos arquitecturas distintas para el mismo problema, no una pieza que se enchufa en la otra.

**Qué se puede aprovechar:** ninguna línea de código (exige el binario que no tenemos) — pero el PATRÓN de `doctor` (preguntarle al propio binario de FFmpeg qué filtros/encoders/muxers tiene ANTES de intentar usarlos, en vez de descubrirlo por un error en producción) es una idea con valor real para nosotros: en esta misma semana tuvimos que descubrir, por ensayo y error contra producción, qué filtros tenía nuestro FFmpeg (`s16le` no, `color` no, `rawvideo` no). Formalizar un chequeo de capacidades al iniciar el servicio (algo que ya casi hacemos a mano) evitaría repetir ese proceso para el próximo filtro que necesitemos.

---

## Recomendación final ordenada

**Adoptar, en este orden, si Alex lo autoriza como una tarea aparte (nada de esto está en el alcance de esta evaluación):**

1. **Normalizar la voz a -16 LUFS con `loudnorm`** (idea de Ghost Editor, ejecutable hoy con el filtro que ya está confirmado en nuestro FFmpeg de producción) — el de menor costo y mayor beneficio inmediato de las ideas evaluadas.
2. **Extender `quality-gate.mjs`** para medir y reportar el LUFS resultante como parte de su chequeo (ídem, reutiliza lo mismo).
3. **Formalizar un chequeo de capacidades de FFmpeg al iniciar el servicio** (idea tomada de `ffmpeg-skill`'s `doctor`, no su código) — para dejar de descubrir filtros faltantes por ensayo y error en producción.
4. **Portar los componentes de subtítulos animados de Claude Shorts** (MIT, Remotion) a `src/engine/`, si en algún momento se decide mejorar la presentación visual de los subtítulos más allá del estilo único actual — baja prioridad, ningún problema actual lo exige.
5. **Zona segura de subtítulo configurable por canal** (versión simple, sin seguimiento de cara, inspirada en Ghost Editor) para `vertical-9-16` — considerar solo si en la práctica se observa que el subtítulo tapa algo importante.

**Descartar integrar código de:**

- **OpenMontage** — licencia AGPL-3.0 incompatible con nuestro uso comercial cerrado desplegado como servicio de red.
- **HyperFrames como motor** — reemplazarlo exigiría reconstruir todo el motor ya construido y probado; su catálogo de componentes queda solo como referencia visual ocasional.
- **Ghost Editor como código** — depende de HyperFrames (no Remotion), de macOS con Apple Silicon, y de Gemini/ElevenLabs; sus ideas (arriba) sí valen, su código no es portable.
- **FFmpeg Skill como dependencia** — exige una build de FFmpeg que no es la que usa Remotion en producción; mantener dos binarios de FFmpeg no se justifica para lo que ganaríamos.
- **El pipeline central de Claude Shorts** (transcripción GPU, scoring, reencuadre) — no resuelve ningún problema que Alex tenga, porque no recorta sus videos largos.

---

## Fuentes

Todo consultado el 31-oct-2026 vía la API de GitHub (`gh api`, lectura, sin clonar ni ejecutar nada):

- [github.com/heygen-com/hyperframes](https://github.com/heygen-com/hyperframes) — README, LICENSE, metadatos del repositorio, contribuidores, commits.
- [github.com/calesthio/OpenMontage](https://github.com/calesthio/OpenMontage) — README, LICENSE, metadatos, contribuidores, commits.
- [github.com/AgriciDaniel/claude-shorts](https://github.com/AgriciDaniel/claude-shorts) — README (estructura del proyecto, componentes de Remotion), LICENSE, metadatos, commits.
- [github.com/kurbaitaev/ghost-editor](https://github.com/kurbaitaev/ghost-editor) — README, `docs/HOW-IT-WORKS.md`, `docs/THIRD_PARTY/README.md`, `docs/THIRD_PARTY/runtime.md`, `docs/THIRD_PARTY/audioqa.md`, `docs/THIRD_PARTY/audio.md`, `docs/THIRD_PARTY/captions.md`, árbol completo de archivos, LICENSE, metadatos, commits.
- [github.com/kajisho5/ffmpeg-skill](https://github.com/kajisho5/ffmpeg-skill) — README completo (requisitos, compatibilidad de FFmpeg, evidencia de evals), LICENSE, metadatos, commits.

**No confirmado independientemente** (señalado explícitamente en el cuerpo del informe, no presentado como hecho): si las cifras de estrellas de HyperFrames y OpenMontage reflejan adopción orgánica; si el requisito de FFmpeg de HyperFrames es la build mínima de Remotion o una completa; la investigación de HyperFrames del 30 de octubre mencionada en el encargo (no se encontró ningún registro de ella en este repositorio ni en el contexto disponible).
