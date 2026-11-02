# Video Factory — Informe de cierre
## Relevancia de recursos de Pixabay: Capa A (palabras clave) + Capa B (IA sobre etiquetas) + Capa C (IA sobre la miniatura real)
**01 de noviembre de 2026 — commits `dedd550`, `1a7f96e`, `5d94a25`, `9c03f18`**

---

## Por qué existe esto

La Fase 3B original (31-oct-2026, `fase3b-minima-pixabay-31-oct-2026.md`) resolvía recursos `broll`/`image` contra Pixabay con un filtro de palabras clave puramente léxico (`MIN_KEYWORD_OVERLAP = 1`, un umbral absoluto). El primer job de prueba con datos reales (job `12db9dd4`) mostró que ese umbral era insuficiente: dejaba pasar cualquier candidato con **una sola** coincidencia de palabra, sin importar cuántas palabras significativas tenía la consulta.

## Capa A — palabras clave, sin IA (commit `dedd550`)

Se corrigió el umbral: cobertura relativa de la consulta (≥50% de las palabras significativas) **y** un mínimo absoluto (≥2 coincidencias), los dos a la vez. Se amplió la lista de palabras vacías (incluida "sin", que coincidía con la etiqueta genérica "sin fondo" de Pixabay y causaba falsos positivos). Límite honesto, documentado desde el inicio: un candidato puede cubrir el 100% de las palabras de la consulta y seguir siendo el sujeto equivocado (ver el caso límite del cachorro, abajo) — la Capa A no entiende significado, solo cuenta palabras.

## Capa B — validación con IA sobre texto/etiquetas (commit `dedd550`, corregido en `1a7f96e`)

Sobre los finalistas que sobreviven la Capa A, `claude-haiku-5-5` juzga si el sujeto real corresponde a la consulta usando solo id/tipo/etiquetas — nunca imágenes. Modelo elegido tras confirmar en `claude.com/pricing` que es el Haiku vigente más barato ($0.10/MTok entrada, $0.50/MTok salida), no el supuesto por defecto (Haiku 4.5).

**Caso de prueba que SÍ cumplió su propósito:** un candidato con etiquetas "cachorro, perro, persona, corriendo, amanecer, parque" para la consulta "persona corriendo al amanecer en un parque" — cobertura del 100%, pasa la Capa A sin problema. La Capa B lo rechaza correctamente por el sujeto equivocado. Esto demuestra el límite real de la Capa A y la necesidad de la Capa B.

**Incidente real (job `0e88b0b1`, mismo día):** con 2 finalistas y etiquetas muy repetidas en los datos crudos de Pixabay ("iphone" x4, "oficina" x5), la llamada devolvió texto vacío y un caso positivo real quedó rechazado por el fail-safe en vez de aceptado. Diagnóstico en ese momento: `max_tokens` insuficiente (200→1024) y parseo intolerante a texto vacío. **Esta hipótesis era parcial** — ver la causa raíz completa más abajo. Se agregó `dedupeTagsString()` para que etiquetas duplicadas no inflen el prompt ni el log, y un reintento automático con diagnóstico (stop_reason, tipos de bloque, tokens) ante cualquier fallo técnico.

## Capa C — validación visual con IA sobre la miniatura real (commit `5d94a25`, autorizado por Alex)

**Defecto real que la motivó:** con datos reales, la Capa B aprobó el candidato #2846221 para "laptop sobre un escritorio de oficina moderno" por sus etiquetas ("macbook", "escritorio", "oficina en casa") — pero la foto real mostraba un celular sobre un cuaderno en una mesa rústica. Las etiquetas de un banco pueden describir mal el contenido real; solo ver la imagen lo detecta.

Diseño autorizado: corre **después** de la Capa B, sin reescribir la Capa A ni la Capa B. Evalúa la miniatura real (`webformatURL`, ≤640px — nunca `previewURL`, ≤150px, por la advertencia oficial de Claude sobre precisión bajo 200px) del candidato que la Capa B aprobó; si lo rechaza, prueba en el mismo orden de puntaje de la Capa A los demás finalistas, hasta 3 evaluaciones por recurso. El recurso queda pendiente solo si todas las evaluaciones rechazan o fallan técnicamente.

Dos riesgos verificados antes de codificar la parte de imagen:
- **Hotlinking:** la documentación oficial de la API de Pixabay prohíbe el hotlinking permanente ("si vas a usar las imágenes, descárgalas primero a tu servidor"). Decisión: la miniatura se descarga una sola vez a memoria (nunca a disco) y se manda en base64 — nunca como `source: {type: "url"}` apuntando al CDN de Pixabay.
- **Campo de miniatura de video:** `videos.<tamaño>.thumbnail`, confirmado contra el ejemplo literal de JSON de la documentación oficial de Pixabay. Se agregó un log de diagnóstico de costo cero en `searchPixabay` que imprime las claves reales la primera vez que corre un job con un `broll`, para confirmarlo contra una respuesta real.

## Dos defectos reales con datos reales (job `b7c0c8ac`, commit `9c03f18`)

