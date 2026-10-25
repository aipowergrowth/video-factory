import { AbsoluteFill } from "remotion";
import type { TextOverlay as TextOverlayType } from "../types";
import { useEngineTheme } from "./theme/ThemeContext";

export const TextOverlay: React.FC<{ overlay: TextOverlayType }> = ({
  overlay,
}) => {
  const theme = useEngineTheme();

  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-end",
        alignItems: "center",
        padding: "0 80px 120px",
        ...overlay.style,
      }}
    >
      <div
        style={{
          fontFamily: "Arial, Helvetica, sans-serif",
          fontSize: 56,
          fontWeight: 700,
          color: "white",
          textAlign: "center",
          textShadow: "0 2px 8px rgba(0,0,0,0.8)",
          backgroundColor: "rgba(0,0,0,0.55)",
          borderLeft: `6px solid ${theme.accentColor}`,
          padding: "16px 32px",
          borderRadius: 16,
        }}
      >
        {overlay.text}
      </div>
    </AbsoluteFill>
  );
};
