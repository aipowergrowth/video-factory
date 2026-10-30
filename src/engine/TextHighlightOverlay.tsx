import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { Resource } from "../types";
import { useEngineTheme } from "./theme/ThemeContext";

/**
 * Texto en pantalla (`type: "text-highlight"`, sin `ctaPosition`). Debe
 * representar FIELMENTE lo que el plan editorial puso en `displayText`
 * -- NUNCA `description` (esa es prosa para el editor humano, no
 * contenido para el video; defecto real que motivó este campo: el
 * render mostraba cosas como "Texto resaltado: '...'" literalmente en
 * pantalla). `VideoEngine.tsx` ya garantiza que este componente solo
 * recibe recursos CON `displayText` -- si no lo trae, queda pendiente
 * de 3B en vez de llegar acá (ver cta-guarantee.mjs#isRenderableIn3A).
 * Arriba, centrado -- nunca abajo, para no competir con los subtítulos.
 */
export const TextHighlightOverlay: React.FC<{ resource: Resource }> = ({
  resource,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const theme = useEngineTheme();
  const appear = spring({ frame, fps, config: { damping: 200 } });
  const scale = interpolate(appear, [0, 1], [0.92, 1]);
  const opacity = interpolate(appear, [0, 1], [0, 1]);

  return (
    <AbsoluteFill
      style={{ justifyContent: "flex-start", alignItems: "center", padding: "56px 80px 0" }}
    >
      <div
        style={{
          opacity,
          transform: `scale(${scale})`,
          backgroundColor: "rgba(10,10,14,0.78)",
          borderTop: `6px solid ${theme.accentColor}`,
          borderRadius: 16,
          padding: "20px 36px",
          maxWidth: "80%",
        }}
      >
        <span
          style={{
            fontFamily: "Arial, Helvetica, sans-serif",
            fontSize: 42,
            fontWeight: 700,
            color: "white",
            textAlign: "center",
            lineHeight: 1.3,
            textShadow: "0 2px 6px rgba(0,0,0,0.6)",
          }}
        >
          {resource.displayText}
        </span>
      </div>
    </AbsoluteFill>
  );
};
