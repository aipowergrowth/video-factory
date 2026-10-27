import { AbsoluteFill, Sequence, useVideoConfig } from "remotion";
import type { Caption, ChannelProfile, EngineJob } from "../types";
import { secondsToFrames } from "../lib/time";
import { OverlayRenderer } from "./OverlayRenderer";
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

        {captionsInOutputTime.length > 0 ? (
          <Captions captions={captionsInOutputTime} />
        ) : null}
      </AbsoluteFill>
    </ThemeProvider>
  );
};
