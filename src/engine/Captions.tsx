import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { Caption } from "../types";
import { useEngineTheme } from "./theme/ThemeContext";

/**
 * Render simple de subtítulos sincronizados por tiempo (ms).
 * Cuando se generen transcripciones reales, este componente puede
 * sustituirse por `createTikTokStyleCaptions` de `@remotion/captions`
 * sin tocar el resto de la composición: el tipo `Caption` ya es compatible.
 */
export const Captions: React.FC<{ captions: Caption[] }> = ({ captions }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const theme = useEngineTheme();
  const currentMs = (frame / fps) * 1000;

  const activeCaption = captions.find(
    (caption) => currentMs >= caption.startMs && currentMs < caption.endMs,
  );

  if (!activeCaption) {
    return null;
  }

  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-end",
        alignItems: "center",
        paddingBottom: 60,
      }}
    >
      <div
        style={{
          fontFamily: "Arial, Helvetica, sans-serif",
          fontSize: 48,
          fontWeight: 700,
          color: theme.captionTextColor,
          textAlign: "center",
          textShadow: "0 2px 6px rgba(0,0,0,0.9)",
          backgroundColor: theme.captionBackgroundColor,
          padding: "10px 24px",
          borderRadius: 12,
          maxWidth: "80%",
          whiteSpace: "pre-wrap",
        }}
      >
        {activeCaption.text}
      </div>
    </AbsoluteFill>
  );
};
