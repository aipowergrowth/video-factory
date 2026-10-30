import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { Resource } from "../types";
import { useEngineTheme } from "./theme/ThemeContext";

/**
 * Llamado a la acción (uno de los 3 obligatorios: inicio/mitad/cierre).
 * Discreto a propósito -- pastilla chica arriba a la derecha, nunca abajo
 * (ahí viven los subtítulos, nunca hay que taparlos) ni en el centro
 * (ahí suele estar el rostro del presentador o, en pantalla compartida,
 * el gráfico). El texto es exactamente `resource.description` -- nunca se
 * inventa ni se completa nada que el plan editorial no haya puesto ahí.
 */
export const CtaOverlay: React.FC<{ resource: Resource }> = ({ resource }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const theme = useEngineTheme();
  const appear = spring({ frame, fps, config: { damping: 200 } });
  const scale = interpolate(appear, [0, 1], [0.9, 1]);
  const opacity = interpolate(appear, [0, 1], [0, 1]);

  return (
    <AbsoluteFill
      style={{ justifyContent: "flex-start", alignItems: "flex-end", padding: "40px 48px" }}
    >
      <div
        style={{
          opacity,
          transform: `scale(${scale})`,
          display: "flex",
          alignItems: "center",
          gap: 12,
          backgroundColor: "rgba(10,10,14,0.80)",
          border: `2px solid ${theme.accentColor}`,
          borderRadius: 999,
          padding: "14px 26px",
          maxWidth: 480,
        }}
      >
        <span
          style={{
            width: 14,
            height: 14,
            borderRadius: "50%",
            backgroundColor: theme.accentColor,
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontFamily: "Arial, Helvetica, sans-serif",
            fontSize: 26,
            fontWeight: 700,
            color: "white",
            lineHeight: 1.25,
          }}
        >
          {resource.description}
        </span>
      </div>
    </AbsoluteFill>
  );
};