La primera corrida real de la Capa C (imagen `5d94a25`) llegó a llamar a la API con miniaturas reales y destapó dos defectos técnicos. El fail-safe funcionó en los dos casos (no se insertó nada sin validar), pero el caso positivo seguía sin resolverse con un veredicto válido.

**Defecto 1 — razonamiento extendido encendido por defecto.** Candidato #2846221: `stop_reason="max_tokens"` con bloques de contenido `[thinking, text]`; el texto quedó truncado a mitad de un veredicto que **sí** rechazaba el candidato correctamente (`{"aprobado": false, "motivo": "Aparece una laptop, pero el escritorio es de madera rústica... sin un entor` — cortado ahí). Causa raíz confirmada contra la documentación oficial (`platform.claude.com/docs/en/build-with-claude/thinking`): la API de Mensajes tiene el razonamiento encendido **por defecto**, y `claude-haiku-5-5` sin el parámetro `thinking` usa razonamiento adaptativo automáticamente — eso consumía el presupuesto de salida antes de completar el JSON. Esto explica, de forma más completa, también el incidente de respuesta vacía de la Capa B del mismo día: la hipótesis original (solo `max_tokens` insuficiente) era parcial. Corrección: `thinking: {type: "disabled"}` explícito en las dos llamadas de `resource-acquisition.mjs` (Capa B y Capa C) — `editorial.mjs` ya lo hacía bien desde antes.

**Defecto 2 — tipo de imagen por cabecera, no por contenido real.** Candidato #1868496: HTTP 400 de Anthropic ("the image was specified using the image/jpeg media type, but the image appears to be a image/png image"). El CDN de Pixabay declaró `image/jpeg` en la cabecera para un archivo que en realidad era PNG. Corrección: `detectImageContentTypeFromBytes()` determina el tipo real por la firma de bytes del archivo descargado (JPEG/PNG/GIF/WebP) — nunca por la cabecera HTTP ni por la extensión de la URL. Sin firma reconocida, el candidato queda rechazado con ese motivo técnico y cascadea al siguiente finalista.

Un JSON truncado que "alcanza a decir" `aprobado:false` (defecto 1) sigue tratándose como fallo técnico, nunca como un veredicto real respetado — el parseo tolerante existente ya lo garantizaba (`JSON.parse` falla sobre texto incompleto); se agregaron pruebas que reproducen la forma exacta de ambos incidentes para confirmarlo explícitamente.

## Costo real medido

- Corrida real del job `b7c0c8ac` (previa al arreglo de causa raíz, con los dos defectos activos): ≈ US$0.0005 en total.
- Los 3 rechazos de Capa A (dopamina, "xyzzy...", y el caso del cachorro en Capa B) llegan sin gastar ninguna llamada de Capa C — el costo solo se incurre sobre candidatos que ya pasaron A y B.

## Probado (nivel 2 — datos simulados, verifica cableado, no es el criterio de aceptación)

`server/test-resource-acquisition.mjs` cubre: los 3 casos reales reportados por Alex, el caso límite del cachorro, el incidente de respuesta vacía de la Capa B (reproducido con un cliente de Anthropic falso con la forma exacta del incidente), la cascada de la Capa C entre finalistas, el rechazo de los 3 finalistas disponibles, fallos técnicos que cascadean igual que un rechazo semántico, video sin miniatura utilizable, que la miniatura nunca se manda por URL, y los dos defectos del job `b7c0c8ac` reproducidos en su forma exacta (bloques `[thinking, text]` + `stop_reason=max_tokens`; PNG servido con cabecera `image/jpeg`). `tsc`/`eslint`/el resto de la suite: sin regresiones.

## Pendiente de validar (nivel 3 — corrida real)

Alex debe repetir `public/jobs/dopamina-fase3b-prueba-pixabay.json` una vez más tras el commit `9c03f18` para confirmar, con datos reales: que #2846221 recibe ahora un veredicto **completo** (sin truncarse) de la Capa C, que #1868496 se procesa sin el error 400, y que el resultado final (aceptado o pendiente) tiene un motivo honesto. Costo esperado: menos de un centavo.

---

## Capítulo 2 — plan real de dopamina: 0 de 3 recursos resueltos (job `e707ade8`)

Alex ejecutó el plan real `planOnly` del video de dopamina (imagen `9c03f18`). Confirmó por fin, con datos reales, el campo de miniatura de video (`videos.<tamaño>.thumbnail` presente con `url/width/height/size/thumbnail`) — queda cerrado ese riesgo. Pero de los 3 recursos que fueron a Pixabay (1 imagen, 2 broll), los 3 se **rechazaron en la Capa A** — las capas B y C nunca llegaron a evaluarse:

| Consulta real | Mejor score | Cobertura | Umbral exigido |
|---|---|---|---|
| "ilustración científica de neuronas transmitiendo señales con neurotransmisores" (imagen) | 0/6 | 0% | ≥2 y ≥50% |
| "cazadores prehistóricos persiguiendo presa en la naturaleza" (broll) | 2/5 | 40% | ≥2 y ≥50% |
| "persona comprando carne en supermercado moderno" (broll) | 1/5 | 20% | ≥2 y ≥50% |

