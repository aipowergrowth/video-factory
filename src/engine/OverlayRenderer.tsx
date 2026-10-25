import type { Overlay } from "../types";
import { ImageOverlay } from "./ImageOverlay";
import { BRollOverlay } from "./BRollOverlay";
import { TextOverlay } from "./TextOverlay";
import { Chart } from "../graphics/Chart";
import { CycleDiagram } from "../graphics/CycleDiagram";
import { StatCallout } from "../graphics/StatCallout";

export const OverlayRenderer: React.FC<{ overlay: Overlay }> = ({
  overlay,
}) => {
  switch (overlay.type) {
    case "image":
      return <ImageOverlay overlay={overlay} />;
    case "broll":
      return <BRollOverlay overlay={overlay} />;
    case "text":
      return <TextOverlay overlay={overlay} />;
    case "graphic":
      switch (overlay.graphic) {
        case "chart":
          return <Chart graphic={overlay.props} />;
        case "cycle":
          return <CycleDiagram graphic={overlay.props} />;
        case "stat":
          return <StatCallout graphic={overlay.props} />;
        default:
          return null;
      }
    default:
      return null;
  }
};
