import { AbsoluteFill, OffthreadVideo, staticFile } from "remotion";
import type { BRollOverlay as BRollOverlayType } from "../types";

export const BRollOverlay: React.FC<{ overlay: BRollOverlayType }> = ({
  overlay,
}) => {
  return (
    <AbsoluteFill style={overlay.style}>
      <OffthreadVideo
        src={staticFile(overlay.src)}
        muted={overlay.muted ?? true}
        volume={overlay.volume}
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />
    </AbsoluteFill>
  );
};
