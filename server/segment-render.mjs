// Render híbrido (Fase 0, 11-nov-2026 / 14-nov-2026, autorizado por
// Alex) -- DETRÁS DE LA BANDERA RENDER_MODE=hybrid (ver
// segment-planner.mjs#decideRenderMode); el camino de producción
// (render completo) sigue siendo el de siempre mientras esa bandera
// esté apagada (adenda criterio F).
//
// Dado un chunk de `segment-planner.mjs#planChunks`, lo renderiza a UN
// ARCHIVO .ts (MPEG-TS, sin contenedor con índice/duración propia) --
// el formato intermedio que la documentación oficial de render
// distribuido de Remotion prescribe para unir tramos h264 sin
// artefactos:
//
// - "plain" (solo video fuente): adenda criterio 2 -- COPIA DE FLUJO
//   en los GOP completos, recodificación exacta SOLO en los bordes
//   (el tramo entre el punto de corte pedido y el keyframe más
//   cercano). Ver `planPlainChunkPieces`. Si el video fuente no tiene
//   la MISMA resolución que el destino, no se puede copiar sin volver
//   a codificar (una copia de flujo no puede escalar/recortar
//   píxeles) -- en ese caso el chunk completo se recodifica, nunca se
//   copia a medias con la resolución equivocada (ver
//   `buildObjectFitCoverFilter`).
// - "composite" (con zoom, overlay, recurso o subtítulo quemado): con
//   Remotion real (`runRemotionRender`), `--codec=h264-ts` (MPEG-TS,
//   confirmado contra la documentación oficial de render distribuido:
//   "if you want to render with h264... set the codec to h264-ts
//   instead"), con los MISMOS `crf`/`x264Preset`/`gopSize` que los
//   bordes recodificados de los tramos planos.
//
// Ambos se renderizan SIN audio (`-an`/`--muted`) -- el audio final se
// construye UNA sola vez desde el video fuente completo
// (server/segment-assemble.mjs).
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { runRemotionRender } from "./render-worker.mjs";
import { ensureRenderBundle } from "./render-bundle.mjs";
import { concatTsFiles } from "./segment-assemble.mjs";
import { parseFrameRateFraction } from "./video-normalization.mjs";
import { hasMemoryHeadroomForAnotherTask, readContainerMemoryLimitBytes } from "./container-metrics.mjs";

const execFileAsync = promisify(execFile);

/**
 * Clasifica si una fuente es de FPS variable MIDIENDO los intervalos
 * reales entre cuadros consecutivos (en tiempo de PRESENTACIÓN, no de
 * decodificación) contra el intervalo que el `declaredFps` predice --
 * pura, para poder probarla con datos hechos a mano.
 *
 * Causa raíz real con evidencia del VPS, 14-nov-2026 (adenda del
 * auditor): la versión anterior comparaba `r_frame_rate` y
 * `avg_frame_rate` COMO TEXTO ("30/1" vs "4959480/165323") -- el job
 * real 1fd239de midió 29,9987fps de promedio contra 30fps declarado
 * (0,004% de diferencia, puro redondeo del contenedor de
 * duración/cuadros, NO una fuente genuinamente variable), pero como
 * las cadenas de texto nunca son iguales, TODO job real quedaba
 * marcado como VFR -- desactivando la copia de GOP siempre, sin
 * excepción. Medir el intervalo REAL de cada cuadro es la comparación
 * que de verdad importa: una fuente CFR tiene cuadros a intervalos
 * prácticamente idénticos (solo el redondeo del encoder, <1% típico);
 * una fuente VFR genuina (como la sintética de prueba, que mezcla
 * 24fps y 30fps) tiene MUCHOS intervalos que se desvían ~20-25% del
 * esperado.
 *
 * `toleranceFraction` (15% por defecto): cuánto puede desviarse UN
 * intervalo del esperado antes de contarlo como "irregular" -- muy por
 * encima del 0,004% de ruido real medido en el job 1fd239de, muy por
 * debajo del ~20-25% que muestra una mezcla real de 24/30fps.
 * `maxIrregularFraction` (1% por defecto): qué fracción de los
 * intervalos puede ser irregular antes de clasificar la fuente entera
 * como VFR -- tolera algún cuadro repetido/perdido aislado (normal en
 * cualquier captura real) sin marcar como VFR una fuente que en
 * realidad es CFR.
 */
