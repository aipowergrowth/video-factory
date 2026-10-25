import type { CSSProperties } from "react";

/**
 * Compatible con el tipo `Caption` de `@remotion/captions`.
 * Se define a mano para no añadir esa dependencia hasta que haga falta
 * el resto de su API (agrupado estilo TikTok, resaltado de palabra, etc).
 */
export type Caption = {
  text: string;
  startMs: number;
  endMs: number;
  timestampMs: number | null;
  confidence: number | null;
};

type OverlayBase = {
  id: string;
  startSeconds: number;
  durationSeconds: number;
  style?: CSSProperties;
};

export type ImageOverlay = OverlayBase & {
  type: "image";
  src: string;
};

export type BRollOverlay = OverlayBase & {
  type: "broll";
  src: string;
  /** Por defecto en mute para no pisar el audio original. */
  muted?: boolean;
  volume?: number;
};

export type TextOverlay = OverlayBase & {
  type: "text";
  text: string;
};

export type ChartGraphicProps = {
  title?: string;
  unit?: string;
  data: { label: string; value: number }[];
};

export type CycleGraphicProps = {
  title?: string;
  steps: string[];
};

export type StatGraphicProps = {
  value: string;
  label: string;
};

/**
 * Gráficos/diagramas generados en código (SVG + React), sin assets externos.
 */
export type GraphicOverlay = OverlayBase &
  (
    | { graphic: "chart"; props: ChartGraphicProps }
    | { graphic: "cycle"; props: CycleGraphicProps }
    | { graphic: "stat"; props: StatGraphicProps }
  ) & { type: "graphic" };

export type Overlay =
  | ImageOverlay
  | BRollOverlay
  | TextOverlay
  | GraphicOverlay;

/** Formato horizontal (YouTube) o vertical (Shorts/Reels/TikTok). */
export type Destination = "youtube-16-9" | "vertical-9-16";

export const DESTINATION_DIMENSIONS: Record<
  Destination,
  { width: number; height: number }
> = {
  "youtube-16-9": { width: 1920, height: 1080 },
  "vertical-9-16": { width: 1080, height: 1920 },
};

export const ENGINE_FPS = 30;

/**
 * Entrada de hoy: un video ya grabado (rostro + audio originales), que se
 * reproduce tal cual como capa base.
 */
export type RecordedVideoInput = {
  type: "recorded-video";
  /** Ruta dentro de public/ del video original. */
  baseVideo: string;
  /** Duración total del video original, en segundos. */
  durationInSeconds: number;
};

/**
 * Futuras entradas (NO implementadas todavía): el motor ya está preparado
 * para sumarlas sin reconstruir nada de overlays/captions/canales — solo
 * hace falta añadir el variante aquí y su "fuente" en
 * `src/engine/sources/`.
 *
 * export type ScriptAudioImagesInput = {
 *   type: "script-audio-images";
 *   script: string;
 *   audio: string;
 *   images: string[];
 * };
 */
export type EngineInput = RecordedVideoInput; // | ScriptAudioImagesInput (futuro)

/**
 * Un "trabajo" para el motor: qué canal, a qué formato de salida y con qué
 * entrada, más las inserciones (overlays) y subtítulos ya decididos.
 */
export type EngineJob = {
  /** Debe existir `public/channels/<channel>/profile.json`. */
  channel: string;
  destination: Destination;
  input: EngineInput;
  /** Inserciones puntuales. Los huecos entre ellas se quedan sin B-roll. */
  overlays: Overlay[];
  /** Subtítulos sincronizados. Estructura lista; puede ir vacío. */
  captions?: Caption[];
};

/** Perfil editorial de un canal — vive fuera del código, en public/channels. */
export type ChannelProfile = {
  channelId: string;
  displayName: string;
  theme: {
    accentColor: string;
    captionBackgroundColor: string;
    captionTextColor: string;
  };
};

/** Una regla de corrección fonética/ASR para un canal (ver public/channels). */
export type CorrectionRule = {
  from: string;
  to: string;
  caseSensitive?: boolean;
};
