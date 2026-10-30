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
 * Un corte: tramo del video ORIGINAL que se elimina de la salida. Igual que
 * `overlays`/`captions`, se piensa en el tiempo del original — el motor
 * recalcula dónde cae todo lo demás tras quitarlo (ver `engine/timeline.ts`).
 */
export type Cut = {
  id: string;
  startSeconds: number;
  endSeconds: number;
};

/**
 * Un "punch-in" tipo Ken Burns sobre el video base, en el tiempo del
 * ORIGINAL. `fromScale`/`toScale` son factores de escala (1 = sin zoom).
 * `origin` es el punto focal como fracción del cuadro (0-1, 0.5/0.5 = centro).
 */
export type ZoomKeyframe = {
  id: string;
  startSeconds: number;
  endSeconds: number;
  fromScale: number;
  toScale: number;
  origin?: { x: number; y: number };
};

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
  /** Tramos a eliminar del video base. Vacío o ausente = sin cortes. */
  cuts?: Cut[];
  /** Zooms tipo Ken Burns sobre el video base. */
  zooms?: ZoomKeyframe[];
  /**
   * Recursos de la IA editorial ya en tiempo de SALIDA (ver tipo `Resource`
   * arriba) -- Fase 3A solo renderiza los que tengan `ctaPosition` o
   * `type === "text-highlight"`; el resto son `pendingResources`.
   */
  resources?: Resource[];
  /** Recursos que la IA editorial decidió pero Fase 3A no renderiza todavía. */
  pendingResources?: PendingResource[];
};

/** Perfil editorial de un canal — vive fuera del código, en public/channels. */
export type ChannelProfile = {
  channelId: string;
  displayName: string;
  theme: {
    accentColor: string;
    captionBackgroundColor: string;
    captionTextColor: string;
    /**
     * Frase de respaldo para un CTA que no trae `displayText` propio --
     * nunca se usa `resource.description` para esto. Fija por canal
     * (p.ej. "Dale like y suscríbete a 'A mí no me cuadra'"), sin
     * enlaces, usuarios ni nombres de perfil inventados.
     */
    defaultCtaText: string;
  };
};

/** Una regla de corrección fonética/ASR para un canal (ver public/channels). */
export type CorrectionRule = {
  from: string;
  to: string;
  caseSensitive?: boolean;
};

/**
 * Recursos audiovisuales decididos por la IA editorial (`server/editorial.mjs`)
 * y ya procesados por la garantía de CTA (`server/cta-guarantee.mjs`) antes de
 * llegar a este motor. A DIFERENCIA de `overlays`/`cuts`/`zooms`/`captions`
 * (que viajan en tiempo del video ORIGINAL y este motor los remapea con
 * `engine/timeline.ts`), `startSeconds`/`endSeconds` acá YA vienen en tiempo
 * de SALIDA -- el servidor ya corrió `remapRangeToOutput` (y, si hacía falta,
 * reubicación por corte) antes de persistir el job. Nunca volver a remapear
 * esto con `buildTimeline`/`remapRangeToOutput` -- sería aplicar el
 * desplazamiento de los cortes dos veces.
 */
export type ResourceType =
  | "broll"
  | "image"
  | "graphic"
  | "document-reference"
  | "text-highlight"
  | "transition"
  | "music"
  | "sfx";

export type CtaPosition = "start" | "middle" | "end";

export type Resource = {
  id: string;
  /** Tiempo de SALIDA (ya editado) -- ver comentario del tipo arriba. */
  startSeconds: number;
  endSeconds: number;
  type: ResourceType;
  description: string;
  justification?: string;
  editorialGoal:
    | "evidence"
    | "comprehension"
    | "context"
    | "emotion"
    | "emphasis"
    | "transition";
  segment: "intro" | "development" | "demonstration" | "transition" | "closing";
  intensity: "subtle" | "moderate" | "prominent";
  veracityRequirement: "must-be-real" | "illustrative-ok";
  essential: boolean;
  provenanceNotes?: string;
  /** Si está presente, es uno de los 3 CTA obligatorios -- ver cta-guarantee.mjs. */
  ctaPosition?: CtaPosition;
  /** Solo en recursos de CTA: posición/porcentaje sobre la línea YA editada. */
  editedSeconds?: number;
  editedPercent?: number;
  /**
   * El texto EXACTO que debe verse en pantalla -- NUNCA `description`
   * (esa es prosa para el editor humano, no contenido para el video; ver
   * el defecto real que llevó a este campo: el render mostraba cosas
   * como "Texto resaltado: '...'" literalmente en pantalla). Para
   * `text-highlight` es obligatorio -- sin esto, el recurso queda
   * pendiente de 3B (ver `cta-guarantee.mjs#isRenderableIn3A`), nunca se
   * usa `description` como reemplazo. Para CTA es opcional: si falta, el
   * motor usa la frase fija del canal (`ChannelProfile.theme.defaultCtaText`).
   */
  displayText?: string;
};

/**
 * Recurso que la IA editorial decidió pero que Fase 3A todavía no puede
 * representar visualmente (ver `server/cta-guarantee.mjs#computePendingResources`).
 * Puramente informativo para el job/informe humano -- este motor NO lo lee
 * ni intenta renderizarlo.
 */
export type PendingResource = {
  id: string;
  type: ResourceType;
  description: string;
  essential: boolean;
  reason: string;
};