export const classifyFrameTimingVariability = (sortedPresentationTimes, declaredFps, { toleranceFraction = 0.15, maxIrregularFraction = 0.01 } = {}) => {
  if (!Array.isArray(sortedPresentationTimes) || sortedPresentationTimes.length < 2 || !declaredFps || declaredFps <= 0) {
    return { isVfr: false, irregularCount: 0, totalIntervals: 0, irregularFraction: 0, expectedIntervalSeconds: declaredFps > 0 ? 1 / declaredFps : null };
  }
  const expectedIntervalSeconds = 1 / declaredFps;
  let irregularCount = 0;
  for (let i = 1; i < sortedPresentationTimes.length; i++) {
    const delta = sortedPresentationTimes[i] - sortedPresentationTimes[i - 1];
    const deviation = Math.abs(delta - expectedIntervalSeconds) / expectedIntervalSeconds;
    if (deviation > toleranceFraction) irregularCount++;
  }
  const totalIntervals = sortedPresentationTimes.length - 1;
  const irregularFraction = totalIntervals > 0 ? Math.round((irregularCount / totalIntervals) * 10000) / 10000 : 0;
  return { isVfr: irregularFraction > maxIrregularFraction, irregularCount, totalIntervals, irregularFraction, expectedIntervalSeconds };
};

/**
 * `true` si el FPS NATIVO medido de la fuente coincide con el FPS de
 * SALIDA -- pura. `toleranceFraction` (2% por defecto) tolera solo el
 * redondeo real de fracciones NTSC (29,97 vs 30 difiere ~0,1%); una
 * fuente genuinamente de otro FPS (24 vs 30 difiere ~20%, 25 vs 30
 * ~16,7%) queda fuera de ese margen.
 *
 * Causa raíz real con evidencia de CI, 14-nov-2026 (segunda corrida de
 * esta tarea): el caso B de prueba (fuente real, con evidencia de
 * `classifyFrameTimingVariability`, de FPS CONSTANTE -- 0,48% de
 * intervalos irregulares, muy por debajo del umbral de VFR) seguía
 * dando un conteo de cuadros equivocado (110 donde se esperaban 120)
 * al copiarse sin recodificar, porque su FPS nativo real (24fps) no
 * es el mismo que el FPS de salida del motor (30fps) -- una copia de
 * flujo preserva los cuadros REALES del archivo tal cual existen,
 * nunca los re-muestrea a otro FPS; solo `-r <fps>` (una
 * recodificación) hace esa conversión. "FPS variable" y "FPS nativo
 * distinto al de salida" son dos causas DISTINTAS del mismo síntoma
 * -- un chunk copiado puede tener el conteo de cuadros equivocado por
 * cualquiera de las dos, y las dos se miden y registran por separado.
 */
export const nativeFpsMatchesDestination = (declaredFps, destFps, toleranceFraction = 0.02) => {
  if (!declaredFps || declaredFps <= 0 || !destFps || destFps <= 0) return false;
  return Math.abs(declaredFps - destFps) / destFps <= toleranceFraction;
};

/**
 * Mide de verdad si un tramo plano de esta fuente se puede copiar sin
 * volver a codificar -- MIDE la distribución real de tiempos de
 * presentación de los paquetes de video (ver
 * `classifyFrameTimingVariability`) Y si el FPS nativo coincide con
 * el de salida (ver `nativeFpsMatchesDestination`), no compara texto
 * ni asume que ambos FPS son iguales. Los paquetes de
 * `ffprobe -show_packets` llegan en orden de DECODIFICACIÓN, no de
 * presentación (confirmado real, igual que en
 * `source-video-diagnostics.mjs`: con B-frames, el pts_time de un
 * paquete puede ser MENOR que el del paquete anterior en la lista) --
 * por eso se ORDENAN antes de medir los intervalos.
 *
 * Fail-safe INVERTIDO respecto a la primera versión de esto (causa
 * raíz real con evidencia de CI, 14-nov-2026): si el sondeo falla o no
 * se puede medir, esto devuelve `true` (DESACTIVAR la copia de flujo)
 * -- no `false`. La razón: el único efecto de esta bandera es decidir
 * si es seguro copiar GOPs sin recodificar; `verifyChunkIntegrity` SÍ
 * atrapa después un conteo de cuadros equivocado, pero ahí ya es
 * demasiado tarde -- no hay una recodificación de respaldo automática,
 * el chunk entero falla y lanza. El camino seguro ante cualquier duda
 * es recodificar (más caro, siempre correcto), nunca copiar a ciegas.
 *
 * Deja constancia en el log SIEMPRE (no solo cuando desactiva la
 * copia) -- observabilidad real desde Portainer de qué midió y por
 * qué decidió lo que decidió.
 */
