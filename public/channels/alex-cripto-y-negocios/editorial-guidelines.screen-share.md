# Alex Cripto y Negocios — guía editorial (pantalla compartida)

Formato: pantalla compartida con el gráfico de mercado en primer plano y
el presentador en cámara reducida (picture-in-picture). Es el formato de
~90% de los videos de análisis de mercado de este canal. Mismas reglas
base que el resto del canal (voz del presentador siempre presente,
cortes en silencios/muletillas/tomas falsas/autocorrecciones, sin alterar
el sentido de ninguna frase) con estas diferencias específicas de este
formato:

## Nunca tocar datos financieros

No inventes, alteres, redondees ni relaciones con nada (corte, gráfico,
recurso) ninguna cifra, precio, porcentaje, ticker o dato financiero que
el presentador mencione. Si tienes dudas sobre si algo es un dato
financiero, trátalo como si lo fuera: no lo edites, no le pongas énfasis
visual, menciónalo en `notes` en vez de actuar sobre él. NUNCA presentes
una imagen o gráfico generado como si fuera un gráfico financiero real —
en este formato el gráfico ya visible en pantalla es la evidencia, no una
ilustración.

## Recursos: `resources: []` es el resultado por DEFECTO, no una prohibición

El gráfico de mercado que ya está en pantalla es el recurso visual
principal — la gran mayoría de estos videos no necesitan nada más.
`resources: []` es exactamente lo que se espera la mayoría de las veces.
Dos excepciones, ambas reales:

- **Evidencia externa real**: un recurso SOLO si aporta evidencia real y
  verificable que el gráfico en pantalla no muestra (p.ej. una cifra
  macroeconómica externa que el presentador cita pero no está en su
  pantalla). Nunca una captura redundante de un gráfico, cifra o
  documento que ya está visible en el video — eso no aporta nada nuevo.
- **Llamadas a la acción**: si el presentador pide like, suscripción o
  compartir —al inicio, durante el desarrollo o al cierre, donde sea que
  lo diga— es válido proponer un gráfico breve de CTA sincronizado con
  ese momento, igual que en el resto del canal. No lo inventes si no lo
  pide, y que no tape información importante del gráfico o la cámara.

Fuera de estas dos excepciones, nunca B-roll decorativo — no hay
"ambiente" que ilustrar, el contenido ya es visual.

## Sin zoom en este formato

No propongas zooms. El motor no ve el video — no tiene forma de saber
dónde está la cámara reducida ni dónde está el dato relevante del
gráfico en este momento. Un zoom adivinado puede recortar la cámara del
presentador o un indicador del gráfico. Deja el array `zooms` vacío.
