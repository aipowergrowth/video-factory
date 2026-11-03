import { remapRangeToOutput } from "./timeline.mjs";

/**
 * Encuentra, en tiempo ORIGINAL, el tramo conservado más cercano a un
 * recurso cuyo intervalo cayó entero dentro de un corte -- lo reubica en
 * el borde de ese tramo más próximo a su posición original, con la
 * misma duración (recortada si el tramo es más chico). Nunca inventa
 * continuidad: solo mueve el recurso a un lugar que SÍ sobrevive.
 * Devuelve null si no queda NINGÚN tramo en todo el video (caso
 * extremo: cortes cubren el video entero).
 */
export const relocateToNearestSurvivingInterval = (timeline, resource) => {
  if (timeline.segments.length === 0) return null;
  const center = (resource.startSeconds + resource.endSeconds) / 2;
  let closest = timeline.segments[0];
  let closestDist = Infinity;
  for (const seg of timeline.segments) {
    const dist =
      center < seg.sourceStart ? seg.sourceStart - center : center > seg.sourceEnd ? center - seg.sourceEnd : 0;
    if (dist < closestDist) {
      closestDist = dist;
      closest = seg;
    }
  }
  const originalDuration = Math.max(0.5, resource.endSeconds - resource.startSeconds);
  const available = closest.sourceEnd - closest.sourceStart;
  const placedDuration = Math.min(originalDuration, available);
  const placeAtStart = center <= closest.sourceStart;
  const newStart = placeAtStart ? closest.sourceStart : closest.sourceEnd - placedDuration;
  return { startSeconds: newStart, endSeconds: newStart + placedDuration };
};

/**
 * Traduce los recursos de un plan (en tiempo ORIGINAL) a la línea
 * temporal FINAL (ya con los cortes aplicados) -- compartida entre el
 * flujo normal (planEditIfNeeded) y POST /jobs/:id/replan, para que
 * ambos traten los CTA obligatorios igual.
 *
 * Un recurso normal que cae entero dentro de un corte se descarta con
 * registro (como siempre). Un recurso marcado `ctaPosition` (uno de los
 * 3 CTA obligatorios) nunca se descarta en silencio: si cae en un
 * corte, se reubica en el tramo conservado más cercano; si no hay
 * NINGÚN tramo posible, queda como error visible en `ctaIssues` -- no
 * desaparece sin aviso. A cada recurso de CTA que sí sobrevive se le
 * agrega `editedSeconds`/`editedPercent` (posición y porcentaje sobre
 * la duración ya editada), para poder verificar inicio/mitad/cierre sin
 * renderizar.
 */
export const remapResourcesWithCtaGuarantee = ({ resources, timeline, log, existingCtaIssues = [] }) => {
  const ctaIssues = [...existingCtaIssues];
  const finalResources = [];
  let droppedCount = 0;

  for (const resource of resources) {
    let ranges = remapRangeToOutput(timeline, {
      startSeconds: resource.startSeconds,
      endSeconds: resource.endSeconds,
    });

    if (ranges.length === 0 && resource.ctaPosition) {
      const relocated = relocateToNearestSurvivingInterval(timeline, resource);
      if (!relocated) {
        ctaIssues.push(
          `CTA obligatorio de "${resource.ctaPosition}" no se pudo ubicar: su posición original (${resource.startSeconds.toFixed(2)}-${resource.endSeconds.toFixed(2)}s) cae en un corte y no queda NINGÚN tramo del video donde reubicarlo.`,
        );
        continue;
      }
      log(
        `CTA de "${resource.ctaPosition}" reubicado: posición original ${resource.startSeconds.toFixed(2)}-${resource.endSeconds.toFixed(2)}s caía en un corte -> reubicado a ${relocated.startSeconds.toFixed(2)}-${relocated.endSeconds.toFixed(2)}s (tramo conservado más cercano).`,
      );
      ranges = remapRangeToOutput(timeline, relocated);
      if (ranges.length === 0) {
        ctaIssues.push(
          `CTA obligatorio de "${resource.ctaPosition}" no se pudo ubicar incluso tras reubicarlo -- revisar manualmente.`,
        );
        continue;
      }
    }

    if (ranges.length === 0) {
      droppedCount += 1;
      log(`recurso descartado (su intervalo completo cayó dentro de un corte): ${resource.description}`);
      continue;
    }

    ranges.forEach((range, index) => {
      const entry = {
        ...resource,
        id: ranges.length > 1 ? `${resource.id}-${index}` : resource.id,
        startSeconds: range.startSeconds,
        endSeconds: range.endSeconds,
      };
      if (resource.ctaPosition) {
        entry.editedSeconds = Number(range.startSeconds.toFixed(2));
        entry.editedPercent =
          timeline.outputDurationInSeconds > 0
            ? Number(((range.startSeconds / timeline.outputDurationInSeconds) * 100).toFixed(1))
            : 0;
      }
      finalResources.push(entry);
    });
  }

  // Corrección del dictamen de cierre de talking-head (30-oct-2026): el
  // CTA de inicio pasó a ser obligatorio siempre (antes dependía de que
  // el presentador lo pidiera verbalmente). Los tres momentos -- start,
  // middle, end -- se verifican ahora con la MISMA lógica, sin crear un
  // sistema aparte para "start". Si ya hay un ctaIssue más específico
  // sobre este mismo CTA (p.ej. la llamada de planMiddleCta falló), no
  // se agrega un segundo mensaje genérico redundante -- el problema ya
  // quedó visible con su causa.
  for (const required of ["start", "middle", "end"]) {
    const alreadyFlagged = ctaIssues.some((issue) => issue.includes(`"${required}"`));
    if (!alreadyFlagged && !finalResources.some((r) => r.ctaPosition === required)) {
      ctaIssues.push(`Falta el CTA obligatorio de "${required}" -- no apareció en el plan en absoluto.`);
    }
  }

  return { resources: finalResources, droppedCount, ctaIssues };
};

