import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { Caption } from "../types";
import { useEngineTheme } from "./theme/ThemeContext";

/**
 * Render simple de subtítulos sincronizados por tiempo (ms).
 * Cuando se generen transcripciones reales, este componente puede
 * sustituirse por `createTikTokStyleCaptions` de `@remotion/captions`
 * sin tocar el resto de la composición: el tipo `Caption` ya es compatible.
 *
 * Estilo dinámico vertical (03-nov-2026): si la línea activa trae
 * `words` (desglose por palabra, ver `server/captions.mjs`), resalta
 * la palabra que se está diciendo en este instante -- calculado con la
 * fracción de progreso dentro de `[startMs, endMs]` de la línea, no un
 * tiempo absoluto (ver el comentario de `CaptionWord` en
 * `src/types.ts`). Sin `words` (captions manuales o de un job viejo),
 * se muestra la línea completa exactamente como antes -- fail-safe:
 * nunca rompe, solo deja de resaltar.
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

  const lineSpan = activeCaption.endMs - activeCaption.startMs;
  const progressFraction = lineSpan > 0 ? (currentMs - activeCaption.startMs) / lineSpan : 0;
  const hasWords = Array.isArray(activeCaption.words) && activeCaption.words.length > 0;

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
        {hasWords
          ? activeCaption.words!.map((word, index) => {
              // Última palabra: tolerancia para que no se "apague" el
              // resaltado un instante antes de que termine la línea por
              // un simple redondeo de fracciones.
              const isLast = index === activeCaption.words!.length - 1;
              const isActive =
                progressFraction >= word.startFraction &&
                (isLast || progressFraction < word.endFraction);
              return (
                <span
                  key={index}
                  style={{
                    color: isActive ? theme.accentColor : theme.captionTextColor,
                  }}
                >
                  {word.text}
                  {index < activeCaption.words!.length - 1 ? " " : ""}
                </span>
              );
            })
          : activeCaption.text}
      </div>
    </AbsoluteFill>
  );
};
