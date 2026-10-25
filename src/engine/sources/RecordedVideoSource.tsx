import { OffthreadVideo, staticFile } from "remotion";
import type { RecordedVideoInput } from "../../types";

/**
 * Fuente de hoy: un video ya grabado. Se reproduce tal cual — conserva su
 * audio y su rostro — y se ajusta al lienzo del `destination` elegido
 * (p.ej. recorta los costados si el destino es vertical y el original es
 * 16:9; no hay recentrado inteligente de sujeto, es un ajuste literal).
 */
export const RecordedVideoSource: React.FC<{ input: RecordedVideoInput }> = ({
  input,
}) => {
  return (
    <OffthreadVideo
      src={staticFile(input.baseVideo)}
      style={{ width: "100%", height: "100%", objectFit: "cover" }}
    />
  );
};
