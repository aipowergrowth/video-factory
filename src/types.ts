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
  /**
   * Si los subtítulos van pegados a la imagen o no. Decisión de Alex
   * (31-oct-2026): YouTube ya muestra los suyos (y su traducción) encima
   * de los que el motor pegara, y se ven dobles -- por defecto
   * `youtube-16-9` NO pega subtítulos (el servidor entrega un .srt
   * aparte, ver server/subtitles.mjs) y `vertical-9-16` SÍ los pega,
   * como siempre. Este campo fuerza lo contrario en un job concreto; si
   * no se da, el valor por defecto sale de `destination`
   * (`shouldBurnCaptions` más abajo).
   */
  burnCaptions?: boolean;
  /** Tramos a eliminar del video base. Vacío o ausente = sin cortes. */
  cuts?: Cut[];
  /** Zooms tipo Ken Burns sobre el video base. */
  zooms?: ZoomKeyframe[];
  /**
   * Recursos de la IA editorial ya en tiempo de SALIDA (ver tipo `Resource`
   * arriba) -- solo se renderizan los que pasan `isRenderableByEngine`
   * más abajo; el resto son `pendingResources`.
   */
  resources?: Resource[];
  /** Recursos que la IA editorial decidió pero el motor no renderiza todavía. */
  pendingResources?: PendingResource[];
};

/**
 * Misma función (a propósito duplicada, no importada) en
 * `server/subtitles.mjs` -- el servidor corre con `node` plano y no
 * puede importar este `.ts` (mismo motivo que `engine/timeline.ts` vs.
 * `server/timeline.mjs`). Si una cambia, la otra debe cambiar igual.
 */
export const shouldBurnCaptions = (job: Pick<EngineJob, "destination" | "burnCaptions">): boolean =>
  job.burnCaptions ?? job.destination !== "youtube-16-9";

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
    /**
     * Opcional (02-nov-2026, modelo combinado): guía de estilo visual
     * que se inyecta en el prompt de generación con IA cuando Pixabay
     * no encuentra nada pertinente -- para que las ilustraciones
     * generadas de un mismo canal se vean coherentes entre sí. Sin
     * esto, `buildImageGenerationPrompt` usa un estilo genérico
     * razonable (ver server/image-generation.mjs) -- nunca deja el
     * prompt sin ninguna guía.
     */
    visualStyle?: string;
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
   * pendiente de 3B (ver `cta-guarantee.mjs#isRenderableByEngine`), nunca se
   * usa `description` como reemplazo. Para CTA es opcional: si falta, el
   * motor usa la frase fija del canal (`ChannelProfile.theme.defaultCtaText`).
   */
  displayText?: string;

  /**
   * Fase 3B (31-oct-2026), solo para `type: "broll" | "image"`: consulta
   * concreta y VISUAL para buscar en un banco de medios (hoy, Pixabay) --
   * distinta de `description` (que es prosa editorial, "por qué" se
   * necesita el recurso, no "qué buscar"). Ejemplo: "ilustración 3D de
   * una molécula de dopamina", no "mostrar el concepto para reforzar la
   * comprensión". Sin esto, no hay nada bueno que buscar -- el recurso
   * queda pendiente (ver `server/resource-acquisition.mjs`).
   */
  visualQuery?: string;

  /**
   * Fase 3B, solo para `type: "graphic"`: qué variante generar con los
   * componentes YA existentes (`src/graphics/Chart.tsx`/`CycleDiagram.tsx`/
   * `StatCallout.tsx`) y sus datos. Los valores de `graphicData` deben
   * ser cifras/pasos que el presentador menciona realmente en la
   * transcripción -- NUNCA inventados para completar un gráfico (misma
   * exigencia que `displayText` en `text-highlight`). Sin esto (o con
   * datos no verificables), el recurso queda pendiente, nunca se adivina.
   */
  graphicVariant?: "chart" | "cycle" | "stat";
  graphicData?: ChartGraphicProps | CycleGraphicProps | StatGraphicProps;

  /**
   * Fase 3B: presente cuando `visualQuery` se resolvió contra un banco
   * externo real -- registro de procedencia/licencia obligatorio por
   * recurso (nunca se usa un recurso sin esto). `localPath` es una ruta
   * dentro de `public/`, consumible por `staticFile()` (mismo patrón que
   * `input.baseVideo`).
   *
   * Modelo combinado (02-nov-2026, autorizado por Alex): si Pixabay no
   * encontró nada pertinente Y el recurso es `veracityRequirement:
   * "illustrative-ok"`, puede resolverse con una imagen GENERADA con
   * IA en su lugar (`provider: "google-gemini"`) -- nunca para
   * `"must-be-real"`. `mediaType: "generated-illustration"` es la señal
   * para que el motor de render la trate como una imagen fija (con
   * movimiento de cámara simulado si el recurso era `broll`), nunca
   * como un video real -- ver `ResourceRenderer.tsx`.
   */
  resolvedAsset?:
    | {
        provider: "pixabay";
        assetId: number;
        pageUrl: string;
        localPath: string;
        mediaType: "photo" | "illustration" | "video";
        author: string;
        licenseName: string;
        licenseUrl: string;
        attributionRequired: boolean;
        downloadedAt: string;
      }
    | {
        provider: "google-gemini";
        /** Id exacto del modelo de Gemini usado (ver server/image-generation.mjs). */
        model: string;
        /** El prompt EXACTO enviado -- nunca la clave de la API. */
        prompt: string;
        localPath: string;
        mediaType: "generated-illustration";
        licenseName: string;
        attributionRequired: false;
        /** Costo real de la generación (tarifa verificada, no estimada). */
        costUsd: number;
        generatedAt: string;
        /** Siempre `true` -- nunca se presenta como un documento o registro auténtico (Fase 3C es lo opuesto a esto). */
        synthetic: true;
      };

  /**
   * Fase 3B: si la adquisición automática no encontró un resultado
   * suficientemente pertinente (o falló la búsqueda/descarga), el motivo
   * específico -- reemplaza el motivo genérico de Fase 3B en
   * `pendingResources` cuando está presente (ver
   * `cta-guarantee.mjs#computePendingResources`).
   */
  acquisitionFailureReason?: string;
};

