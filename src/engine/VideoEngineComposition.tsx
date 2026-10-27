import { Composition, type CalculateMetadataFunction } from "remotion";
import { VideoEngine, type VideoEngineProps } from "./VideoEngine";
import { loadJob } from "./loadJob";
import { loadChannelProfile } from "../channels/loadChannelProfile";
import { getDurationInSeconds } from "./getDurationInSeconds";
import { buildTimeline } from "./timeline";
import { secondsToFrames } from "../lib/time";
import { DESTINATION_DIMENSIONS, ENGINE_FPS } from "../types";

const calculateMetadata: CalculateMetadataFunction<VideoEngineProps> = async ({
  props,
}) => {
  const job = await loadJob(props.jobFile);
  const channelProfile = await loadChannelProfile(job.channel);
  const { width, height } = DESTINATION_DIMENSIONS[job.destination];

  // La duración de salida ya descuenta los `cuts` (ver engine/timeline.ts) —
  // si el trabajo no tiene cortes, es idéntica a la duración del original.
  const timeline = buildTimeline(
    getDurationInSeconds(job.input),
    job.cuts ?? [],
  );

  return {
    width,
    height,
    fps: ENGINE_FPS,
    durationInFrames: secondsToFrames(
      timeline.outputDurationInSeconds,
      ENGINE_FPS,
    ),
    props: { ...props, job, channelProfile },
  };
};

/**
 * Un solo motor para todos los canales y formatos: las dimensiones salen de
 * `destination` y el aspecto editorial de `channel`, ambos resueltos en
 * tiempo de render a partir del archivo de trabajo (`jobFile`).
 */
export const VideoEngineComposition: React.FC = () => {
  return (
    <Composition
      id="VideoEngine"
      component={VideoEngine}
      fps={ENGINE_FPS}
      width={DESTINATION_DIMENSIONS["youtube-16-9"].width}
      height={DESTINATION_DIMENSIONS["youtube-16-9"].height}
      // Placeholder: calculateMetadata recalcula esto a partir del trabajo.
      durationInFrames={ENGINE_FPS * 10}
      defaultProps={
        { jobFile: "jobs/ejemplo.json" } satisfies VideoEngineProps
      }
      calculateMetadata={calculateMetadata}
    />
  );
};
