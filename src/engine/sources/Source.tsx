import type { Cut, EngineInput, ZoomKeyframe } from "../../types";
import { RecordedVideoSource } from "./RecordedVideoSource";

/**
 * Punto de extensión: para sumar un tipo de entrada nuevo (guion + audio +
 * imágenes, etc.) se añade su variante en `EngineInput` (src/types.ts), un
 * componente de fuente aquí al lado, y un `case` más abajo. El resto del
 * motor (overlays, captions, canales) no cambia.
 */
export const Source: React.FC<{
  input: EngineInput;
  cuts?: Cut[];
  zooms?: ZoomKeyframe[];
}> = ({ input, cuts, zooms }) => {
  switch (input.type) {
    case "recorded-video":
      return <RecordedVideoSource input={input} cuts={cuts} zooms={zooms} />;
    default: {
      const exhaustiveCheck: never = input.type;
      throw new Error(`Tipo de entrada no soportado: ${exhaustiveCheck}`);
    }
  }
};
