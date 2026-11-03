# Alex Cripto y Negocios — guía editorial (hablando a cámara)

Video de análisis de cripto/finanzas grabado a cámara: YouTube 16:9 (p.ej.
explicar el hackeo de Binance) y verticales 9:16 (TikTok/Instagram/Short
del canal). El presentador habla directo a la audiencia de principio a
fin. Formato distinto de la pantalla compartida (ver
`editorial-guidelines.screen-share.md`, que aplica solo con
`job.layout = "screen-share"`) — acá no hay gráfico de mercado en pantalla,
así que el criterio de B-roll/zooms/cortes es el mismo que en "A mí no me
cuadra", con una única regla adicional que pesa más que cualquier otra.

## Nunca tocar datos financieros

No inventes, alteres, redondees ni relaciones con nada (zoom, corte,
gráfico, recurso) ninguna cifra, precio, porcentaje, ticker o dato
financiero que el presentador mencione. Si tienes dudas sobre si algo es
un dato financiero, trátalo como si lo fuera: no lo edites, no le pongas
énfasis visual, menciónalo en `notes` en vez de actuar sobre él.

Esto aplica también a recursos: NUNCA presentes una imagen o gráfico
generado como si fuera un gráfico financiero real. Un gráfico real (una
captura auténtica de precio, un documento real) sí se puede usar como
evidencia; una ilustración genérica o generada por IA no debe presentarse
cerca de una cifra real, porque confunde ilustración con evidencia
documental. Esta regla NO prohíbe ilustrar conceptos — ver "Recursos
audiovisuales por segmento" más abajo para la distinción exacta entre
concepto (sí se ilustra) y dato (nunca se ilustra con algo que no sea
real).

## Qué preservar

- El rostro y la voz del presentador deben estar presentes mientras habla.
  No lo reemplaces ni lo tapes de forma permanente con nada.
- No alteres ni reinterpretes lo que dice. Un corte puede acortar el video,
  pero nunca debe cambiar el sentido de una frase ni sacarla de contexto.

## Cortes

Elimina:
- Silencios largos y muletillas ("eh", "este", repeticiones de la misma
  palabra sin aportar nada).
- Tomas falsas: si el presentador se equivoca y se corrige a sí mismo,
  quédate con la versión corregida y corta la fallida completa.
- Titubeos o pausas largas que rompen el ritmo sin aportar énfasis.

No cortes:
- Pausas breves que son parte natural del ritmo de habla.
- Nada que cambie lo que el presentador quiso decir.
- Ninguna cifra, precio o dato financiero junto con su contexto —
  preferible conservar de más alrededor de un dato antes que arriesgar
  sacarlo de contexto (ver "Nunca tocar datos financieros").

## Zooms (Ken Burns)

Punch-ins sutiles (escala 1.0 a 1.15–1.25, nunca más agresivo) en remates
de una idea o momentos de énfasis. Son la excepción, no la norma: la
mayoría del video debe quedar sin zoom. Centra el origen donde esté la
cara del presentador en el encuadre (normalmente `{"x": 0.5, "y": 0.35}`
para un plano medio con la cara en el tercio superior). Nunca un zoom
cuyo único propósito sea enfatizar una cifra o dato financiero —el énfasis
visual sobre un dato está prohibido por la regla de arriba, sin excepción.

## Recursos audiovisuales por segmento

Estilo general: sobrio, analítico, dinámico solo cuando el contenido
realmente lo pide. Ningún recurso es obligatorio en ningún segmento. El
presentador sigue siendo el protagonista — pero la cámara no debe
quedarse sola **por inercia** cuando una imagen puede comunicar mejor una
escena concreta. No se trata de "cámara fija salvo excepción" ni de "un
recurso por cada mención": es juzgar, caso por caso, si una ilustración
breve ayuda más de lo que interrumpe.

**Distinción central de este canal — concepto vs. dato:**
- **Concepto** (una acción, un fenómeno, una idea general): se puede
  ilustrar igual que en cualquier otro canal a cámara. Ilustrar "hackeo",
  "seguridad", "exchange", "wallet", "regulación" o una acción cotidiana
  que Alex describe es válido — el espectador la visualiza de inmediato y
  una imagen genérica o generada apropiadamente la representa bien.
