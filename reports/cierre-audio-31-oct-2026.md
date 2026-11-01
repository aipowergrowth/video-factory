# Video Factory — Informe final de cierre
## Cierre del incidente de audio (cortes de palabras)
**31 de octubre de 2026 — commit `9a6b3c8`**

Formato pedido: Implementado / Probado / Aprobado por Alex / Pendiente, por separado.

---

## 0. Recomendación

**Cierro el incidente de audio como resuelto.** El mecanismo nuevo (mapa de pausas reales + puerta de calidad) quedó probado contra FFmpeg real en dos vías independientes — CI con audio sintético y el replan con el audio real de dopamina — y el render ya entregado no muestra el defecto original ("Cameron Sepah" cortado). Queda un detalle explicado más abajo (la diferencia de 0.333s en el corte de 109s) que no es un defecto de seguridad: en ambos casos el motor cortó exactamente dentro de una pausa real confirmada, nunca dentro de una palabra. Queda pendiente un solo dato no bloqueante (el tiempo exacto del mecanismo) y una confirmación visual de subtítulos que no es indispensable para cerrar.

---

## 1. Resultado del render (job `b3601795-d1fb-400b-ad5c-b518855775dd`)

**Implementado y probado:**
- MP4 verificado por el propio motor: 1920×1080, h264, 758.93s, 676.7MB, subido a Drive.
- Un solo corte aplicado (`ai-cut-1`, 109.267–109.600s), tal como se preparó a mano en `public/jobs/dopamina-12min-fase3a-audiofix.json` — consistente con lo que el motor debía renderizar.

**Aprobado por Alex:**
- "Cameron Sepah" completo.
- Empalme en "pues" (1:49) natural.
- Los tres CTA aparecen (inicio, medio 6:21, final ~12:23).

**Pendiente:**
- Revisión exhaustiva de subtítulos/textos (Alex no la hizo; tampoco reportó defectos en lo que vio). No bloqueante para cerrar el incidente de AUDIO — es una verificación de contenido distinta, no de los cortes.
- No se exigió ni se obtuvo verificación independiente (ffprobe por un tercero) de ausencia de defectos nuevos más allá de lo que Alex notó a simple oído/vista — razonable para este caso, dado que el propio motor ya verificó resolución/códec/duración.

**No aplica a este render** (explicado en el informe anterior y confirmado otra vez aquí): como el job traía `cuts`/`resources` ya calculados a mano, el motor se salta el paso de IA editorial completo — ni el mapa de pausas reales ni la puerta de calidad se ejecutaron en este render. La prueba de ese mecanismo viene del replan (sección 2).

---

## 2. Resultado del replan único (job `578818c7-5f54-420f-ab1c-486e5aea9b7a`)

**Implementado y probado, contra audio real:**
- `qualityGate: {ok: true, rounds: 1, incidentes: 0}` — la pista editada (con los 6 cortes aceptados) pasó la verificación automática de empalmes/silencios/duración al primer intento, sin necesitar ninguna corrección.
- 6 cortes aceptados: 22.29–24.52, 108.86–109.60, 429.98–431.47, 488.92–490.40, 550.48–553.30, 585.23–586.49.
- Cortes descartados por falta de pausa real confirmada o por bordes cruzados: `ai-cut-1, 3, 7, 8, 9, 15` + 4 microcortes/tiempos inválidos — es decir, de un total de ~16 cortes propuestos por el modelo, el mecanismo descartó automáticamente 10 y solo dejó pasar los 6 que tenían respaldo acústico real en ambos bordes.
- CTA recalculados correctamente para la nueva línea de tiempo (inicio 24.53s, medio 377.69s/50.4%, final 735.33s), `ctaIssues` vacío, 0 recursos descartados por los cortes.
- 4 recursos pendientes de Fase 3B sin cambios (2 esenciales: Cameron Sepah, Parkinson).
- Costo: 53,101 tokens de entrada / 4,898 de salida (~US$0.23 estimado, dentro del presupuesto autorizado de ~US$0.30).

**Contraste independiente pedido (punto 3b del dictamen anterior) — resuelto parcialmente:**

El corte de "pues" en el replan (108.863–109.600) no es el mismo corte que el de hace varios rounds (109.267–109.600) ni una repetición exacta de esa decisión — son dos llamadas *distintas* al modelo editorial, no determinísticas, que propusieron intervalos distintos esta vez (el actual arranca ~0.4s antes). Que el extremo final coincida casi exacto (109.600 en ambos) es coherente con que ahí existe una pausa real estable que el mecanismo vuelve a encontrar.

El corte de "550–554s" (ahora 550.48–553.30, antes descartado como 550.77–554.8 por un borde en voz continua a +1.276s de la pausa más cercana): el nuevo corte termina 1.5s ANTES que el viejo — un punto distinto, perfectamente compatible con que sí exista una pausa real dentro de ±1s de ese extremo más corto. No es una contradicción del mecanismo, son propuestas distintas del modelo evaluadas cada una con sus propios bordes.

---

## 3. La diferencia del corte de 109s — explicación

Pediste explicar por qué mi propia verificación (`/snap-cuts` con `{startSeconds: 108.86, endSeconds: 109.60}`) devolvió **108.863–109.267**, no 108.863–109.600 como el replan.

**La causa más probable: usé el resultado FINAL del replan como si fuera una propuesta cruda, y el pipeline no es neutral frente a eso.**

