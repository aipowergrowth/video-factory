import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";

/**
 * Imagen fija con un movimiento de cámara lento tipo Ken Burns --
 * decisión cerrada de Alex (02-nov-2026, modelo combinado): un `broll`
 * sin cobertura en Pixabay se resuelve con una imagen GENERADA, nunca
 * un video real, pero no debe quedar completamente estática.
 *
 * Mismo patrón matemático que `TrimmedZoomableVideo`
 * (sources/RecordedVideoSource.tsx): interpola `scale` sobre un
 * `transformOrigin` fijo -- a propósito es código NUEVO, no comparte
 * ni toca ese componente (que anima el video base con keyframes de
 * zoom por tramo; esto anima un recurso generado sobre TODA su
 * duración, sin keyframes, un caso distinto).
 */
export const KenBurnsImageOverlay: React.FC<{
  src: string;
  durationInSeconds: number;
}> = ({ src, durationInSeconds }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const durationInFrames = Math.max(1, Math.round(durationInSeconds * fps));
  const progress = Math.min(1, frame / durationInFrames);
  // Lento y sutil a propósito: 1.00 -> 1.12 sobre toda la duración,
  // origen ligeramente descentrado para que se note el movimiento sin
  // llamar la atención sobre la ilustración en sí.
  const scale = 1 + 0.12 * progress;

  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <Img
        src={staticFile(src)}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: `scale(${scale})`,
          transformOrigin: "45% 40%",
        }}
      />
    </AbsoluteFill>
  );
};
