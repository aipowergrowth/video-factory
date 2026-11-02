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
