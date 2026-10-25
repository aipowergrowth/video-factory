import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { ChartGraphicProps } from "../types";

/**
 * Barras animadas simples a partir de `data`. Solo debe alimentarse con
 * cifras reales dichas en el video; no genera ni asume valores.
 */
export const Chart: React.FC<{ graphic: ChartGraphicProps }> = ({
  graphic,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { title, unit, data } = graphic;
  const max = Math.max(...data.map((d) => d.value), 1);

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
          padding: "36px 56px",
          minWidth: 560,
        }}
      >
        {title ? (
          <div
            style={{
              fontFamily: "Arial, Helvetica, sans-serif",
              fontSize: 36,
              fontWeight: 700,
              color: "white",
              marginBottom: 24,
              textAlign: "center",
            }}
          >
            {title}
          </div>
        ) : null}

        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            gap: 28,
            height: 220,
          }}
        >
          {data.map((item, index) => {
            const delay = index * 4;
            const localGrow = interpolate(
              spring({ frame: frame - delay, fps, config: { damping: 200 } }),
              [0, 1],
              [0, 1],
            );
            const heightPx = (item.value / max) * 200 * localGrow;

            return (
              <div
                key={item.label}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 10,
                  width: 90,
                }}
              >
                <div
                  style={{
                    fontFamily: "Arial, Helvetica, sans-serif",
                    fontSize: 24,
                    fontWeight: 700,
                    color: "white",
                    opacity: localGrow,
                  }}
                >
                  {item.value}
                  {unit ?? ""}
                </div>
                <div
                  style={{
                    width: "100%",
                    height: Math.max(heightPx, 2),
                    backgroundColor: "#f5f5f7",
                    borderRadius: 8,
                  }}
                />
                <div
                  style={{
                    fontFamily: "Arial, Helvetica, sans-serif",
                    fontSize: 20,
                    color: "white",
                    textAlign: "center",
                  }}
                >
                  {item.label}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};
