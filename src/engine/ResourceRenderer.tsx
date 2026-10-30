import type { Resource } from "../types";
import { CtaOverlay } from "./CtaOverlay";
import { TextHighlightOverlay } from "./TextHighlightOverlay";

/**
 * Despacha un `Resource` al componente que sabe representarlo. Fase 3A
 * solo cubre CTA (cualquier `type` con `ctaPosition`) y `text-highlight`
 * -- `VideoEngine.tsx` ya filtra para que solo esos dos casos lleguen
 * acá; el resto (broll/image/graphic sin CTA/document-reference/etc.)
 * queda pendiente de Fase 3B, registrado en `job.pendingResources` por
 * el servidor, nunca inventado ni omitido en silencio.
 */
export const ResourceRenderer: React.FC<{ resource: Resource }> = ({
  resource,
}) => {
  if (resource.ctaPosition) {
    return <CtaOverlay resource={resource} />;
  }
  if (resource.type === "text-highlight") {
    return <TextHighlightOverlay resource={resource} />;
  }
  return null;
};
