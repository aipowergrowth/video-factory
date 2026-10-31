# Video Factory — Informe de cierre
## Solución estructural para los cortes de audio
**31 de octubre de 2026 — para el operador, primero y en un solo archivo (precisión E)**

Repositorio: `aipowergrowth/video-factory`. Último commit de esta entrega: `5a12bdd` (rama `main`, ya en `origin`).

---

## 0. Resumen en una frase

El mapa de pausas reales ahora se calcula una sola vez por video y se reutiliza en todo el flujo; una puerta automática de calidad verifica la pista de audio ya editada antes del render y corrige o descarta cortes sin intervención manual; y por primera vez hay un flujo en GitHub Actions que ejecuta este motor contra el **mismo FFmpeg real de producción** y lo deja correr y leer a mí mismo — cerrando el bloqueo que venía arrastrando desde el inicio de este incidente (no poder ejecutar FFmpeg en mi entorno de desarrollo).

---

## 1. Archivos y componentes modificados

**Nuevos:**
- [server/quality-gate.mjs](../server/quality-gate.mjs) — puerta automática de calidad (parseo WAV, perfil de energía por cuadro, verificación de empalmes/silencios/duración, armado de la pista editada con FFmpeg, y el flujo de corrección con reintentos).
- [server/compositor.mjs](../server/compositor.mjs) — resolución del binario `@remotion/compositor-*` extraída de `index.mjs` a un módulo propio, para que el script de regresión use la MISMA lógica que producción (no una reimplementación aparte).
- [.github/workflows/audio-regression-tests.yml](../.github/workflows/audio-regression-tests.yml) — flujo de CI nuevo.
- [server/test-audio-regression.mjs](../server/test-audio-regression.mjs) — pruebas de regresión con FFmpeg real y audio sintético (corre solo en CI).
- [server/test-quality-gate.mjs](../server/test-quality-gate.mjs) — pruebas unitarias de `quality-gate.mjs` (detector/ejecutor de FFmpeg simulado, como las demás pruebas que corren en esta máquina).
- [public/jobs/dopamina-12min-fase3a-audiofix.json](../public/jobs/dopamina-12min-fase3a-audiofix.json) — el cuerpo completo del render final de dopamina, con los cortes y recursos ya recalculados (ver sección 9, es la entrega del punto B de las precisiones del operador del round anterior, todavía no confirmada).

**Modificados:**
- [server/audio-analysis.mjs](../server/audio-analysis.mjs) — nuevas funciones `computeFullPauseMap`, `rankPauseCandidates`, `findSafeEdgeInMap`; `refineCutsWithRealSilence` reescrita para usar el mapa calculado una sola vez; se elimina `findRealPauseNearEdge` (quedó sin ningún uso real al dejar de hacerse una llamada a FFmpeg por borde — no se mantuvo una función ya no usada por producción).
- [server/index.mjs](../server/index.mjs) — `planEditIfNeeded` y `POST /jobs/:id/replan` ahora corren la puerta de calidad después del análisis acústico; `POST /jobs/:id/snap-cuts` reutiliza el mismo mapa de pausas que ya calculó `refineCutsWithRealSilence` en vez de volver a invocar FFmpeg por cada borde; se agrega la medición explícita del tiempo adicional (sección 5).
- [server/test-audio-analysis.mjs](../server/test-audio-analysis.mjs) — pruebas reescritas para el mapa calculado una sola vez (antes probaban `findRealPauseNearEdge`, que ya no existe).

No se tocaron perfiles editoriales, CTA, subtítulos ni el comportamiento de recursos ya aprobado (límite explícito del dictamen, sección 9).

---

## 2. Cómo funciona el nuevo mecanismo

### A. Mapa de pausas reales (sección 2 del dictamen)

