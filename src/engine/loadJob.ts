import { staticFile } from "remotion";
import type { EngineJob } from "../types";

export const loadJob = async (jobFile: string): Promise<EngineJob> => {
  const response = await fetch(staticFile(jobFile));

  if (!response.ok) {
    throw new Error(
      `No se pudo cargar el trabajo "${jobFile}" (HTTP ${response.status}).`,
    );
  }

  const job = (await response.json()) as EngineJob;

  if (
    !job.channel ||
    !job.destination ||
    !job.input ||
    !job.input.type ||
    !Array.isArray(job.overlays)
  ) {
    throw new Error(
      `El trabajo "${jobFile}" no tiene el formato esperado (channel, destination, input, overlays).`,
    );
  }

  return job;
};
