import type { Resource } from "../types";
import { CtaOverlay } from "./CtaOverlay";
import { TextHighlightOverlay } from "./TextHighlightOverlay";
import { ImageOverlay } from "./ImageOverlay";
import { BRollOverlay } from "./BRollOverlay";
import { KenBurnsImageOverlay } from "./KenBurnsImageOverlay";
import { Chart } from "../graphics/Chart";
import { CycleDiagram } from "../graphics/CycleDiagram";
import { StatCallout } from "../graphics/StatCallout";

/**
 * Despacha un `Resource` al componente que sabe representarlo.
 * `VideoEngine.tsx` ya filtra con `isRenderableByEngine` para que solo
 * lleguen acá los que de verdad se pueden pintar -- el resto queda en
 * `job.pendingResources`, nunca inventado ni omitido en silencio.
 *
 * Fase 3B (31-oct-2026): `broll`/`image` reutilizan los componentes YA
 * existentes para `job.overlays` (`BRollOverlay`/`ImageOverlay`, hasta
 * ahora solo usados con recursos puestos a mano) -- adaptando
 * `resource.resolvedAsset.localPath` a la misma forma `{ src, style }`
 * que esos componentes ya esperan. `graphic` reutiliza los componentes
 * YA existentes de `src/graphics/` (los mismos que usa `OverlayRenderer`
 * para `job.overlays`) -- cero componentes nuevos para ninguno de los
 * dos casos.
 *
 * Modelo combinado (02-nov-2026): el componente se elige por el TIPO
 * DEL ASSET RESUELTO, no ciegamente por `resource.type` -- un `broll`
 * resuelto con una imagen generada (`resolvedAsset.mediaType ===
 * "generated-illustration"`) NUNCA debe ir a `BRollOverlay` (que
 * espera un archivo de VIDEO real vía `OffthreadVideo`); va a
 * `KenBurnsImageOverlay` (imagen fija con movimiento de cámara
 * simulado, decisión cerrada de Alex). Un `image` resuelto con una
 * imagen generada sigue yendo a `ImageOverlay`, igual que cualquier
 * otra imagen -- solo `broll` necesita esta distinción.
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
  if (resource.type === "graphic") {
    switch (resource.graphicVariant) {
      case "chart":
        return <Chart graphic={resource.graphicData as React.ComponentProps<typeof Chart>["graphic"]} />;
      case "cycle":
        return <CycleDiagram graphic={resource.graphicData as React.ComponentProps<typeof CycleDiagram>["graphic"]} />;
      case "stat":
        return <StatCallout graphic={resource.graphicData as React.ComponentProps<typeof StatCallout>["graphic"]} />;
      default:
        return null;
    }
  }
  if (resource.type === "image" && resource.resolvedAsset) {
    return <ImageOverlay overlay={{ id: resource.id, type: "image", startSeconds: 0, durationSeconds: 0, src: resource.resolvedAsset.localPath }} />;
  }
  if (resource.type === "broll" && resource.resolvedAsset) {
    if (resource.resolvedAsset.mediaType === "generated-illustration") {
      return <KenBurnsImageOverlay src={resource.resolvedAsset.localPath} durationInSeconds={resource.endSeconds - resource.startSeconds} />;
    }
    return <BRollOverlay overlay={{ id: resource.id, type: "broll", startSeconds: 0, durationSeconds: 0, src: resource.resolvedAsset.localPath, muted: true }} />;
  }
  return null;
};
