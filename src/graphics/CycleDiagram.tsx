import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { CycleGraphicProps } from "../types";
import { useEngineTheme } from "../engine/theme/ThemeContext";

/**
 * Diagrama de ciclo/proceso genérico: N pasos en fila conectados por flechas.
 * Reutilizable para visualizar cualquier estructura que el locutor describa
 * (p.ej. un bucle de hábito), sin inventar datos: solo ordena los pasos dados.
 */
export const CycleDiagram: React.FC<{ graphic: CycleGraphicProps }> = ({
  graphic,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const theme = useEngineTheme();
  const { title, steps } = graphic;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        padding: 80,
      }}
    >
      <div
        style={{
          backgroundColor: "rgba(10,10,14,0.72)",
          borderRadius: 28,
          padding: "40px 56px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 32,
        }}
      >
        {title ? (
          <div
            style={{
              fontFamily: "Arial, Helvetica, sans-serif",
              fontSize: 40,
              fontWeight: 700,
              color: "white",
              textAlign: "center",
            }}
          >
            {title}
          </div>
        ) : null}

        <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
          {steps.map((step, index) => {
            const delay = index * 6;
            const appear = spring({
              frame: frame - delay,
              fps,
              config: { damping: 200 },
            });
            const opacity = interpolate(appear, [0, 1], [0, 1]);
            const translateY = interpolate(appear, [0, 1], [20, 0]);

            return (
              <div
                key={step}
                style={{ display: "flex", alignItems: "center" }}
              >
                <div
                  style={{
                    opacity,
                    transform: `translateY(${translateY}px)`,
                    backgroundColor: "#f5f5f7",
                    color: "#0a0a0e",
                    borderRadius: 16,
                    padding: "20px 28px",
                    fontFamily: "Arial, Helvetica, sans-serif",
                    fontSize: 30,
                    fontWeight: 700,
                    textAlign: "center",
                    maxWidth: 260,
                  }}
                >
                  {step}
                </div>
                {index < steps.length - 1 ? (
                  <div
                    style={{
                      opacity,
                      color: theme.accentColor,
                      fontSize: 40,
                      padding: "0 18px",
                    }}
                  >
                    →
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};