El log no mostraba las etiquetas de los candidatos rechazados — sin esa evidencia no se podía saber si los 3 rechazos eran correctos o si la Capa A descartó algo útil. Hipótesis del operador (no verificadas en ese momento, sin datos de etiquetas): consultas demasiado largas para la búsqueda de Pixabay, falta de normalización de singular/plural y formas verbales, y un umbral de cobertura quizás demasiado estricto como filtro previo a capas B/C ya robustas.

### Diagnóstico y corrección (commit pendiente de hash final de esta entrega)

**No se pudo obtener la evidencia real de etiquetas sin un nuevo arreglo primero** — se agregó el log que faltaba (`Pixabay: diagnóstico de los candidatos mejor puntuados (capa A)...`, siempre activo, sin costo de IA, imprime etiquetas + score + cobertura + qué palabras coincidieron de los 3 mejores candidatos cuando la Capa A rechaza todo). Esto es lo que debe confirmar la próxima corrida real.

Mientras tanto, dos correcciones justificadas independientemente de los datos de etiquetas (no se tocó ningún umbral):

1. **`buildPixabaySearchTerms()`**: la consulta que de verdad se le manda a Pixabay (parámetro `q`) se acota a las primeras 5 palabras significativas de la descripción del planificador — nunca la consulta usada para puntuar en la Capa A, ni la que validan la Capa B/Capa C, que siguen viendo la descripción completa. Justificación: es una propiedad conocida de los motores de búsqueda por palabras clave (frases largas en lenguaje natural devuelven peores resultados que pocas palabras concretas), no depende de ver las etiquetas reales para ser una mejora razonable. Si 5 resulta ser mucho o poco, es una sola constante para ajustar.
2. **Normalización de singular/plural** (`pluralVariants()`): `matchedTokens`/`scoreKeywordOverlap` ahora consideran "neuronas"≡"neurona", "cazadores"≡"cazador", etc. (dos reglas: quitar "es" final o quitar "s" final, con un piso de longitud para no tocar palabras cortas). **Deliberadamente NO cubre formas verbales** (gerundios como "persiguiendo"/"comprando" hacia su infinitivo) — no hay una regla simple y confiable en español para eso (raíces irregulares, conjugaciones -ar/-er/-ir); se prefirió dejarlo sin cubrir en la Capa A antes que inventar una regla sin verificar. La Capa B/C, con el significado completo, puede igual reconocer un candidato que llegue a ser finalista por otras palabras.

**Umbrales de la Capa A sin cambios** (`MIN_ABSOLUTE_OVERLAP=2`, `MIN_COVERAGE_RATIO=0.5`). Límite honesto detectado durante el diseño de esta corrección: para una consulta de 6 palabras significativas (como la de neuronas), incluso con normalización perfecta, alcanzar 50% de cobertura exige que al menos 3 de esas 6 palabras específicas aparezcan en las etiquetas del candidato — eso puede seguir siendo difícil para frases narrativas/científicas compuestas, independientemente de singular/plural. Si la corrida real muestra que la normalización + la consulta acotada no alcanzan para esos casos, la siguiente escalación (ajustar el umbral o el rol de la Capa A) es una decisión de Alex, no algo que se cambie en esta entrega.

### Probado (nivel 2 — datos simulados)

Pruebas nuevas en `test-resource-acquisition.mjs`: `pluralVariants`/`buildPixabaySearchTerms` como funciones puras; que la consulta acotada es lo que de verdad llega a la URL de Pixabay (capturada en la llamada real, no solo en la función); un caso ilustrativo donde la normalización es la diferencia exacta entre 0% (rechazado) y 75% (aceptado); confirmación de que un candidato sin ninguna coincidencia real sigue rechazado (la corrección no inventa relevancia); y que el nuevo log de diagnóstico muestra etiquetas reales en un rechazo de Capa A. Toda la batería anterior (los 3 casos reales originales, el caso límite del cachorro, las dos capas de reintento/diagnóstico de B y C, los defectos 1 y 2) se volvió a correr completa sin que se repitiera manualmente caso por caso — sigue en verde.

### Pendiente de validar (nivel 3 — corrida real)

La prueba real con las 3 consultas de este job (vía `skipEditorialAI`, sin repetir la llamada editorial) es el único nivel que puede confirmar o descartar las hipótesis. Qué esperar en el log: por cada uno de los 3 recursos, una línea de diagnóstico con las etiquetas reales de los 2-3 mejores candidatos (nueva); la consulta acotada que de verdad se buscó junto a la descripción completa; si alguno ahora pasa la Capa A, las líneas de Capa B/Capa C con su veredicto y costo real. Costo real esperado de B+C por video: basado en lo medido en la corrida real anterior (`b7c0c8ac`, ≈US$0.0005 en total para varios recursos) y en que como máximo 3 recursos de este job pueden llegar a Pixabay, el techo realista sigue estando muy por debajo de un centavo por video, incluso si ahora más recursos alcanzan la Capa B/C que antes.