/**
 * Misma función (a propósito duplicada, no importada) en
 * `server/cta-guarantee.mjs` -- mismo motivo que `shouldBurnCaptions`
 * más arriba. Si una cambia, la otra debe cambiar igual.
 */
export const isValidGraphicData = (
  variant: Resource["graphicVariant"],
  data: Resource["graphicData"],
): boolean => {
  if (!data || typeof data !== "object") return false;
  if (variant === "chart") {
    const chart = data as ChartGraphicProps;
    return (
      Array.isArray(chart.data) &&
      chart.data.length > 0 &&
      chart.data.every((d) => d && typeof d.label === "string" && typeof d.value === "number" && Number.isFinite(d.value))
    );
  }
  if (variant === "cycle") {
    const cycle = data as CycleGraphicProps;
    return Array.isArray(cycle.steps) && cycle.steps.length > 0 && cycle.steps.every((s) => typeof s === "string" && s.trim().length > 0);
  }
  if (variant === "stat") {
    const stat = data as StatGraphicProps;
    return typeof stat.value === "string" && stat.value.trim().length > 0 && typeof stat.label === "string" && stat.label.trim().length > 0;
  }
  return false;
};

/**
 * Misma función (a propósito duplicada) en
 * `server/cta-guarantee.mjs#isRenderableByEngine` -- qué recursos puede
 * pintar hoy el motor. Si una cambia, la otra debe cambiar igual.
 */
export const isRenderableByEngine = (resource: Resource): boolean =>
  Boolean(resource.ctaPosition) ||
  (resource.type === "text-highlight" && Boolean(resource.displayText)) ||
  (resource.type === "graphic" && isValidGraphicData(resource.graphicVariant, resource.graphicData)) ||
  ((resource.type === "broll" || resource.type === "image") && Boolean(resource.resolvedAsset));

/**
 * Recurso que la IA editorial decidió pero que el motor todavía no puede
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
