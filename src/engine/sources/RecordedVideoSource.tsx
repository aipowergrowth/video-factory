import { OffthreadVideo, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import type { Cut, RecordedVideoInput, ZoomKeyframe } from "../../types";
import { secondsToFrames } from "../../lib/time";
import { buildTimeline } from "../timeline";

const DEFAULT_ORIGIN = { x: 0.5, y: 0.5 };

/**
 * Un tramo del video base ya trimeado (`trimBefore`/`durationInFrames`) con
 * el zoom tipo Ken Burns aplicado como `transform: scale()` por frame. El
 * zoom se evalúa en tiempo del ORIGINAL (`sourceStartSeconds` es el punto de
 * partida de este tramo en ese tiempo), igual que `cuts`/`overlays`.
 */
const TrimmedZoomableVideo: React.FC<{
  src: string;
  trimBeforeFrames: number;
  durationInFrames: number;
  sourceStartSeconds: number;
  zooms: ZoomKeyframe[];
  fps: number;
}> = ({ src, trimBeforeFrames, durationInFrames, sourceStartSeconds, zooms, fps }) => {
  const frame = useCurrentFrame();
  const currentSourceSeconds = sourceStartSeconds + frame / fps;

  const activeZoom = zooms.find(
    (zoom) =>
      currentSourceSeconds >= zoom.startSeconds &&
      currentSourceSeconds <= zoom.endSeconds,
  );

  let scale = 1;
  let origin = DEFAULT_ORIGIN;
  if (activeZoom) {
    const span = activeZoom.endSeconds - activeZoom.startSeconds;
    const progress =
      span > 0
        ? Math.min(
            1,
            Math.max(0, (currentSourceSeconds - activeZoom.startSeconds) / span),
          )
        : 1;
    scale = activeZoom.fromScale + (activeZoom.toScale - activeZoom.fromScale) * progress;
    origin = activeZoom.origin ?? DEFAULT_ORIGIN;
  }

  return (
    <OffthreadVideo
      src={src}
      trimBefore={trimBeforeFrames}
      durationInFrames={durationInFrames}
      style={{
        width: "100%",
        height: "100%",
        objectFit: "cover",
        transform: `scale(${scale})`,
        transformOrigin: `${origin.x * 100}% ${origin.y * 100}%`,
      }}
    />
  );
};

/**
 * Fuente de hoy: un video ya grabado. Conserva su audio y su rostro.
 * `cuts` elimina tramos (el resto se reacomoda sin huecos); `zooms` aplica
 * punch-ins tipo Ken Burns. Ambos se piensan en el tiempo del video
 * ORIGINAL — igual que `overlays`/`captions` — y es este componente el que
 * traduce eso a dónde cae cada tramo en la salida (ver `engine/timeline.ts`).
 */
export const RecordedVideoSource: React.FC<{
  input: RecordedVideoInput;
  cuts?: Cut[];
  zooms?: ZoomKeyframe[];
}> = ({ input, cuts = [], zooms = [] }) => {
  const { fps } = useVideoConfig();
  const timeline = buildTimeline(input.durationInSeconds, cuts);
  const src = staticFile(input.baseVideo);

  return (
    <>
      {timeline.segments.map((segment) => {
        const from = secondsToFrames(segment.outputStart, fps);
        const to = secondsToFrames(segment.outputEnd, fps);
        const durationInFrames = to - from;

        if (durationInFrames <= 0) {
          return null;
        }

        return (
          <Sequence
            key={`${segment.sourceStart}-${segment.outputStart}`}
            from={from}
            durationInFrames={durationInFrames}
          >
            <TrimmedZoomableVideo
              src={src}
              trimBeforeFrames={secondsToFrames(segment.sourceStart, fps)}
              durationInFrames={durationInFrames}
              sourceStartSeconds={segment.sourceStart}
              zooms={zooms}
              fps={fps}
            />
          </Sequence>
        );
      })}
    </>
  );
};
