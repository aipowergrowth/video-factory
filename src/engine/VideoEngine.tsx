import { AbsoluteFill, Sequence, useVideoConfig } from "remotion";
import type { Caption, ChannelProfile, EngineJob, Resource } from "../types";
import { shouldBurnCaptions, isRenderableByEngine } from "../types";
import { secondsToFrames } from "../lib/time";
import { OverlayRenderer } from "./OverlayRenderer";
import { ResourceRenderer } from "./ResourceRenderer";
import { Captions } from "./Captions";
import { Fade } from "./Fade";
import { Source } from "./sources/Source";
import { ThemeProvider, DEFAULT_THEME } from "./theme/ThemeContext";
import { getDurationInSeconds } from "./getDurationInSeconds";
import { buildTimeline, remapRangeToOutput } from "./timeline";

/** `resource.startSeconds`/`endSeconds` ya vienen en tiempo de SALIDA -- ver el comentario grande más abajo. */
const renderResourceSequence = (resource: Resource, fps: number) => {
  const from = secondsToFrames(resource.startSeconds, fps);
  const durationInFrames = secondsToFrames(resource.endSeconds - resource.startSeconds, fps);
  if (durationInFrames <= 0) {
    return null;
  }
  return (
    <Sequence key={resource.id} from={from} durationInFrames={durationInFrames}>
      <Fade durationInFrames={durationInFrames}>
        <ResourceRenderer resource={resource} />
      </Fade>
    </Sequence>
  );
};

export type VideoEngineProps = {
  jobFile: string;
  /** Inyectados por `calculateMetadata`; no se pasan a mano. */
  job?: EngineJob;
  channelProfile?: ChannelProfile;
};

export const VideoEngine: React.FC<VideoEngineProps> = ({
  job,
  channelProfile,
}) => {
  const { fps } = useVideoConfig();

  if (!job) {
    return null;
  }

  const theme = channelProfile?.theme ?? DEFAULT_THEME;

  // `overlays`/`captions` llegan en tiempo del video ORIGINAL — igual que
  // `cuts`/`zooms` — así que hay que traducirlos al tiempo de SALIDA (ya sin
  // los tramos cortados) antes de colocarlos. Ver `engine/timeline.ts`.
  const timeline = buildTimeline(
    getDurationInSeconds(job.input),
    job.cuts ?? [],
  );

  const overlaysInOutputTime = job.overlays.flatMap((overlay) => {
    const ranges = remapRangeToOutput(timeline, {
      startSeconds: overlay.startSeconds,
      endSeconds: overlay.startSeconds + overlay.durationSeconds,
    });
    return ranges.map((range, index) => ({
      overlay,
      // Un corte puede partir un overlay en dos pedazos que sobreviven;
      // cada pedazo necesita su propia key única.
      key: ranges.length > 1 ? `${overlay.id}-${index}` : overlay.id,
      from: secondsToFrames(range.startSeconds, fps),
      durationInFrames: secondsToFrames(
        range.endSeconds - range.startSeconds,
        fps,
      ),
    }));
  });

  // A diferencia de overlays/captions, `job.resources` YA viene en tiempo
  // de SALIDA -- el servidor (cta-guarantee.mjs) ya corrió
  // remapRangeToOutput (y la reubicación por corte, si hacía falta) antes
  // de persistir el job. Volver a remapear acá aplicaría el
  // desplazamiento de los cortes dos veces. `isRenderableByEngine`
  // (compartida con cta-guarantee.mjs) decide qué se puede pintar hoy; el
  // resto queda en `job.pendingResources` -- solo para el informe
  // humano, este motor nunca lo lee.
  //
  // Orden de pintado (Fase 3B, 31-oct-2026): broll/image se pintan
  // PRIMERO (ocupan el cuadro completo, son el contenido de fondo) y
  // CTA/graphic/text-highlight DESPUÉS, para que estos últimos queden
  // siempre encima sin importar en qué orden el planificador los haya
  // propuesto -- los subtítulos ya iban al final (ver más abajo), esto
  // extiende la misma garantía al resto de los recursos en primer plano.
  const renderableResources = (job.resources ?? []).filter(isRenderableByEngine);
  const backgroundResources = renderableResources.filter((r) => r.type === "broll" || r.type === "image");
  const foregroundResources = renderableResources.filter((r) => r.type !== "broll" && r.type !== "image");

  const captionsInOutputTime: Caption[] = (job.captions ?? []).flatMap(
    (caption) => {
      const ranges = remapRangeToOutput(timeline, {
        startSeconds: caption.startMs / 1000,
        endSeconds: caption.endMs / 1000,
      });
      return ranges.map((range) => ({
        ...caption,
        startMs: range.startSeconds * 1000,
        endMs: range.endSeconds * 1000,
      }));
    },
  );

  return (
    <ThemeProvider value={theme}>
      <AbsoluteFill style={{ backgroundColor: "black" }}>
        <Source input={job.input} cuts={job.cuts} zooms={job.zooms} />

        {overlaysInOutputTime.map(({ overlay, key, from, durationInFrames }) => {
          if (durationInFrames <= 0) {
            return null;
          }

          return (
            <Sequence key={key} from={from} durationInFrames={durationInFrames}>
              <Fade durationInFrames={durationInFrames}>
                <OverlayRenderer overlay={overlay} />
              </Fade>
            </Sequence>
          );
        })}

        {backgroundResources.map((resource) => renderResourceSequence(resource, fps))}

        {foregroundResources.map((resource) => renderResourceSequence(resource, fps))}

        {shouldBurnCaptions(job) && captionsInOutputTime.length > 0 ? (
          <Captions captions={captionsInOutputTime} />
        ) : null}
      </AbsoluteFill>
    </ThemeProvider>
  );
};
