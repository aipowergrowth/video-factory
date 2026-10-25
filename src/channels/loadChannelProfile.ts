import { staticFile } from "remotion";
import type { ChannelProfile } from "../types";

export const loadChannelProfile = async (
  channel: string,
): Promise<ChannelProfile> => {
  const path = `channels/${channel}/profile.json`;
  const response = await fetch(staticFile(path));

  if (!response.ok) {
    throw new Error(
      `No se encontró el perfil del canal "${channel}" en public/${path} (HTTP ${response.status}).`,
    );
  }

  const profile = (await response.json()) as ChannelProfile;

  if (!profile.channelId || !profile.theme) {
    throw new Error(
      `El perfil del canal "${channel}" no tiene el formato esperado (channelId, theme).`,
    );
  }

  return profile;
};
