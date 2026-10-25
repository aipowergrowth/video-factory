import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { StatGraphicProps } from "../types";
import { useEngineTheme } from "../engine/theme/ThemeContext";

/**
 * Callout de una cifra/frase corta. Debe alimentarse solo con datos
 * realmente dichos en el video; no inventa estadísticas.
 */
export const StatCallout: React.FC<{ graphic: StatGraphicProps }> = ({
  graphic,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const theme = useEngineTheme();
  const appear = spring({ frame, fps, config: { damping: 200 } });
  const scale = interpolate(appear, [0, 1], [0.85, 1]);
  const opacity = interpolate(appear, [0, 1], [0, 1]);

  return (
    <AbsoluteFill
      style={{ justifyContent: "center", alignItems: "center", padding: 80 }}
    >
      <div
        style={{
          opacity,
          transform: `scale(${scale})`,
          backgroundColor: "rgba(10,10,14,0.78)",
          borderRadius: 28,
          padding: "44px 64px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 12,
        }}
      >
        <div
          style={{
            fontFamily: "Arial, Helvetica, sans-serif",
            fontSize: 88,
            fontWeight: 800,
            color: theme.accentColor,
            lineHeight: 1,
          }}
        >
          {graphic.value}
        </div>
        <div
          style={{
            fontFamily: "Arial, Helvetica, sans-serif",
            fontSize: 30,
            color: "#d8d8dc",
            textAlign: "center",
            maxWidth: 520,
          }}
        >
          {graphic.label}
        </div>
      </div>
    </AbsoluteFill>
  );
};