- **Dato** (una cifra, precio, porcentaje, ticker, o cualquier cosa que
  funcione como evidencia de un hecho financiero concreto): la evidencia
  visual tiene que ser real (una captura auténtica de precio, un
  documento real) o quedar pendiente con motivo — nunca una ilustración
  genérica ni un gráfico generado por IA puestos cerca de la cifra, porque
  eso simula evidencia que no es real. Resolver capturas/gráficos
  auténticos de verdad es la Fase 3C del motor, todavía no implementada:
  mientras no exista, el recurso queda pendiente, no se sustituye con
  stock ni con IA.

Un recurso conceptual se justifica cuando refuerza una idea sin
interrumpir el razonamiento, nunca para rellenar o dar sensación de
movimiento. Un recurso de dato se justifica únicamente si es real.

### Cuándo conviene especialmente un recurso conceptual

Considera un recurso cuando:

1. Alex describe una acción o fenómeno cotidiano reconocible (algo que el
   espectador visualiza de inmediato, no un concepto abstracto) — p.ej. un
   hackeo, un exchange cayendo, alguien revisando su teléfono.
2. Compara dos comportamientos o situaciones — si la comparación necesita
   mostrar dos escenas distintas, propón dos recursos consecutivos, uno
   por escena, cada uno con su propio `visualQuery` concreto (un
   `visualQuery` describe UNA escena, nunca dos a la vez). Si una sola
   imagen puede representar el contraste completo, un solo recurso
   alcanza — no es obligatorio partir en dos.
3. Explica una secuencia que se entiende mejor visualmente que solo con
   palabras.
4. Una imagen refuerza una idea sin interrumpir el razonamiento — acompaña
   la explicación del presentador, no la reemplaza.
5. La ilustración ayuda a variar el ritmo de un segmento que lo necesita
   (por ejemplo, varios minutos seguidos sin ningún recurso ni corte de
   énfasis).

Ninguno de estos casos aplica cuando lo que se quiere representar es, en
realidad, un dato financiero (ver la distinción de arriba) — ahí manda la
regla de nunca tocar datos financieros, no esta lista.

### Criterio de selección: función editorial, no coincidencia de palabras

Cada recurso debe tener una función editorial identificable — alguna de
las anteriores, u otra igual de concreta. **No basta con que una palabra
aparezca en la transcripción.** Una mención incidental (por ejemplo, Alex
nombra un exchange de pasada, sin que sea el punto) no exige mostrar nada,
y nombrar una cifra nunca exige mostrar un gráfico que no sea real.

### Sin reglas de reloj

No hay separación mínima obligatoria entre recursos, ni duración
universal, ni un objetivo de "recursos por minuto". La densidad visual
responde al contenido, no al reloj. No insertes un recurso de forma
automática cada vez que se mencione un concepto o una acción — esa es la
saturación que esta guía busca evitar, tanto como dejar al presentador
solo por inercia es el otro extremo que busca corregir.

- **Introducción**: prioriza rostro, voz y el gancho inicial. Evita
  saturar con B-roll en los primeros segundos — el presentador es el
  foco. Se permite un recurso conceptual puntual si de verdad refuerza el
  gancho (p.ej. ilustrar el fenómeno del que trata el video). Si el
  gancho es un dato concreto (p.ej. "el precio cayó 40%"), ese dato sigue
  la regla de nunca tocar datos financieros: ilustrarlo requiere evidencia
  real, no una ilustración genérica.
- **Desarrollo**: aquí es donde más sentido tiene usar recursos
  conceptuales — B-roll que ilustra fenómenos, comparaciones, secuencias
  — pero solo cuando aportan contexto o refuerzan el argumento sin
  interrumpirlo. Cualquier gráfico, captura o documento que funcione como
  evidencia de un dato financiero debe ser real o quedar pendiente.
  Prioriza continuidad argumentativa: no cortar la idea con un recurso que
  no añade nada.
- **Demostración** (si el presentador muestra algo, cita una fuente,
  compara datos): el recurso debe mostrar exactamente lo que se está
  demostrando — una captura real, un documento real, un gráfico con datos
  reales. Nunca una imagen genérica que solo "ilustra el tema" cuando lo
  que se demuestra es un dato.
- **Transición**: breve, discreta, solo si ayuda a separar dos bloques
  temáticos claramente distintos (p.ej. pasar de un activo a otro). No es
  obligatoria entre cada tema.
- **Cierre**: vuelve al presentador, sin recursos nuevos salvo que el
  remate final lo pida explícitamente (p.ej. ilustrar un concepto de
  cierre, nunca un dato sin evidencia real) o el llamado a la acción
  obligatorio de cierre (ver más abajo, aplica a todos los canales).
