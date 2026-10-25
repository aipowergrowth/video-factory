import { createContext, useContext } from "react";
import type { ChannelProfile } from "../../types";

/**
 * Valores por defecto: idénticos a los colores que ya usaban los overlays
 * antes de existir perfiles por canal, para que un job sin `channel`
 * resuelto (o sin perfil) se vea exactamente igual que antes.
 */
export const DEFAULT_THEME: ChannelProfile["theme"] = {
  accentColor: "#ffffff",
  captionBackgroundColor: "rgba(0,0,0,0.6)",
  captionTextColor: "#ffffff",
};

const ThemeContext = createContext<ChannelProfile["theme"]>(DEFAULT_THEME);

export const ThemeProvider = ThemeContext.Provider;

export const useEngineTheme = (): ChannelProfile["theme"] => {
  return useContext(ThemeContext);
};