export const probeSourceDisablesStreamCopy = async (ffprobePath, env, sourceVideoPath, destFps, onLog = () => {}) => {
  try {
    const { stdout: rateOut } = await execFileAsync(ffprobePath, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", sourceVideoPath], { env });
    const declaredFps = parseFrameRateFraction(rateOut.trim());
    const { stdout: packetsOut } = await execFileAsync(
      ffprobePath,
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time", "-of", "json", sourceVideoPath],
      { env, maxBuffer: 64 * 1024 * 1024 },
    );
    const presentationTimes = (JSON.parse(packetsOut).packets ?? [])
      .map((p) => Number(p.pts_time))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    const classification = classifyFrameTimingVariability(presentationTimes, declaredFps);
    const fpsMatches = nativeFpsMatchesDestination(declaredFps, destFps);
    const disable = classification.isVfr || !fpsMatches;
    onLog(
      `medición de FPS de la fuente: declaredFps=${declaredFps ?? "?"} fpsDeSalida=${destFps} coincideConSalida=${fpsMatches} intervalos=${classification.totalIntervals} irregulares=${classification.irregularCount} (${(classification.irregularFraction * 100).toFixed(2)}%) variable=${classification.isVfr} -> ${disable ? "se recodifica completo" : "copia de flujo habilitada"}.`,
    );
    return disable;
  } catch (err) {
    onLog(`no se pudo medir el FPS real de la fuente (${err.message ?? err}) -- por seguridad se recodifica completo en vez de copiar a ciegas.`);
    return true;
  }
};

/**
 * Réplica EXACTA (pura) del CSS `object-fit: cover` que usa
 * `RecordedVideoSource.tsx` para posicionar el video fuente dentro del
 * canvas de salida -- escala al tamaño MÍNIMO que cubre el destino por
 * completo (preserva aspecto, nunca estira) y recorta el sobrante
 * centrado. Si la fuente ya tiene exactamente la resolución de
 * destino, da escala 1 y recorte nulo (identidad). Devuelve
 * `{ scaledWidth, scaledHeight, cropX, cropY }` -- nunca ejecuta nada.
 */
export const computeObjectFitCover = (srcWidth, srcHeight, destWidth, destHeight) => {
  const scale = Math.max(destWidth / srcWidth, destHeight / srcHeight);
  const scaledWidth = Math.round(srcWidth * scale);
  const scaledHeight = Math.round(srcHeight * scale);
  return {
    scaledWidth,
    scaledHeight,
    cropX: Math.max(0, Math.round((scaledWidth - destWidth) / 2)),
    cropY: Math.max(0, Math.round((scaledHeight - destHeight) / 2)),
  };
};

/** Filtro `-vf` que reproduce `computeObjectFitCover` -- pura. `null` si la fuente ya es exactamente el destino (sin filtro -- nunca un `scale`/`crop` de 1:1 inútil). */
export const buildObjectFitCoverFilter = (srcWidth, srcHeight, destWidth, destHeight) => {
  if (srcWidth === destWidth && srcHeight === destHeight) return null;
  const { scaledWidth, scaledHeight, cropX, cropY } = computeObjectFitCover(srcWidth, srcHeight, destWidth, destHeight);
  return `scale=${scaledWidth}:${scaledHeight}:flags=lanczos,crop=${destWidth}:${destHeight}:${cropX}:${cropY}`;
};

/**
 * `true` si un tramo plano se puede copiar sin volver a codificar
 * píxeles -- solo cuando la fuente YA tiene la resolución exacta de
 * destino (una copia de flujo no puede escalar/recortar) Y
 * `disableStreamCopy` es falso (ver `probeSourceDisablesStreamCopy`:
 * fuente de FPS variable, o FPS nativo distinto al de salida -- en
 * cualquiera de los dos casos un GOP copiado puede tener un conteo de
 * cuadros real distinto de `duración×fps_destino`, sin forma de
 * corregirlo sin recodificar; confirmado real en CI con AMBAS causas
 * por separado). Pura.
 */
export const canStreamCopyPlainChunks = (srcWidth, srcHeight, destWidth, destHeight, disableStreamCopy = false) => srcWidth === destWidth && srcHeight === destHeight && !disableStreamCopy;

/**
 * Cuadros clave (keyframes) del video fuente dentro de una ventana
 * (con margen) -- usa `-read_intervals` de ffprobe para no escanear el
 * archivo completo por cada chunk de un job largo. Devuelve los
 * tiempos de presentación (segundos) en orden, o `[]` si no se pudo
 * determinar ninguno.
 */
export const probeKeyframeTimesInWindow = async (ffprobePath, env, sourceVideoPath, { windowStartSeconds, windowEndSeconds, marginSeconds = 2 }) => {
  const start = Math.max(0, windowStartSeconds - marginSeconds);
  const end = windowEndSeconds + marginSeconds;
  const { stdout } = await execFileAsync(
    ffprobePath,
    ["-v", "error", "-select_streams", "v:0", "-read_intervals", `${start}%${end}`, "-show_entries", "packet=pts_time,flags", "-of", "json", sourceVideoPath],
    { env, maxBuffer: 32 * 1024 * 1024 },
  );
  const packets = JSON.parse(stdout).packets ?? [];
  return packets
    .filter((p) => typeof p.flags === "string" && p.flags.startsWith("K") && p.pts_time !== "N/A" && p.pts_time !== undefined)
    .map((p) => Number(p.pts_time))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
};

/**
 * Decide cómo partir un tramo plano en piezas -- pura (adenda criterio
 * 2: "copia de flujo en los GOP completos, recodificación exacta solo
 * en los bordes"). `keyframeTimes` ya acotados a la ventana del chunk
 * (ver `probeKeyframeTimesInWindow`). Si `canStreamCopy` es falso
 * (resolución distinta al destino) o no hay dos keyframes que encierren
 * un cuerpo de al menos `minBodySeconds`, el chunk entero se recodifica
 * (una sola pieza) -- nunca se copia una porción con la resolución
 * equivocada ni se arma un cuerpo degenerado de duración casi nula.
 *
 * Cada pieza lleva, además de `startSeconds`/`endSeconds`, un
 * `frameCount` EXACTO (entero) -- causa raíz real con evidencia de CI,
 * 14-nov-2026: los puntos de keyframe vienen de `ffprobe` como
 * segundos de punto flotante (p.ej. con un GOP de 29 cuadros a 30fps,
 * 29/30 = 0,9666... -- un decimal que no termina); restar dos de esos
 * valores y pasarle el resultado a `-t` como duración podía arrastrar
 * un error de redondeo de punto flotante que hacía que FFmpeg
 * incluyera o descartara UN cuadro de más/menos justo en el borde. Los
 * `frameCount` de abajo se calculan en espacio de CUADROS (enteros) y
 * SIEMPRE suman exactamente `expectedTotalFrames` -- el último
 * trozo absorbe cualquier resto de redondeo. `buildPlainPieceFfmpegArgs`
 * usa `-frames:v <frameCount>` en vez de `-t <duración>` -- inmune a
 * ese redondeo.
 */
export const planPlainChunkPieces = ({ sourceStartSeconds, sourceEndSeconds, keyframeTimes, canStreamCopy, fps, expectedTotalFrames, minBodySeconds = 0.5 }) => {
  const totalDuration = sourceEndSeconds - sourceStartSeconds;
  const wholeChunkReencode = () => ({ pieces: [{ kind: "reencode", startSeconds: sourceStartSeconds, endSeconds: sourceEndSeconds, frameCount: expectedTotalFrames }], copiedFraction: 0 });
  if (!canStreamCopy || totalDuration <= 0) return wholeChunkReencode();

  const kStart = keyframeTimes.find((t) => t >= sourceStartSeconds - 1e-6 && t < sourceEndSeconds);
  const kEndCandidates = keyframeTimes.filter((t) => t <= sourceEndSeconds + 1e-6 && t > sourceStartSeconds);
  const kEnd = kEndCandidates.length > 0 ? kEndCandidates[kEndCandidates.length - 1] : undefined;
  if (kStart === undefined || kEnd === undefined || kEnd - kStart < minBodySeconds) return wholeChunkReencode();

  const rawPieces = [];
  if (kStart - sourceStartSeconds > 1e-6) rawPieces.push({ kind: "reencode", startSeconds: sourceStartSeconds, endSeconds: kStart });
  rawPieces.push({ kind: "copy", startSeconds: kStart, endSeconds: kEnd });
  if (sourceEndSeconds - kEnd > 1e-6) rawPieces.push({ kind: "reencode", startSeconds: kEnd, endSeconds: sourceEndSeconds });

  let framesAssigned = 0;
  const pieces = rawPieces.map((p, i) => {
    const isLast = i === rawPieces.length - 1;
    const frameCount = isLast ? expectedTotalFrames - framesAssigned : Math.round((p.endSeconds - p.startSeconds) * fps);
    framesAssigned += frameCount;
    return { ...p, frameCount };
  });
  return { pieces, copiedFraction: (kEnd - kStart) / totalDuration };
};

/** Argumentos de FFmpeg para UNA pieza de un chunk plano -- pura. `-ss` ANTES de `-i`: con copia de flujo cae en el keyframe exacto (por diseño, `startSeconds` ya es un keyframe real para piezas "copy"); con recodificación da el cuadro exacto aunque no caiga en un keyframe (el decodificador arranca antes y descarta lo sobrante). */
export const buildPlainPieceFfmpegArgs = ({ sourceVideoPath, piece, outputPath, destWidth, destHeight, srcWidth, srcHeight, fps, crf = 18, preset = "medium", gopSize }) => {
  // `-frames:v` (cuadros EXACTOS) en vez de `-t` (duración en
  // segundos) cuando se conoce `frameCount` -- inmune al redondeo de
  // punto flotante de un intervalo de keyframes que no es un decimal
  // exacto (ver el comentario grande de `planPlainChunkPieces`).
  const cutoffArgs = typeof piece.frameCount === "number" ? ["-frames:v", String(piece.frameCount)] : ["-t", String(Math.max(0, piece.endSeconds - piece.startSeconds))];
  const base = ["-y", "-ss", String(piece.startSeconds), "-i", sourceVideoPath, ...cutoffArgs, "-an"];
  if (piece.kind === "copy") {
    return [...base, "-c:v", "copy", "-f", "mpegts", outputPath];
  }
  const filter = buildObjectFitCoverFilter(srcWidth, srcHeight, destWidth, destHeight);
  return [
    ...base,
    ...(filter ? ["-vf", filter] : []),
    "-r",
    String(fps),
    "-c:v",
    "libx264",
    "-preset",
    preset,
    "-crf",
    String(crf),
    // `-bf 0` (sin B-frames) -- causa raíz real con evidencia de CI,
    // 14-nov-2026: un borde recodificado puede ser muy corto (a veces
    // 1-2 cuadros, lo que sobra hasta el keyframe más cercano); con
    // los B-frames por defecto de libx264 (bf=3), un GOP de solo 1-2
    // cuadros no alcanza a acomodar la reordenación que exige esa
    // profundidad de B-frames, y el encoder termina escribiendo un
    // DTS inválido para ese tramo ("Application provided invalid,
    // non monotonically increasing dts") -- confirmado real probando
    // con varias banderas de tolerancia en el LECTOR (sin efecto, el
    // defecto nace en este encode) y aislado a esta pieza específica.
    // Sin B-frames, cada cuadro decodifica en el mismo orden en que
    // se presenta -- nunca hay nada que reordenar, sin importar cuán
    // corta sea la pieza.
    "-bf",
    "0",
    ...(gopSize ? ["-g", String(gopSize)] : []),
    "-pix_fmt",
    "yuv420p",
    "-f",
    "mpegts",
    outputPath,
  ];
};

/** Renderiza un chunk PLANO completo a un .ts -- una o varias piezas (copia + bordes recodificados), unidas sin recodificar de nuevo. Devuelve metadata de evidencia (fracción copiada, piezas). */
export const renderPlainChunk = async ({ ffmpegPath, ffprobePath, env, sourceVideoPath, chunk, outputPath, destWidth, destHeight, srcWidth, srcHeight, fps, crf, preset, gopSize, disableStreamCopy = false, workDir, onLog = () => {} }) => {
  // `disableStreamCopy` se mide UNA SOLA VEZ por job (en
  // `renderAllChunks`), nunca por chunk -- medirlo acá escanearía
  // TODOS los paquetes del video fuente completo por cada tramo plano
  // del job (para el job real de 23 min, 41.331 cuadros, repetido una
  // vez por cada uno de sus tramos planos -- caro y completamente
  // redundante, el resultado es el mismo archivo fuente siempre).
  const canCopy = canStreamCopyPlainChunks(srcWidth, srcHeight, destWidth, destHeight, disableStreamCopy);
  let keyframeTimes = [];
  if (canCopy) {
    try {
      keyframeTimes = await probeKeyframeTimesInWindow(ffprobePath, env, sourceVideoPath, { windowStartSeconds: chunk.sourceStartSeconds, windowEndSeconds: chunk.sourceEndSeconds });
    } catch (err) {
      onLog(`no se pudieron sondear keyframes para el tramo plano (se recodifica completo): ${err.message ?? err}`);
    }
  }
  const expectedTotalFrames = chunk.frames ?? chunk.outputEndFrame - chunk.outputStartFrame;
  const { pieces, copiedFraction } = planPlainChunkPieces({ sourceStartSeconds: chunk.sourceStartSeconds, sourceEndSeconds: chunk.sourceEndSeconds, keyframeTimes, canStreamCopy: canCopy, fps, expectedTotalFrames });

  if (pieces.length === 1) {
    const args = buildPlainPieceFfmpegArgs({ sourceVideoPath, piece: pieces[0], outputPath, destWidth, destHeight, srcWidth, srcHeight, fps, crf, preset, gopSize });
    await execFileAsync(ffmpegPath, args, { env, maxBuffer: 16 * 1024 * 1024 });
    return { outputPath, pieces, copiedFraction, args };
  }

  await fs.mkdir(workDir, { recursive: true });
  const pieceOutputs = [];
  for (let i = 0; i < pieces.length; i++) {
    const piecePath = `${workDir}/piece-${i}.ts`;
    const args = buildPlainPieceFfmpegArgs({ sourceVideoPath, piece: pieces[i], outputPath: piecePath, destWidth, destHeight, srcWidth, srcHeight, fps, crf, preset, gopSize });
    await execFileAsync(ffmpegPath, args, { env, maxBuffer: 16 * 1024 * 1024 });
    pieceOutputs.push({ path: piecePath, durationSeconds: pieces[i].endSeconds - pieces[i].startSeconds });
  }
  await concatTsFiles({ entries: pieceOutputs, outputPath });
  onLog(`tramo plano: ${(copiedFraction * 100).toFixed(1)}% copiado sin recodificar (${pieces.length} pieza(s): ${pieces.map((p) => p.kind).join("+")}).`);
  return { outputPath, pieces, copiedFraction };
};

/**
 * Renderiza un chunk COMPUESTO con Remotion real, restringido a su
 * rango de cuadros, a MPEG-TS (`--codec=h264-ts`, prescrito por la
 * documentación de render distribuido para unir con tramos h264), con
 * los mismos `crf`/`x264Preset`/`gopSize` que los bordes recodificados
 * de los tramos planos (adenda criterio 2). `entryPoint` (si se da) usa
 * un bundle ya construido -- ver render-bundle.mjs, criterio 4.
 */
export const renderCompositeChunk = ({ cwd, env, propsJobFile, outputPath, chunk, concurrency = "1", enableMultiprocessOnLinux, browserExecutable, binariesDirectory, entryPoint, crf, preset, gopSize, timeoutMs = 120_000, onLog = () => {} }) =>
  runRemotionRender({
    cwd,
    env,
    outputPath,
    propsJobFile,
    concurrency,
    enableMultiprocessOnLinux,
    browserExecutable,
    binariesDirectory,
    entryPoint,
    frames: `${chunk.outputStartFrame}-${chunk.outputEndFrame - 1}`,
    muted: true,
    codec: "h264-ts",
    crf,
    x264Preset: preset,
    gopSize,
    timeoutMs,
    onLog,
  });

/**
 * Verificación de integridad de un chunk YA renderizado (adenda
 * criterio C: "el archivo existe" no basta). Comprueba, EN ESTE ORDEN:
 * (1) decodificación COMPLETA sin errores (`ffmpeg -v error -i ... -c:v
 * rawvideo -f null -` -- confirmado real en CI, 14-nov-2026 con
 * `ffmpeg -muxers`/`-encoders` del binario REAL: el muxer `null` SÍ
 * está compilado, pero el modismo habitual `-f null -` (sin codec
 * explícito) falla porque intenta auto-elegir el encoder
 * `wrapped_avframe`, que NO está compilado ("Default encoder...
 * probably disabled"); dando el codec explícitamente (`rawvideo`, que
 * SÍ está compilado como encoder aunque "rawvideo" no exista como
 * MUXER -- son cosas distintas) se evita esa auto-selección.
 * Cualquier línea en stderr o código != 0 es un fallo real -- un .ts
 * truncado a mitad de un paquete produce exactamente esto); (2)
 * conteo EXACTO de paquetes de video (`ffprobe -show_packets`, el
 * MISMO mecanismo ya probado real en `source-video-diagnostics.mjs`
 * para contar keyframes -- confirmado real en CI, 14-nov-2026, que
 * `-count_frames`/`nb_read_frames` da `NaN` en estos .ts cortos de
 * este build; un paquete de video h264 es un cuadro, así que contar
 * paquetes es exacto aquí) contra `expectedFrames`. `-fflags +genpts`
 * en la pasada de decodificación evita un falso error de "dts no
 * monótono" que puede salir al re-decodificar un .ts armado por
 * `concatTsFiles` (tramos con PTS/DTS propios, normal en MPEG-TS) sin
 * que eso sea corrupción real. El checksum (SHA-256 del archivo) se
 * calcula siempre que el archivo se pueda leer, incluso si la
 * verificación falla -- queda como evidencia de QUÉ bytes exactos
 * fallaron, útil para depurar sin volver a correr nada.
 */
export const verifyChunkIntegrity = async ({ ffmpegPath, ffprobePath, env, filePath, expectedFrames }) => {
  let checksum = null;
  try {
    checksum = crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
  } catch (err) {
    return { ok: false, reason: `no se pudo leer el archivo (${err.message ?? err})`, checksum: null, actualFrames: null };
  }

  let decodeError = null;
  await new Promise((resolve) => {
    // `+igndts` (criterio B/3, 14-nov-2026): confirmado real en CI que
    // `+genpts` solo no basta para un .ts armado por `concatTsFiles` a
    // partir de piezas copiadas de una fuente VFR -- el demuxer puede
    // entregar DTS genuinamente no-monótono entre piezas (normal al
    // copiar flujo de un origen VFR, no indica corrupción), y el
    // muxer de verificación lo rechazaba. `+igndts` le dice a FFmpeg
    // que ignore esos DTS del demuxer y reconstruya solo desde PTS.
    const child = spawn(ffmpegPath, ["-v", "error", "-fflags", "+genpts+igndts", "-nostdin", "-i", filePath, "-an", "-c:v", "rawvideo", "-f", "null", "-"], { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (c) => {
      stderr = (stderr + c.toString("utf8")).slice(-2000);
    });
    child.on("error", (err) => {
      decodeError = String(err?.message ?? err);
      resolve();
    });
    child.on("close", (code) => {
      if (code !== 0 || stderr.trim().length > 0) decodeError = stderr.trim() || `ffmpeg salió con code=${code}`;
      resolve();
    });
  });
  if (decodeError) return { ok: false, reason: `decodificación incompleta o con errores: ${decodeError}`, checksum, actualFrames: null };

  let actualFrames = null;
  try {
    const { stdout } = await execFileAsync(
      ffprobePath,
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=flags", "-of", "json", filePath],
      { env, maxBuffer: 16 * 1024 * 1024 },
    );
    actualFrames = (JSON.parse(stdout).packets ?? []).length;
  } catch (err) {
    return { ok: false, reason: `no se pudo contar cuadros decodificados (${err.message ?? err})`, checksum, actualFrames: null };
  }

  if (actualFrames !== expectedFrames) {
    return { ok: false, reason: `cuadros decodificados (${actualFrames}) != cuadros esperados (${expectedFrames})`, checksum, actualFrames };
  }
  return { ok: true, reason: null, checksum, actualFrames };
};

/**
 * Renderiza TODOS los chunks de un plan (en orden, uno por uno) y
 * devuelve, por chunk, la ruta del .ts y un registro de evidencia
 * listo para `segments[]` del estado del job (adenda criterio 5/C).
 *
 * REANUDABLE CON VERIFICACIÓN DE INTEGRIDAD (adenda criterio C,
 * 14-nov-2026): un archivo final que YA EXISTE solo se reutiliza si
 * `verifyChunkIntegrity` lo confirma -- decodificación completa sin
 * errores Y conteo exacto de cuadros. Un archivo truncado o corrupto
 * (p.ej. el proceso murió a mitad de la escritura) se detecta ahí, se
 * BORRA, y el chunk se vuelve a renderizar desde cero -- nunca se
 * reutiliza algo que no pasó la verificación. Cada chunk se escribe
 * primero a `.tmp.ts` y se renombra atómicamente al nombre final solo
 * si terminó bien (mismo patrón que `atomic-json-store.mjs`).
 *
 * `onSegment(record)` se llama después de CADA chunk (reusado o
 * nuevo) -- quien llama puede persistir `segments[]` incrementalmente
 * en el estado del job sin esperar a que termine todo el plan.
 */
export const renderAllChunks = async ({
  plan,
  chunkOutputDir,
  sourceVideoPath,
  propsJobFile,
  ffmpegPath,
  ffprobePath,
  env,
  cwd,
  destWidth,
  destHeight,
  srcWidth,
  srcHeight,
  fps,
  concurrency,
  enableMultiprocessOnLinux,
  browserExecutable,
  binariesDirectory,
  entryPoint,
  crf,
  preset,
  gopSize,
  timeoutMs,
  // Criterio 4 (adenda, 14-nov-2026): los tramos PLANOS (FFmpeg) corren
  // EN PARALELO con los tramos COMPUESTOS (Remotion/Chrome) cuando el
  // plan tiene de ambos -- la medición real del VPS mostró 55,6% de CPU
  // promedio del límite de 4 núcleos (holgura real, no supuesta) y que
  // hoy corrían en serie (la suma de los tiempos individuales
  // coincidía con el tiempo total). `false` para volver al
  // comportamiento secuencial anterior si hiciera falta.
  parallelPlainWithComposite = true,
  // Compuerta de memoria (criterio 3, adenda): antes de arrancar CADA
  // tramo plano EN PARALELO (nunca para los compuestos, que siguen
  // uno a la vez como siempre), se mide la memoria ANÓNIMA real del
  // contenedor (sin caché de archivos reclamable) contra su límite
  // real -- si no hay margen, se espera en vez de arrancar un proceso
  // más encima de un contenedor ya ajustado. `cgroupRoot` solo para
  // pruebas; en producción es siempre `/sys/fs/cgroup`.
  cgroupRoot = "/sys/fs/cgroup",
  onLog = () => {},
  onSegment = () => {},
}) => {
  // Medido UNA SOLA VEZ por job (nunca por chunk -- ver el comentario
  // grande de `renderPlainChunk`).
  const disableStreamCopy = await probeSourceDisablesStreamCopy(ffprobePath, env, sourceVideoPath, fps, onLog);

  const memoryLimitBytes = await readContainerMemoryLimitBytes(cgroupRoot);

  const results = new Array(plan.chunks.length);
  let firstError = null;

  const processChunk = async (i) => {
    const chunk = plan.chunks[i];
    const outputPath = `${chunkOutputDir}/chunk-${String(i).padStart(4, "0")}-${chunk.type}.ts`;
    const expectedFrames = chunk.frames ?? chunk.outputEndFrame - chunk.outputStartFrame;

    const existing = await fs
      .access(outputPath)
      .then(() => true)
      .catch(() => false);
    if (existing) {
      const verification = await verifyChunkIntegrity({ ffmpegPath, ffprobePath, env, filePath: outputPath, expectedFrames });
      if (verification.ok) {
        onLog(`chunk ${i + 1}/${plan.chunks.length} (${chunk.type}): ya estaba completo y VERIFICADO (checksum ${verification.checksum.slice(0, 12)}...) -- no se vuelve a renderizar.`);
        return { index: i, type: chunk.type, outputStartFrame: chunk.outputStartFrame, outputEndFrame: chunk.outputEndFrame, path: outputPath, status: "done", reused: true, checksum: verification.checksum, verifiedAt: new Date().toISOString() };
      }
      onLog(`chunk ${i + 1}/${plan.chunks.length} (${chunk.type}): el archivo existente NO pasó la verificación de integridad (${verification.reason}) -- se descarta y se vuelve a renderizar.`);
      await fs.rm(outputPath, { force: true });
    }

    const tmpOutputPath = outputPath.replace(/\.ts$/, ".tmp.ts");
    onLog(`chunk ${i + 1}/${plan.chunks.length} (${chunk.type}): cuadros ${chunk.outputStartFrame}-${chunk.outputEndFrame - 1}, fuente ${chunk.sourceStartSeconds}s-${chunk.sourceEndSeconds}s`);
    const startedAt = Date.now();
    let renderDetail = null;
    try {
      if (chunk.type === "plain") {
        renderDetail = await renderPlainChunk({ ffmpegPath, ffprobePath, env, sourceVideoPath, chunk, outputPath: tmpOutputPath, destWidth, destHeight, srcWidth, srcHeight, fps, crf, preset, gopSize, disableStreamCopy, workDir: `${chunkOutputDir}/pieces-${i}`, onLog });
      } else {
        renderDetail = await renderCompositeChunk({ cwd, env, propsJobFile, outputPath: tmpOutputPath, chunk, concurrency, enableMultiprocessOnLinux, browserExecutable, binariesDirectory, entryPoint, crf, preset, gopSize, timeoutMs, onLog });
      }
    } catch (err) {
      await fs.rm(tmpOutputPath, { force: true }).catch(() => {});
      throw Object.assign(err, { segmentRecord: { index: i, type: chunk.type, outputStartFrame: chunk.outputStartFrame, outputEndFrame: chunk.outputEndFrame, path: null, status: "error", reused: false, error: String(err.message ?? err) } });
    }
    const renderMs = Date.now() - startedAt;

    const verification = await verifyChunkIntegrity({ ffmpegPath, ffprobePath, env, filePath: tmpOutputPath, expectedFrames });
    if (!verification.ok) {
      await fs.rm(tmpOutputPath, { force: true }).catch(() => {});
      const reason = `recién renderizado pero no pasó la verificación de integridad: ${verification.reason}`;
      throw Object.assign(new Error(reason), { segmentRecord: { index: i, type: chunk.type, outputStartFrame: chunk.outputStartFrame, outputEndFrame: chunk.outputEndFrame, path: null, status: "error", reused: false, error: reason } });
    }
    await fs.rename(tmpOutputPath, outputPath);
    return { index: i, type: chunk.type, outputStartFrame: chunk.outputStartFrame, outputEndFrame: chunk.outputEndFrame, path: outputPath, status: "done", reused: false, checksum: verification.checksum, renderMs, startupMs: renderDetail?.startupMs ?? null, copiedFraction: renderDetail?.copiedFraction ?? null, verifiedAt: new Date().toISOString() };
  };

  const plainIndices = [];
  const compositeIndices = [];
  plan.chunks.forEach((c, i) => (c.type === "plain" ? plainIndices : compositeIndices).push(i));
  const runInParallel = parallelPlainWithComposite && plainIndices.length > 0 && compositeIndices.length > 0;

  const waitForMemoryHeadroom = async () => {
    if (!memoryLimitBytes) return;
    for (let attempt = 0; attempt < 30 && !firstError; attempt++) {
      if (await hasMemoryHeadroomForAnotherTask({ cgroupRoot, memoryLimitBytes })) return;
      onLog(`memoria del contenedor cerca del límite -- se espera antes de arrancar el siguiente tramo plano en paralelo con el compuesto en curso.`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  };

  const runQueue = async (indices, { gateOnMemory = false } = {}) => {
    for (const i of indices) {
      if (firstError) return;
      if (gateOnMemory) await waitForMemoryHeadroom();
      if (firstError) return;
      try {
        results[i] = await processChunk(i);
        onSegment(results[i]);
      } catch (err) {
        if (err.segmentRecord) {
          results[i] = err.segmentRecord;
          onSegment(results[i]);
        }
        if (!firstError) firstError = err;
        return;
      }
    }
  };

  if (runInParallel) {
    onLog(`ejecutando ${plainIndices.length} tramo(s) plano(s) (FFmpeg) EN PARALELO con ${compositeIndices.length} tramo(s) compuesto(s) (Remotion).`);
    await Promise.all([runQueue(plainIndices, { gateOnMemory: true }), runQueue(compositeIndices)]);
  } else {
    await runQueue(plan.chunks.map((_, i) => i));
  }

  if (firstError) throw firstError;
  return results;
};

export { ensureRenderBundle };