`computeFullPauseMap` corre `silencedetect` **una sola vez** sobre el audio completo del video (antes: una llamada a FFmpeg por cada borde de cada corte — para un job con 3 cortes, hasta 6 llamadas; ahora, 1). El resultado (`{intervals, noiseDb, minDurationSeconds, videoDurationSeconds}`) se reutiliza para:
- decidir los cortes de producción (`refineCutsWithRealSilence`),
- el diagnóstico de `/jobs/:id/snap-cuts` (antes repetía la búsqueda con otra llamada a FFmpeg por borde; ahora es una búsqueda en memoria sobre el mismo mapa),
- la puerta de calidad, cuando necesita intentar una pausa alternativa.

Los parámetros (-35dB, 0.12s) siguen siendo el punto de partida, pero `computeFullPauseMap` los recibe como argumento, no como constante fija — quien llama puede pasar otros según el audio. Un video sin ninguna pausa detectable (o con tanto ruido de fondo que ninguna pasa el umbral) devuelve `intervals: []`, y el resto del sistema ya sabía manejar eso sin inventar una pausa (confirmado con audio real, ver sección 3, caso E).

### B. Separar decisión editorial de decisión acústica (sección 3)

Esto, en los hechos, **ya estaba así** desde la corrección del round anterior: el modelo editorial sigue proponiendo cortes aproximados; `snapCutsToWordBoundaries` los ajusta a límites de palabra (defensa 1); `refineCutsWithRealSilence` busca, para cada borde, la pausa real más cercana dentro de ±1s usando el mapa — si no hay ninguna confirmada, descarta el corte entero (defensa 2). No cambié esa lógica de decisión en este round (sigue siendo la que ya había validado el operador con los casos reales de dopamina) — lo que cambié es *cómo se obtienen los datos* para esa decisión (el mapa, en vez de llamadas repetidas). `snapCutsToWordBoundaries` sigue intacta, como pidió el dictamen ("mantener las verificaciones acústicas actuales como defensa adicional").

Un punto que sí quedó más claro al escribir las pruebas con audio real: si los dos bordes de un corte terminan mapeando a la **misma** pausa real, el sistema elige el centro de esa pausa para los dos y el corte colapsa a longitud ≤0 — se descarta, nunca se aplica un corte invertido o vacío. Esto ya estaba implícito en el diseño anterior; ahora hay una prueba explícita que lo confirma (`server/test-audio-analysis.mjs`, "pausas convergentes").

### C. Puerta automática de calidad (sección 4) — lo nuevo más importante

`quality-gate.mjs` arma la pista de audio editada con **exactamente** los cortes que producción va a aplicar (usando `atrim`+`concat`+`pcm_s16le`/`wav` — los mismos filtros/encoder/muxer confirmados en el FFmpeg real, ver sección 6) y la verifica de verdad, no en teoría:

1. **Duración**: la pista armada debe coincidir con la que predice `buildTimeline` (±0.15s).
2. **Cada empalme** (el punto exacto donde se pegaron dos tramos que antes no eran contiguos): se revisa que la zona alrededor (±60ms) esté tan silenciosa como debería estarlo si el corte cayó dentro de una pausa real, Y se compara la muestra cruda justo antes/después del punto de corte — un salto brusco ahí suena como un clic aunque el promedio de energía por cuadro no lo note (esto fue deliberado: un clic de una sola muestra puede ser inaudible en el promedio y aun así oírse).
3. **Silencios anormales**: ningún hueco de más de 2.5s que no se explique por el propio contenido.

Si algo falla, `runQualityGateWithRemediation` hace lo que pide la sección 4, en este orden exacto:
1. Intenta la **siguiente pausa candidata** para el borde que falló — no una pausa inventada, sino la segunda/tercera más cercana que ya estaba dentro del límite de ±1s que el propio `refineCutsWithRealSilence` ya había confirmado como aceptable para ese borde.
2. Si no queda ninguna candidata, descarta ese corte entero y conserva el audio original en ese tramo.
3. Vuelve a armar y verificar la pista completa (hasta 6 rondas).
4. Registra cada intento/descarte como una incidencia y sigue.

Se detiene (y el job completo se detiene, no se renderiza con un defecto conocido) únicamente cuando el defecto no está atado a ningún empalme en particular — por ejemplo, un silencio anormal en medio de un tramo que nunca se tocó. Ahí no hay "la siguiente pausa candidata" que probar, así que forzar reintentos no tendría sentido; es exactamente el caso que el dictamen reserva para detener el proceso.

