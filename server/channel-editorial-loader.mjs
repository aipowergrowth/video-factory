// Carga de la guía editorial de un canal -- extraído de server/index.mjs
// (24-feb/03-nov-2026) para poder probar la resolución
// sin-layout/con-layout/layout-inexistente sin levantar el servidor
// (mismo patrón que atomic-json-store.mjs/video-normalization.mjs: toda
// lógica testable vive en su propio módulo chico).
//
// Resolución (sin cambios de comportamiento respecto a la versión
// anterior, solo extraída): si `layout` viene y existe
// `editorial-guidelines.<layout>.md` para ese canal, se usa esa; si no
// (sin layout, o un layout sin archivo propio -- cae al mismo archivo
// general), se usa `editorial-guidelines.md`. El perfil de recursos y
// el historial de correcciones nunca dependen de `layout`.
import fsp from "node:fs/promises";
import path from "node:path";

export const loadChannelEditorialContext = async (projectRoot, channel, layout) => {
  const channelDir = path.join(projectRoot, "public/channels", channel);
  const guidelines =
    (layout &&
      (await fsp
        .readFile(path.join(channelDir, `editorial-guidelines.${layout}.md`), "utf8")
        .catch(() => null))) ??
    (await fsp.readFile(path.join(channelDir, "editorial-guidelines.md"), "utf8").catch(() => null));
  const resourceProfile = await fsp
    .readFile(path.join(channelDir, "editorial-profile.json"), "utf8")
    .then(JSON.parse)
    .catch(() => null);
  const correctionsHistory = await fsp
    .readFile(path.join(channelDir, "editorial-corrections.json"), "utf8")
    .then(JSON.parse)
    .catch(() => []);
  return { guidelines, resourceProfile, correctionsHistory };
};
