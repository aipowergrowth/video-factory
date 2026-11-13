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

import { parseRenderProgressLine, parseEtaString, buildRenderArgs, shouldConsiderStuck, ENGINE_FPS, DESTINATION_DIMENSIONS } from "./render-worker.mjs";

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

// --- Corrección 09-nov-2026 (causa raíz con evidencia, criterio 1):
// el parser viejo descartaba la línea ENTERA de "Rendered" cuando el
// tiempo restante superaba 1 minuto (ancla `$` pegada a `(\d+)s`, sin
// aceptar "Xm Ys" ni "Xh Ym Zs"). Líneas de abajo tomadas tal cual del
// stdoutTail REAL del job 1fd239de-8f9e-4642-8e42-d848b17d8481
// (evidencia leída por GET /jobs/:id, imagen 7ae8596) más una
// combinación con horas, construida siguiendo el formato CONFIRMADO
// contra el código fuente real instalado
// (node_modules/@remotion/cli/dist/eta-string.js#formatEtaString,
// @remotion/cli@4.0.538 -- el mismo binario de producción) -- nunca
// se asumió el formato por la documentación, que no lo garantiza. ---

check(
  "Rendered 37457/41331, time remaining: 19s (línea real del job 1fd239de): reconocida igual que antes",
  (() => {
    const e = parseRenderProgressLine("Rendered 37457/41331, time remaining: 19s");
    return e?.stage === "rendering" && e.renderedFrames === 37457 && e.totalFrames === 41331 && e.etaSeconds === 19;
  })(),
);

check(
  "Rendered 37457/41331, time remaining: 18m 24s (línea real del job 1fd239de -- ANTES se descartaba la línea entera): ahora reconocida",
  (() => {
    const e = parseRenderProgressLine("Rendered 37457/41331, time remaining: 18m 24s");
    return e?.stage === "rendering" && e.renderedFrames === 37457 && e.totalFrames === 41331 && e.etaSeconds === 18 * 60 + 24 && e.percent === Math.round((37457 / 41331) * 1000) / 10;
  })(),
);

check(
  "Rendered 5/41331, time remaining: 1h 2m 3s (con horas, formato confirmado contra el código fuente real de @remotion/cli -- ANTES también se descartaba): ahora reconocida",
  (() => {
    const e = parseRenderProgressLine("Rendered 5/41331, time remaining: 1h 2m 3s");
    return e?.stage === "rendering" && e.renderedFrames === 5 && e.totalFrames === 41331 && e.etaSeconds === 3600 + 2 * 60 + 3;
  })(),
);

check(
  "Rendered 5/41331, time remaining: 1h 3s (horas sin minutos -- el minuto se OMITE cuando es 0, confirmado contra el código fuente): reconocida",
  (() => {
    const e = parseRenderProgressLine("Rendered 5/41331, time remaining: 1h 3s");
    return e?.stage === "rendering" && e.etaSeconds === 3600 + 3;
  })(),
);

check(
  "Rendered 37511/41331, time remaining: 18m 20s (última línea real vista en el job 1fd239de antes del timeout a los 180 min): avance correcto (90.8%)",
  (() => {
    const e = parseRenderProgressLine("Rendered 37511/41331, time remaining: 18m 20s");
    return e?.renderedFrames === 37511 && e?.totalFrames === 41331 && Math.abs(e.percent - 90.8) < 0.05;
  })(),
);

check(
  "Un formato de tiempo restante FUTURO/desconocido (p.ej. con días) nunca se descarta el evento -- avance correcto, etaSeconds en null",
  (() => {
    const e = parseRenderProgressLine("Rendered 100/41331, time remaining: 2d 3h 4m 5s");
    return e?.stage === "rendering" && e.renderedFrames === 100 && e.totalFrames === 41331 && e.etaSeconds === null;
  })(),
);

// --- parseEtaString: pura, probada exhaustivamente aparte del parser de líneas completo ---

check("parseEtaString: solo segundos ('19s') -> 19", parseEtaString("19s") === 19);
check("parseEtaString: minutos y segundos ('18m 24s') -> 1104", parseEtaString("18m 24s") === 18 * 60 + 24);
check("parseEtaString: horas, minutos y segundos ('1h 2m 3s') -> 3723", parseEtaString("1h 2m 3s") === 3723);
check("parseEtaString: horas sin minutos ('1h 3s') -> 3603 (el minuto se omite cuando es 0)", parseEtaString("1h 3s") === 3603);
check("parseEtaString: '0s' -> 0 (nunca null solo porque el valor sea cero)", parseEtaString("0s") === 0);
check("parseEtaString: formato irreconocible (futuro cambio de Remotion, p.ej. con días) -> null, nunca lanza", parseEtaString("2d 3h 4m 5s") === null && parseEtaString("algo raro") === null);

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