/**
 * Qué recursos puede representar visualmente Fase 3A (dictamen de
 * autorización, 30-oct-2026): CTA (cualquier `type` con `ctaPosition`,
 * `displayText` opcional -- si falta, el motor usa la frase fija del
 * canal), `text-highlight` CON `displayText` -- un text-highlight SIN
 * `displayText` no se puede mostrar sin inventar texto, así que no
 * cuenta como renderizable (defecto real corregido: el motor mostraba
 * `description`, que es prosa para el editor, no texto para el video) --
 * y, desde Fase 3B (31-oct-2026): `graphic` con datos estructurados
 * válidos (nunca inventados, ver `isValidGraphicData`) y `broll`/`image`
 * ya resueltos contra un banco externo (`resource.resolvedAsset`
 * presente -- lo pone `server/resource-acquisition.mjs`, nunca este
 * módulo). MISMA regla en el motor Remotion (`src/engine/VideoEngine.tsx`,
 * filtro de `renderableResources`) -- si una cambia, la otra tiene que
 * cambiar igual (mismo patrón que timeline.mjs/timeline.ts).
 */
export const isValidGraphicData = (variant, data) => {
  if (!data || typeof data !== "object") return false;
  if (variant === "chart") {
    return (
      Array.isArray(data.data) &&
      data.data.length > 0 &&
      data.data.every((d) => d && typeof d.label === "string" && typeof d.value === "number" && Number.isFinite(d.value))
    );
  }
  if (variant === "cycle") {
    return Array.isArray(data.steps) && data.steps.length > 0 && data.steps.every((s) => typeof s === "string" && s.trim().length > 0);
  }
  if (variant === "stat") {
    return typeof data.value === "string" && data.value.trim().length > 0 && typeof data.label === "string" && data.label.trim().length > 0;
  }
  return false;
};

export const isRenderableByEngine = (resource) =>
  Boolean(resource.ctaPosition) ||
  (resource.type === "text-highlight" && Boolean(resource.displayText)) ||
  (resource.type === "emoji" && Boolean(resource.emojiChar)) ||
  (resource.type === "graphic" && isValidGraphicData(resource.graphicVariant, resource.graphicData)) ||
  ((resource.type === "broll" || resource.type === "image") && Boolean(resource.resolvedAsset));

/**
 * Separa, de la lista final de recursos, los que el motor todavía no
 * puede renderizar -- quedan identificados como pendientes, nunca
 * inventados ni omitidos en silencio (Decisión 5/6B del dictamen
 * original; extendido por el dictamen de Fase 3B, 31-oct-2026). Motivos
 * posibles: el tipo en sí sigue sin soportarse (document-reference/
 * transition/music/sfx), un `text-highlight` sin `displayText`, un
 * `graphic` sin datos estructurados válidos, o un `broll`/`image` cuya
 * adquisición automática (Pixabay) no encontró un resultado pertinente
 * -- este último trae su propio motivo en `resource.acquisitionFailureReason`,
 * que se usa tal cual en vez del genérico de abajo. Si alguno es
 * `essential`, lo marca aparte en el log: esa entrega no se puede
 * tratar como completa para ese contenido.
 */
export const computePendingResources = (resources, log) => {
  const pending = resources
    .filter((resource) => !isRenderableByEngine(resource))
    .map((resource) => ({
      id: resource.id,
      type: resource.type,
      description: resource.description,
      essential: resource.essential,
      reason:
        resource.acquisitionFailureReason ??
        (resource.type === "text-highlight"
          ? 'recurso "text-highlight" sin "displayText" -- el modelo no definió el texto exacto a mostrar; nunca se usa "description" como reemplazo.'
          : resource.type === "emoji"
            ? 'recurso "emoji" sin "emojiChar" -- el modelo no definió qué emoji mostrar.'
            : resource.type === "graphic"
              ? 'recurso "graphic" sin datos estructurados válidos ("graphicVariant"/"graphicData") -- nunca se inventan cifras o pasos para completarlo.'
              : resource.type === "music" || resource.type === "sfx"
                ? `recurso "${resource.type}" sin fuente de audio con licencia conectada todavía -- Pixabay (ya integrado para broll/image) no tiene una API de audio pública; falta autorizar y conectar un proveedor con licencia verificable (p.ej. Freesound) antes de poder resolver esto. Nunca se inserta sin una licencia clara.`
                : `tipo "${resource.type}" todavía no se puede representar visualmente -- pendiente de adquisición y/o verificación de un recurso real.`),
    }));

  if (pending.length > 0) {
    const essentialCount = pending.filter((r) => r.essential).length;
    log(
      `*** ${pending.length} RECURSO(S) PENDIENTE(S) (no se renderizan todavía) ***` +
        (essentialCount > 0
          ? ` -- ${essentialCount} de ellos ESENCIAL(ES): esta entrega NO se puede tratar como completa para ese contenido.`
          : ""),
    );
    for (const r of pending) {
      log(`  [pendiente${r.essential ? ", ESENCIAL" : ""}] "${r.description}" (tipo ${r.type}): ${r.reason}`);
    }
  }

  return pending;
};