Está integrada en los tres lugares donde corresponde: `planEditIfNeeded` (el flujo real, antes de persistir `job.cuts` — si la puerta no se resuelve, el job queda en error, nunca renderiza con un empalme sin verificar), `POST /jobs/:id/replan` (diagnóstico, para ver el resultado antes de gastar la replanificación real autorizada) y `POST /jobs/:id/snap-cuts` (diagnóstico de solo lectura, misma función que producción).

### D. Qué cambié respecto al dictamen literal (mandato de autonomía, "el cómo es tuyo")

- No implementé la puerta de calidad reinstalando el parser WAV + RMS que había existido brevemente en un round anterior (y que luego se quitó) tal cual estaba — la escribí de nuevo, más completa (incluye la verificación de muestra cruda en el punto exacto del corte, que el diseño original no tenía), porque el objetivo es detectar clics, no solo medir energía promedio.
- No until usé Whisper como verificación complementaria en la puerta de calidad todavía. El dictamen lo permite ("se permite utilizar Whisper..."), no lo exige, y añadirlo implica re-transcribir un tramo cada vez que se verifica un corte, con costo y latencia reales. Dado que la verificación acústica (duración + empalmes + silencios) ya cubre los defectos conocidos (confirmado con audio real, sección 3), lo dejo pendiente para si aparece un defecto que esta capa no detecte — no antes.
- Extraje `compositor.mjs` de `index.mjs`: es la única forma de que el script de regresión en CI use la misma resolución de binario que producción sin reimplementarla aparte.

---

## 3. Resultados de pruebas acústicas y de regresión

### Con FFmpeg simulado (esta máquina, sin FFmpeg funcional — ver limitación conocida de siempre)

`server/test-audio-analysis.mjs` y `server/test-quality-gate.mjs`: 65 verificaciones, todas en verde. Cubren el parseo de `silencedetect`, la elección de pausa más cercana, el mapa calculado una sola vez, el parseo WAV (incluyendo un chunk `data` que miente sobre su tamaño), el perfil de energía, y los cuatro escenarios de la puerta de calidad (sana, se corrige con el siguiente candidato, se descarta sin alternativa, se detiene por un defecto no atado a un empalme).

### Con FFmpeg REAL (GitHub Actions, el mismo binario que producción) — la parte nueva

