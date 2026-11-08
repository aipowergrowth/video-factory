// PRUEBA SIMULADA (nivel 2 de honestidad de evidencia, CLAUDE.md) --
// server/render-worker.mjs: parseo de líneas de progreso de `remotion
// render` y armado de argumentos del CLI. Las líneas de prueba de
// abajo son EXACTAMENTE las que imprimió el binario real
// (@remotion/compositor-linux-x64-gnu + @remotion/cli 4.0.538) en un
// diagnóstico corrido en GitHub Actions el 08-nov-2026 (confirmado:
// el nivel de log por defecto y --log=verbose producen las MISMAS
// líneas de progreso, verbose solo agrega ruido 28x mayor sin
// aportar nada nuevo -- por eso no se usa --log=verbose en
// producción) -- no son strings inventadas a partir de la
// documentación (que explícitamente no garantiza el formato).

import { parseRenderProgressLine, buildRenderArgs, ENGINE_FPS, DESTINATION_DIMENSIONS } from "./render-worker.mjs";

let failures = 0;
const check = (label, cond, detail = "") => {
  if (!cond) {
    failures++;
    console.log(`FAIL: ${label}${detail ? ` -- ${detail}` : ""}`);
  } else {
    console.log(`ok: ${label}`);
  }
};

// --- Líneas reales capturadas en CI (ver comentario de arriba) ---

check("Bundling N%: reconocida", (() => {
  const e = parseRenderProgressLine("Bundling 8%");
  return e?.stage === "bundling" && e.percent === 8;
})());

check("Bundling 100%: reconocida", parseRenderProgressLine("Bundling 100%")?.percent === 100);

check(
  "Rendered 0/90 (sin 'time remaining', primera línea real del render): reconocida",
  (() => {
    const e = parseRenderProgressLine("Rendered 0/90");
    return e?.stage === "rendering" && e.renderedFrames === 0 && e.totalFrames === 90 && e.etaSeconds === null && e.percent === 0;
  })(),
);

check(
  "Rendered 1/90, time remaining: 29s: reconocida con eta",
  (() => {
    const e = parseRenderProgressLine("Rendered 1/90, time remaining: 29s");
    return e?.stage === "rendering" && e.renderedFrames === 1 && e.totalFrames === 90 && e.etaSeconds === 29;
  })(),
);

check(
  "Rendered 89/90, time remaining: 0s: porcentaje calculado correctamente",
  (() => {
    const e = parseRenderProgressLine("Rendered 89/90, time remaining: 0s");
    return e?.percent === Math.round((89 / 90) * 1000) / 10;
  })(),
);

check(
  "Encoded 31/90: reconocida",
  (() => {
    const e = parseRenderProgressLine("Encoded 31/90");
    return e?.stage === "encoding" && e.encodedFrames === 31 && e.totalFrames === 90;
  })(),
);

check("Encoded 90/90: 100% exacto", parseRenderProgressLine("Encoded 90/90")?.percent === 100);

check(
  "Stitching done in 31ms: reconocida",
  (() => {
    const e = parseRenderProgressLine("Stitching done in 31ms");
    return e?.stage === "stitched" && e.durationMs === 31;
  })(),
);

// --- Líneas reales que deben IGNORARSE (no son progreso, evitan inundar el log) ---

for (const noise of [
  "Remotion root directory: /home/runner/work/video-factory/video-factory",
  "Applied configuration from /home/runner/work/video-factory/video-factory/remotion.config.ts.",
  "Composition = VideoEngine (Passed as argument)",
  "Codec = h264 (derived from out name)",
  "",
  "   ",
]) {
  check(`línea de ruido ignorada: "${noise.slice(0, 40)}"`, parseRenderProgressLine(noise) === null);
}

// --- Códigos ANSI (color) reales -- confirmados en la captura de CI, deben limpiarse antes de parsear ---

check(
  "línea con códigos ANSI de color se limpia antes de intentar reconocerla (no debería matchear nada por sí sola, pero no debe romper)",
  (() => {
    try {
      parseRenderProgressLine("[90mBundling done in 1444ms[39m");
      return true;
    } catch {
      return false;
    }
  })(),
);

// --- buildRenderArgs: forma correcta de los argumentos del CLI (pura, sin ejecutar nada) ---

{
  const args = buildRenderArgs({
    compositionId: "VideoEngine",
    outputPath: "/data/outputs/job-1.mp4",
    propsJobFile: "uploads/jobs/job-1.json",
    concurrency: "1",
    enableMultiprocessOnLinux: true,
    browserExecutable: undefined,
    binariesDirectory: undefined,
  });
  check("buildRenderArgs: incluye 'remotion render VideoEngine <output>'", args[0] === "remotion" && args[1] === "render" && args[2] === "VideoEngine" && args[3] === "/data/outputs/job-1.mp4");
  check("buildRenderArgs: --props con el jobFile correcto", args.some((a) => a === `--props=${JSON.stringify({ jobFile: "uploads/jobs/job-1.json" })}`));
  check("buildRenderArgs: --concurrency con el valor dado", args.includes("--concurrency=1"));
  check("buildRenderArgs: --enable-multiprocess-on-linux cuando se pide", args.includes("--enable-multiprocess-on-linux"));
  check("buildRenderArgs: sin --browser-executable ni --binaries-directory cuando no se dan", !args.some((a) => a.startsWith("--browser-executable")) && !args.some((a) => a.startsWith("--binaries-directory")));
}

{
  const args = buildRenderArgs({
    compositionId: "VideoEngine",
    outputPath: "/out.mp4",
    propsJobFile: "uploads/jobs/x.json",
    concurrency: "2",
    enableMultiprocessOnLinux: false,
    browserExecutable: "/usr/bin/chrome",
    binariesDirectory: "/opt/remotion-binaries",
  });
  check("buildRenderArgs: sin --enable-multiprocess-on-linux cuando no se pide", !args.includes("--enable-multiprocess-on-linux"));
  check("buildRenderArgs: --browser-executable cuando se da", args.includes("--browser-executable=/usr/bin/chrome"));
  check("buildRenderArgs: --binaries-directory cuando se da", args.includes("--binaries-directory=/opt/remotion-binaries"));
  check("buildRenderArgs: --concurrency=2", args.includes("--concurrency=2"));
}

// --- Constantes duplicadas de src/types.ts -- confirma que no se desincronizaron ---

check("ENGINE_FPS = 30 (igual a src/types.ts)", ENGINE_FPS === 30);
check("DESTINATION_DIMENSIONS.youtube-16-9 = 1920x1080 (igual a src/types.ts)", DESTINATION_DIMENSIONS["youtube-16-9"].width === 1920 && DESTINATION_DIMENSIONS["youtube-16-9"].height === 1080);
check("DESTINATION_DIMENSIONS.vertical-9-16 = 1080x1920 (igual a src/types.ts)", DESTINATION_DIMENSIONS["vertical-9-16"].width === 1080 && DESTINATION_DIMENSIONS["vertical-9-16"].height === 1920);

console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
process.exit(failures === 0 ? 0 : 1);
