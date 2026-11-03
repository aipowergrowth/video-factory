import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { Resource } from "../types";

/**
 * Emoji contextual (`type: "emoji"`, estilo dinámico vertical,
 * 03-nov-2026). `VideoEngine.tsx` ya garantiza que este componente solo
 * recibe recursos CON `emojiChar` (ver `isRenderableByEngine`) -- si no
 * lo trae, queda pendiente en vez de llegar acá.
 *
 * Posición: arriba a la derecha, chico -- nunca al centro (tapa la
 * cara) ni abajo (compite con los subtítulos/TextHighlightOverlay, que
 * ya usa la franja superior central).
 *
 * El fundido de entrada/salida lo da `Fade` (ya envuelve cada recurso
 * en `VideoEngine.tsx#renderResourceSequence`, mismo mecanismo que
 * text-highlight/broll/image) -- acá solo se agrega un rebote de
 * ENTRADA tipo "sticker" encima de eso (spring con poco damping, más
 * juguetón que el pop-in sobrio de `TextHighlightOverlay`), sin
 * reimplementar la salida: menos código nuevo, reutiliza un mecanismo
 * ya probado en vez de uno propio sin probar.
 *
 * Requiere una fuente de emoji instalada en el contenedor de render
 * (ver Dockerfile, `fonts-noto-color-emoji`) -- sin eso, Chromium no
 * tiene ningún glifo para dibujar.
 */
export const EmojiOverlay: React.FC<{ resource: Resource }> = ({
  resource,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const appear = spring({ frame, fps, config: { damping: 10, mass: 0.5 } });
  const scale = interpolate(appear, [0, 1], [0.3, 1]);

  return (
    <AbsoluteFill
      style={{ justifyContent: "flex-start", alignItems: "flex-end", padding: "48px 48px 0" }}
    >
      <span
        style={{
          transform: `scale(${scale})`,
          fontSize: 96,
          lineHeight: 1,
          textShadow: "0 4px 10px rgba(0,0,0,0.35)",
        }}
      >
        {resource.emojiChar}
      </span>
    </AbsoluteFill>
  );
};
