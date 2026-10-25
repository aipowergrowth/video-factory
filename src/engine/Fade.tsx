import { useCurrentFrame, interpolate } from "remotion";
import type { PropsWithChildren } from "react";

/**
 * Transición limpia de entrada/salida para cualquier overlay.
 * Se usa dentro de un <Sequence>, así que `useCurrentFrame()` ya es
 * relativo al inicio de ese overlay.
 */
export const Fade: React.FC<
  PropsWithChildren<{ durationInFrames: number; fadeFrames?: number }>
> = ({ durationInFrames, fadeFrames = 8, children }) => {
  const frame = useCurrentFrame();
  const clampedFade = Math.min(fadeFrames, Math.floor(durationInFrames / 2));

  const opacity = interpolate(
    frame,
    [0, clampedFade, durationInFrames - clampedFade, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  return <div style={{ opacity, width: "100%", height: "100%" }}>{children}</div>;
};