{
  // frames/logLevel: SOLO para el render de diagnóstico (criterio 3, 09-nov-2026) -- undefined = sin bandera, igual que antes, nunca afecta un render real de producción.
  const normalArgs = buildRenderArgs({ compositionId: "VideoEngine", outputPath: "/out.mp4", propsJobFile: "uploads/jobs/x.json", concurrency: "1" });
  check("buildRenderArgs: sin frames/logLevel, no agrega --frames ni --log (comportamiento de producción sin cambios)", !normalArgs.some((a) => a.startsWith("--frames")) && !normalArgs.some((a) => a.startsWith("--log")));

  const diagArgs = buildRenderArgs({
    compositionId: "VideoEngine",
    outputPath: "/out.mp4",
    propsJobFile: "uploads/jobs/x.json",
    concurrency: "1",
    frames: "0-29,20650-20679",
    logLevel: "verbose",
  });
  check("buildRenderArgs: --frames con el rango exacto dado", diagArgs.includes("--frames=0-29,20650-20679"));
  check("buildRenderArgs: --log=verbose cuando se pide", diagArgs.includes("--log=verbose"));
  check("buildRenderArgs: sin muted/codec, no agrega --muted ni --codec (comportamiento de producción sin cambios)", !normalArgs.some((a) => a.startsWith("--muted")) && !normalArgs.some((a) => a.startsWith("--codec")));

  const selectiveArgs = buildRenderArgs({
    compositionId: "VideoEngine",
    outputPath: "/out.mp4",
    propsJobFile: "uploads/jobs/x.json",
    concurrency: "1",
    muted: true,
    codec: "h264-ts",
  });
  check("buildRenderArgs: --muted cuando se pide (render selectivo, criterio 6)", selectiveArgs.includes("--muted"));
  check("buildRenderArgs: --codec=h264-ts cuando se pide", selectiveArgs.includes("--codec=h264-ts"));
}

// --- Constantes duplicadas de src/types.ts -- confirma que no se desincronizaron ---

check("ENGINE_FPS = 30 (igual a src/types.ts)", ENGINE_FPS === 30);
check("DESTINATION_DIMENSIONS.youtube-16-9 = 1920x1080 (igual a src/types.ts)", DESTINATION_DIMENSIONS["youtube-16-9"].width === 1920 && DESTINATION_DIMENSIONS["youtube-16-9"].height === 1080);
check("DESTINATION_DIMENSIONS.vertical-9-16 = 1080x1920 (igual a src/types.ts)", DESTINATION_DIMENSIONS["vertical-9-16"].width === 1080 && DESTINATION_DIMENSIONS["vertical-9-16"].height === 1920);

// --- shouldConsiderStuck: criterio REDISEÑADO del vigilante (Fase 0,
// causa raíz con evidencia, 09-nov-2026, criterio 6) -- exhaustivo
// con datos simulados, sin necesitar un proceso real para cada
// combinación (eso vive en test-render-observability.mjs, con
// procesos reales en Linux). ---

check(
  "progreso todavía no está añejo (msSinceLastProgress < stuckAfterMs): nunca se considera trabado, sea cual sea la CPU",
  shouldConsiderStuck({ msSinceLastProgress: 60_000, stuckAfterMs: 600_000, cpuTicksDelta: 0 }) === false &&
    shouldConsiderStuck({ msSinceLastProgress: 60_000, stuckAfterMs: 600_000, cpuTicksDelta: null }) === false,
);

check(
  "progreso añejo + CPU medida SIN ningún tick nuevo (0): SÍ se considera trabado (inactividad real, coincide con el issue público de Remotion)",
  shouldConsiderStuck({ msSinceLastProgress: 600_000, stuckAfterMs: 600_000, cpuTicksDelta: 0 }) === true,
);

check(
  "progreso añejo + CPU medida CON al menos 1 tick nuevo: NO se considera trabado -- 'lento, no colgado' (inicialización legítima)",
  shouldConsiderStuck({ msSinceLastProgress: 600_000, stuckAfterMs: 600_000, cpuTicksDelta: 1 }) === false &&
    shouldConsiderStuck({ msSinceLastProgress: 900_000, stuckAfterMs: 600_000, cpuTicksDelta: 5000 }) === false,
);

check(
  "progreso añejo + CPU no se pudo medir (null -- sin /proc, o aún sin segunda lectura): se mantiene la capacidad de cortar (fail-safe hacia CORTAR, no hacia esperar para siempre)",
  shouldConsiderStuck({ msSinceLastProgress: 600_000, stuckAfterMs: 600_000, cpuTicksDelta: null }) === true,
);

check(
  "borde exacto: msSinceLastProgress === stuckAfterMs ya cuenta como 'añejo' (>=, no solo >)",
  shouldConsiderStuck({ msSinceLastProgress: 600_000, stuckAfterMs: 600_000, cpuTicksDelta: 0 }) === true,
);

console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
process.exit(failures === 0 ? 0 : 1);
