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

  // "start" depende de que el presentador lo haya pedido verbalmente --
  // no es obligatorio que exista. "middle" y "end" sí lo son siempre.
  // Si ya hay un ctaIssue más específico sobre este mismo CTA (p.ej. la
  // llamada de planMiddleCta falló), no se agrega un segundo mensaje
  // genérico redundante -- el problema ya quedó visible con su causa.
  for (const required of ["middle", "end"]) {
    const alreadyFlagged = ctaIssues.some((issue) => issue.includes(`"${required}"`));
    if (!alreadyFlagged && !finalResources.some((r) => r.ctaPosition === required)) {
      ctaIssues.push(`Falta el CTA obligatorio de "${required}" -- no apareció en el plan en absoluto.`);
    }
  }

  return { resources: finalResources, droppedCount, ctaIssues };
};