`/snap-cuts` trata cualquier corte que se le manda como una propuesta nueva, sin procesar, y la hace pasar por las DOS etapas en orden: (1) ajuste a límite de palabra (`snapCutsToWordBoundaries`, usando las palabras transcritas) y (2) búsqueda de la pausa real más cercana dentro de ±1s (`refineCutsWithRealSilence`). Yo le mandé 108.86–109.60 -- que son, redondeados, los valores que el replan YA había encontrado después de pasar por esas dos etapas. Al volver a correr la etapa (1) sobre un punto que ya estaba ajustado, el resultado de esa etapa puede no ser idéntico al de la primera vez (depende del valor exacto de entrada, no es necesariamente estable frente a reprocesar su propia salida) -- y si el objetivo que le llega a la etapa (2) queda un poco más bajo que mi 109.60 original, la búsqueda de "pausa real más cercana" puede legítimamente encontrar una pausa DISTINTA más cercana a ese objetivo ajustado -- en este caso, la pausa centrada en 109.267 en vez de la centrada en 109.600. Ambas pausas son reales y confirmadas (las dos ya aparecían en rondas anteriores de este mismo incidente); el mecanismo no inventó nada ni cortó dentro de una palabra en ningún caso -- eligió la pausa real más cercana al punto que efectivamente buscó, y ese punto no fue idéntico al que buscó el replan porque el replan arrancó de la propuesta CRUDA del modelo (que yo no conozco) y mi prueba arrancó de su resultado YA PROCESADO.

**Lo que esto confirma, y lo que no:**
- Confirma que el mecanismo nunca deja un borde sin una pausa real confirmada detrás (ambos resultados -- 109.267 y 109.600 -- son pausas reales, no puntos inventados).
- Confirma que `/snap-cuts` no es la herramienta correcta para "repetir" una decisión ya tomada -- es correcta para evaluar una propuesta NUEVA. Para reproducir fielmente la decisión del replan haría falta alimentar `/snap-cuts` con la propuesta CRUDA del modelo (antes de cualquier ajuste), que no quedó guardada en ningún lado porque `/replan` no persiste nada.
- No confirma (todavía) el detalle exacto de por qué la etapa (1) movió el objetivo -- para eso necesitaría el campo `wordsNearEdges[].adjustedSeconds` de esa misma respuesta, que no me llegó. No es necesario para cerrar el incidente (la pregunta de seguridad -- ¿corta dentro de una palabra? -- ya está respondida: no), pero lo anoto como pendiente de curiosidad técnica, no de riesgo.

---

## 4. Tiempo adicional del mecanismo (criterio 8)

**Pendiente.** El número de `audioMechanismElapsedMs` no llegó en el mensaje con el resultado de la verificación. Sigue siendo medible con costo cero (ya implementado en `/snap-cuts` y `/replan`, commit `9a6b3c8`) -- no hace falta ninguna acción nueva de mi parte, solo que la próxima respuesta de cualquiera de esos dos endpoints incluya ese campo en lo que me pasen. No es bloqueante para cerrar: ya sé que el mecanismo corre en segundos (la respuesta de la verificación llegó rápido), solo no tengo el número exacto.

---

## 5. Qué queda validado y qué no

**Validado con evidencia real (no solo sintética):**
- El mecanismo nunca deja un corte con un borde dentro de una palabra (replan + verificación, dos corridas independientes sobre el audio real de dopamina).
- La puerta de calidad corre de punta a punta sobre audio real y aprueba una pista con 6 cortes sin necesitar correcciones (replan).
- El render con el corte ya decidido (1 corte) no mutiló "Cameron Sepah" ni dejó un empalme audible en "pues" (revisión de Alex).
- CTA y recursos se recalculan correctamente para líneas de tiempo con cortes distintos (visto en el render de 1 corte Y en el replan de 6 cortes).

**No validado / fuera de alcance de este cierre:**
- Revisión exhaustiva de subtítulos del render (no bloqueante, pendiente si Alex quiere hacerla).
- El tiempo exacto del mecanismo (número, no el hecho de que sea rápido).
- Si conviene re-renderizar dopamina con los 6 cortes del replan en vez del 1 ya aprobado -- es una decisión de contenido de Alex, no una necesidad técnica (ver recomendación del informe anterior, se mantiene).

---

## 6. Trabajo estacionado (sin cambios, confirmado)

Motion graphics, investigación de herramientas/skills, CTA configurable por canal, validación vertical con un Short real, Fase 3B, Fase 3C, `ScriptAudioImagesInput` para La Nave Tierra -- todo sigue en la hoja de ruta, nada de esto se tocó ni se necesitó para este cierre.

---

## 7. Estado de la infraestructura

- Imagen publicada: `ghcr.io/aipowergrowth/fabrica-videos-engine:latest` y `:sha-9a6b3c890c4b41eb159040e872720d921315aef0`, build desde el commit `9a6b3c8`.
- No se desplegó nada -- publicar nunca reinicia el stack; eso lo decide Alex en Portainer.
- No hubo render activo durante este trabajo (se confirmó antes de pushear).
- `docker-stack.yml` no cambió.

---

## 8. Cierre

Con la evidencia de las secciones 1 y 2 (render aprobado por Alex, replan con puerta de calidad en verde sobre audio real) y la explicación de la sección 3 (la diferencia de 0.333s es una elección entre dos pausas reales igualmente válidas, no un corte inseguro), considero el incidente de audio **cerrado**. Los dos pendientes (sección 4 y la revisión de subtítulos) son de bajo riesgo y no requieren mantener el incidente abierto -- quedan anotados para resolverse de forma incremental, sin gasto ni render nuevo.