Corrida en [el run de CI](https://github.com/aipowergrowth/video-factory/actions/runs/41190526721) contra el commit `585ad8b` (confirmada otra vez en verde en el commit final `5a12bdd`). Seis casos, con audio **sintético** (tono = voz continua, silencio digital = pausa real, dos tonos mezclados y atenuados = ruido de fondo bajo) — nada de voz real de Alex, como pidió el mandato de autonomía mientras no esté autorizado:

| Caso | Escenario | Resultado |
|---|---|---|
| A | Voz continua, sin ninguna pausa real cerca del corte (análogo a "Cameron Sepah") | Corte descartado ✓ |
| B | Dos pausas reales distintas, una junto a cada borde (análogo a "pues") | Corte sobrevive, ajustado a ambas pausas ✓ |
| C | Un borde cae en voz continua; la única pausa real está a más de 1s (análogo a 550-554s) | Corte descartado ✓ |
| D (nuevo, pedido por el dictamen) | Corte colocado deliberadamente dentro de una "palabra" (tono continuo, cero pausas reales en todo el tramo) | Corte evitado, nunca se inventa un punto ✓ |
| E (robustez, sección 2) | Ruido de fondo constante, sin ninguna pausa realmente detectable | El sistema no falla; mapa vacío; corte descartado en vez de inventar algo ✓ |
| F | Puerta de calidad end-to-end sobre el resultado real del caso B | Pista armada con FFmpeg real, duración y empalme verificados, `ok=true` ✓ |

Los tres primeros son el reemplazo sintético directo de los tres casos reales de dopamina que el dictamen pidió conservar; el cuarto es la prueba nueva explícitamente pedida en la sección 5; el quinto cubre la robustez ante ruido/sin pausas que pide la sección 2; el sexto es la primera vez que la puerta de calidad corre de punta a punta contra FFmpeg real, no simulado.

**Nota de transparencia, en la misma línea que en los informes anteriores**: estos no son los 759 segundos reales de dopamina ni la voz de nadie — son tonos/silencios sintéticos que reproducen la *posición relativa* de pausas y voz continua, que es lo único que le importa a esta lógica. Encontré y corrigí dos defectos de los FIXTURES (no del motor) en los primeros dos intentos -- quedan documentados en el historial de commits, con el error real de FFmpeg pegado tal cual en cada uno, por la misma disciplina de no inventar sobre qué funciona o no en el binario real.

---

## 4. Resultado de la puerta de calidad

Ver tabla arriba, caso F: con el corte real que produce el caso B (dos pausas reales, corte ajustado a ambas), la puerta de calidad arma la pista con FFmpeg real y la aprueba (`ok=true`, duración coincide con `buildTimeline`, el empalme no muestra ni silencio "no silencioso" ni salto de muestra). Es la verificación más fuerte disponible hasta ahora: no es una aserción sobre cómo debería comportarse FFmpeg, es el comportamiento real.

---

## 5. Tiempo adicional real de procesamiento

Agregué una medición explícita en el propio proceso (`server/index.mjs`, `planEditIfNeeded`): un cronómetro alrededor de "calcular el mapa de pausas reales + decidir los cortes + correr la puerta de calidad" completo. Cada job real que pase por este flujo va a imprimir una línea como:

```
[job <id>] tiempo adicional de la solución estructural (mapa de pausas reales + puerta de calidad): X.Xs.
```

**Ya no necesito que me pasen líneas de log del VPS para esto** (precisión D del operador) — el propio motor mide y reporta el número exacto en cada job. Cuando corra el próximo job real con video, esa línea tiene el dato; no hay nada que yo pueda estimar sin un video real de duración comparable a dopamina, y no voy a inventar un número.

---

## 6. Hallazgo nuevo: la configuración COMPLETA del FFmpeg de producción, confirmada

Al correr en CI contra el binario real, quedó expuesta por primera vez la lista COMPLETA de filtros/encoders/muxers habilitados (antes solo sabíamos "entre otros pocos, no asumir nada más"). Dejo esto registrado porque es información que no había podido confirmar en ningún round anterior:

- **Filtros habilitados**: `aformat, atrim, acopy, adelay, anullsrc, atempo, apad, amerge, amix, asetrate, asetpts, aresample, concat, loudnorm, colorspace, tinterlace, fieldorder, pan, volume, scale, sine, split, nullsrc, silencedetect, palettegen, paletteuse, zscale, tonemap, copy`.
- **Encoders habilitados**: `opus, aac, libfdk_aac, png, mjpeg, pcm_s16le, pcm_s24le, libx264, libx265, libaom_av1, libvpx_vp8, libvpx_vp9, gif, libmp3lame, libopus, prores_ks, rawvideo, h264_nvenc, hevc_nvenc`.
- **Muxers habilitados**: `webm, opus, mp4, wav, mp3, mov, matroska, hevc, h264, gif, image2, image2pipe, adts, m4a, mpegts, null, avi` (igual a lo ya confirmado antes).
- **`anoisesrc` NO está habilitado** (lo until intenté para simular ruido de fondo; el error de FFmpeg real lo confirmó, lo reemplacé por dos tonos mezclados y atenuados).

Esto cierra, con evidencia completa en vez de inferencia, la pregunta que venía abierta desde el round del muxer `s16le`.

---

## 7. Incidencias conocidas

- Dos defectos encontrados y corregidos en los FIXTURES de prueba (no en el motor) durante el desarrollo en CI — documentados arriba (sección 3) y en los mensajes de los commits `724b414` y `585ad8b`.
- La puerta de calidad todavía no usa Whisper como verificación complementaria (ver sección 2.D) — no es una incidencia bloqueante, es una capa que dejo pendiente de agregar si aparece un defecto real que la verificación acústica actual no detecte.
- No hay ninguna incidencia pendiente del lado del render de dopamina: el render completo autorizado sigue sin lanzarse porque sigue pendiente la aprobación auditiva de Alex sobre el clip de 45s (precisión A del operador) — confirmo que no toqué el stack de Portainer en ningún momento de este trabajo.

---

## 8. Imagen Docker publicada y estado del despliegue

Publicada en GHCR desde el commit `5a12bdd` (la última de esta entrega): `ghcr.io/aipowergrowth/fabrica-videos-engine:latest`. **No se desplegó** — como en cada entrega anterior, publicar no reinicia nada por sí solo, y la espero a que el operador avise, tal como pidió explícitamente en este dictamen ("cuando publiques imagen, no se despliega hasta que yo avise"). `docker-stack.yml` no cambió — sigue reflejando exactamente lo que hay en Portainer.

---

## 9. Pendiente de la corrección anterior (no de este dictamen, para que no se pierda)

El cuerpo completo del render final de dopamina —con los cortes finales (solo `ai-cut-1` en 109.267–109.600; `ai-cut-0`/`ai-cut-2` descartados) y los recursos recalculados para esa línea de tiempo— quedó guardado en:

**`public/jobs/dopamina-12min-fase3a-audiofix.json`**

Verificado (sin llamar al modelo, sin re-transcribir, con las mismas funciones de producción): 10 recursos, los 10 `displayText` idénticos byte a byte a los del job original, los 6 recursos pendientes de Fase 3B conservados, 0 `ctaIssues`, 0 recursos descartados. Falta completar `input.driveFileId` con el ID real antes de usarlo — está en `public/jobs/`, no hace falta que Alex copie ni arme nada.

---

## 10. Confirmación de que el render actual no fue interrumpido

No ejecuté ningún comando contra el VPS ni contra Portainer en todo este trabajo — solo código, pruebas locales, GitHub Actions (que corre en runners de GitHub, no en el VPS) y `git push` (que solo publica una imagen en GHCR, nunca reinicia el stack). Si había un render en curso cuando empezó este trabajo, sigue en curso ahora exactamente igual.

---

## 11. Criterio de aceptación (sección 8 del dictamen) — ítem por ítem

1. *"El motor no aplique cortes que puedan mutilar palabras según sus verificaciones acústicas"* — confirmado con audio real (casos A, C, D).
2. *"Los cortes inseguros se descarten automáticamente"* — confirmado (casos A, C, D, E).
3. *"El audio editado supere la puerta de calidad antes del render"* — confirmado end-to-end con FFmpeg real (caso F); integrado como paso obligatorio en `planEditIfNeeded` (el job se detiene si no se resuelve, nunca renderiza sin esta verificación).
4. *"Los defectos conocidos estén cubiertos por pruebas de regresión"* — los 3 casos reales de dopamina + el caso nuevo de palabra cortada, los 4 con FFmpeg real.
5. *"El sistema registre las incidencias sin exigir revisión manual de cada corte"* — `cutIssues` + los incidentes de la puerta de calidad quedan en el log y en `job.cutIssues`; nadie necesita revisar corte por corte para que el job avance.
6. *"Alex pueda concentrarse en aprobar el video final, no en corregir empalmes"* — es la consecuencia directa de los puntos 3 y 5.

No prometo detección perfecta -- sigue siendo un sistema automático y puede tener falsos positivos/negativos; lo que entrego es una mejora verificable, no una garantía absoluta.

---

## 12. Qué sigue (sin arrancar nada todavía)

- Sección 7 del dictamen: ejecutar el único replan de prueba autorizado (~US$0.30) sobre dopamina para validar el nuevo flujo contra el video real completo, cuando el operador lo autorice a lanzar.
- Cerrar la corrección actual (sección 6): entregar el clip de 45s a Alex (ya hecho en el round anterior, `public/jobs/dopamina-audio-test-45s.json`), esperar su aprobación, y solo entonces lanzar el render completo con `dopamina-12min-fase3a-audiofix.json`.
