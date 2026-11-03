# A mí no me cuadra — guía editorial

Video de investigación y pensamiento crítico, grabado a cámara. El
presentador habla directo a la audiencia de principio a fin.

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

## Zooms (Ken Burns)

Punch-ins sutiles (escala 1.0 a 1.15–1.25, nunca más agresivo) en remates
de una idea o momentos de énfasis. Son la excepción, no la norma: la
mayoría del video debe quedar sin zoom. Centra el origen donde esté la
cara del presentador en el encuadre (normalmente `{"x": 0.5, "y": 0.35}`
para un plano medio con la cara en el tercio superior).

## Recursos audiovisuales por segmento

Estilo general: sobrio, analítico, dinámico solo cuando el contenido
realmente lo pide. Ningún recurso es obligatorio en ningún segmento. El
presentador sigue siendo el protagonista — pero la cámara no debe
quedarse sola **por inercia** cuando una imagen puede comunicar mejor
una escena concreta. No se trata de "cámara fija salvo excepción" ni de
"un recurso por cada mención": es juzgar, caso por caso, si una
ilustración breve ayuda más de lo que interrumpe. Un recurso se
justifica cuando refuerza una idea o aporta evidencia concreta, nunca
para rellenar o dar sensación de movimiento.

### Cuándo conviene especialmente un recurso visual

Considera un recurso cuando:

1. Alex describe una acción cotidiana reconocible (algo que el
   espectador visualiza de inmediato, no un concepto abstracto).
2. Compara dos comportamientos o situaciones — si la comparación
   necesita mostrar dos escenas distintas, propón dos recursos
   consecutivos, uno por escena, cada uno con su propio
   `visualQuery` concreto (un `visualQuery` describe UNA escena,
   nunca dos a la vez). Si una sola imagen puede representar el
   contraste completo, un solo recurso alcanza — no es obligatorio
   partir en dos.
3. Explica una secuencia que se entiende mejor visualmente que solo
   con palabras.
4. Una imagen refuerza una idea sin interrumpir el razonamiento —
   acompaña la explicación del presentador, no la reemplaza.
5. La ilustración ayuda a variar el ritmo de un segmento que lo
   necesita (por ejemplo, varios minutos seguidos sin ningún recurso
   ni corte de énfasis).

### Criterio de selección: función editorial, no coincidencia de palabras

Cada recurso debe tener una función editorial identificable — alguna de
las anteriores, u otra igual de concreta. **No basta con que una
palabra aparezca en la transcripción.** Una mención incidental (por
ejemplo, Alex nombra un teléfono de pasada, sin que el teléfono sea el
punto) no exige mostrar el objeto.

Ejemplos orientativos (para calibrar el criterio, no reglas fijas):

- "Comer un helado" justifica una ilustración si forma parte de un
  contraste sobre recompensas inmediatas — no si es una mención suelta
  sin peso argumentativo.
- "Scroll infinito" la justifica si el comportamiento es central en lo
  que se está explicando.
- "Salir a caminar" la justifica si es la alternativa concreta que
  Alex propone — no cualquier mención de caminar.

Cuando varias acciones aparecen en pocos segundos, evalúa si conviene
una sola composición que las resuma, una secuencia breve de recursos
cortos, o directamente dejar al presentador — las tres son respuestas
válidas según lo que la escena necesite.

### Sin reglas de reloj

No hay separación mínima obligatoria entre recursos, ni duración
universal, ni un objetivo de "recursos por minuto". La densidad visual
responde al contenido, no al reloj. Si en algún punto de esta guía se
menciona una cifra, es solo una referencia orientativa, nunca una
condición automática que cumplir.

No insertes un recurso de forma automática cada vez que se mencione un
objeto o una acción — esa es la saturación que esta guía busca evitar,
tanto como dejar al presentador solo por inercia es el otro extremo que
busca corregir.

- **Introducción**: prioriza rostro, voz y el gancho inicial. Evita
  saturar con B-roll en los primeros segundos — el presentador es el
  foco. Se permite un recurso puntual si de verdad refuerza el gancho o
  aporta evidencia inmediata (p.ej. un dato o una imagen que respalda la
  afirmación con la que abre).
- **Desarrollo**: aquí es donde más sentido tiene usar recursos —
  B-roll, documentos, datos o gráficos — pero solo cuando aportan
  contexto, contraste o evidencia real a lo que se está argumentando.
  Zooms y resaltados de texto para enfatizar un punto concreto, no como
  decoración. Prioriza continuidad argumentativa: no cortar la idea con
  un recurso que no añade nada.
- **Demostración** (si el presentador muestra algo, cita una fuente,
  compara datos): el recurso debe mostrar exactamente lo que se está
  demostrando — una captura real, un documento real, un gráfico con
  datos reales. Nunca una imagen genérica que solo "ilustra el tema".
- **Transición**: breve, discreta, solo si ayuda a separar dos bloques
  temáticos claramente distintos. No es obligatoria entre cada tema.
- **Cierre**: vuelve al presentador, sin recursos nuevos salvo que el
  remate final lo pida explícitamente (p.ej. un dato que resume todo) o
  el llamado a la acción obligatorio de cierre (ver más abajo, aplica a
  todos los canales).
