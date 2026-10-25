import { AbsoluteFill, Img, staticFile } from "remotion";
import type { ImageOverlay as ImageOverlayType } from "../types";

export const ImageOverlay: React.FC<{ overlay: ImageOverlayType }> = ({
  overlay,
}) => {
  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        ...overlay.style,
      }}
    >
      <Img
        src={staticFile(overlay.src)}
        style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
      />
    </AbsoluteFill>
  );
};
