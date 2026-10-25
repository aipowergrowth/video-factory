import type { EngineInput } from "../types";

/**
 * Punto de extensión: cada tipo de entrada sabe calcular su propia
 * duración. Al sumar un tipo nuevo (p.ej. guion + audio + imágenes) se
 * añade su `case` aquí — el resto del motor no cambia.
 */
export const getDurationInSeconds = (input: EngineInput): number => {
  switch (input.type) {
    case "recorded-video":
      return input.durationInSeconds;
    default: {
      const exhaustiveCheck: never = input.type;
      throw new Error(`Tipo de entrada no soportado: ${exhaustiveCheck}`);
    }
  }
};
