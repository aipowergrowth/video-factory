import { AbsoluteFill, Sequence, useVideoConfig } from "remotion";
import type { Caption, ChannelProfile, EngineJob } from "../types";
import { secondsToFrames } from "../lib/time";
import { OverlayRenderer } from "./OverlayRenderer";
import { ResourceRenderer } from "./ResourceRenderer";
import { Captions } from "./Captions";
import { Fade } from "./Fade";
import { Source } from "./sources/Source";
import { ThemeProvider, DEFAULT_THEME } from "./theme/ThemeContext";
import { getDurationInSeconds } from "./getDurationInSeconds";
import { buildTimeline, remapRangeToOutput } from "./timeline";

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
  // desplazamiento de los cortes dos veces. Fase 3A solo renderiza CTA
  // (cualquier `type` con `ctaPosition`) y `text-highlight` -- el resto
  // quedó en `job.pendingResources`, que este motor no lee (es solo para
  // el informe humano).
  const renderableResources = (job.resources ?? []).filter(
    (resource) => Boolean(resource.ctaPosition) || resource.type === "text-highlight",
  );

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

        {renderableResources.map((resource) => {
          const from = secondsToFrames(resource.startSeconds, fps);
          const durationInFrames = secondsToFrames(
            resource.endSeconds - resource.startSeconds,
            fps,
          );
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
        })}

        {captionsInOutputTime.length > 0 ? (
          <Captions captions={captionsInOutputTime} />
        ) : null}
      </AbsoluteFill>
    </ThemeProvider>
  );
};
