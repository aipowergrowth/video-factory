import { AbsoluteFill, Sequence, useVideoConfig } from "remotion";
import type { ChannelProfile, EngineJob } from "../types";
import { secondsToFrames } from "../lib/time";
import { OverlayRenderer } from "./OverlayRenderer";
import { Captions } from "./Captions";
import { Fade } from "./Fade";
import { Source } from "./sources/Source";
import { ThemeProvider, DEFAULT_THEME } from "./theme/ThemeContext";

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

  return (
    <ThemeProvider value={theme}>
      <AbsoluteFill style={{ backgroundColor: "black" }}>
        <Source input={job.input} />

        {job.overlays.map((overlay) => {
          const from = secondsToFrames(overlay.startSeconds, fps);
          const durationInFrames = secondsToFrames(
            overlay.durationSeconds,
            fps,
          );

          if (durationInFrames <= 0) {
            return null;
          }

          return (
            <Sequence
              key={overlay.id}
              from={from}
              durationInFrames={durationInFrames}
            >
              <Fade durationInFrames={durationInFrames}>
                <OverlayRenderer overlay={overlay} />
              </Fade>
            </Sequence>
          );
        })}

        {job.captions && job.captions.length > 0 ? (
          <Captions captions={job.captions} />
        ) : null}
      </AbsoluteFill>
    </ThemeProvider>
  );
};
