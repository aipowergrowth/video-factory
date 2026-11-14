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

const execFileAsync = promisify(execFile);

/**
 * `true` si la fuente declara un FPS que no coincide con su FPS
 * promedio real -- mismo criterio ya usado y probado en
 * `source-video-diagnostics.mjs#probeSourceVideoDiagnostics`
 * (`likelyVfr`), repetido acá liviano (sin el escaneo de paquetes que
 * hace esa función para contar keyframes, innecesario aquí) para no
 * acoplar este módulo a esa función de diagnóstico. `false` si no se
 * pudo determinar (nunca bloquea la copia de flujo por un fallo de
 * sondeo -- el riesgo real, si la fuente SÍ fuera VFR, lo atrapa
 * `verifyChunkIntegrity` de todos modos).
 */
export const probeSourceIsVfr = async (ffprobePath, env, sourceVideoPath) => {
  try {
    const { stdout } = await execFileAsync(ffprobePath, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate,avg_frame_rate", "-of", "csv=p=0", sourceVideoPath], { env });
    const [rFrameRate, avgFrameRate] = stdout.trim().split(",");
    return Boolean(rFrameRate) && Boolean(avgFrameRate) && rFrameRate !== avgFrameRate;
  } catch {
    return false;
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
 * destino (una copia de flujo no puede escalar/recortar) Y la fuente
 * NO es de FPS variable. Pura.
 *
 * La condición de FPS (adenda criterio 3/B, causa raíz real con
 * evidencia de CI, 14-nov-2026): una copia de flujo preserva los
 * cuadros EXACTOS que existen en ese tramo del archivo original, sin
 * ninguna oportunidad de normalizar -- `-r <fps>` (la forma en que
 * este motor normaliza una fuente VFR a una salida de FPS constante)
 * es una opción de SALIDA que solo aplica cuando se está
 * RECODIFICANDO; una copia de flujo no decodifica nada, así que no
 * hay dónde insertar esa normalización. Si la fuente es VFR, un GOP
 * copiado puede tener MENOS (o más) cuadros reales que
 * `duración×fps_objetivo`, sin forma de corregirlo sin recodificar --
 * confirmado real en CI: un chunk de una fuente VFR dio 110 cuadros
 * reales donde se esperaban 120. Para una fuente VFR, TODO el tramo
 * plano se recodifica (más caro, pero el único camino correcto); la
 * optimización de copia de GOP (criterio 2) solo aplica a fuentes de
 * FPS constante.
 */
export const canStreamCopyPlainChunks = (srcWidth, srcHeight, destWidth, destHeight, sourceIsVfr = false) => srcWidth === destWidth && srcHeight === destHeight && !sourceIsVfr;

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
export const renderPlainChunk = async ({ ffmpegPath, ffprobePath, env, sourceVideoPath, chunk, outputPath, destWidth, destHeight, srcWidth, srcHeight, fps, crf, preset, gopSize, workDir, onLog = () => {} }) => {
  const sourceIsVfr = await probeSourceIsVfr(ffprobePath, env, sourceVideoPath);
  if (sourceIsVfr) onLog("fuente con FPS variable detectada -- el tramo plano se recodifica completo (la copia de flujo no puede normalizar a FPS constante, solo recodificar puede).");
  const canCopy = canStreamCopyPlainChunks(srcWidth, srcHeight, destWidth, destHeight, sourceIsVfr);
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
export const renderAllChunks = async ({ plan, chunkOutputDir, sourceVideoPath, propsJobFile, ffmpegPath, ffprobePath, env, cwd, destWidth, destHeight, srcWidth, srcHeight, fps, concurrency, enableMultiprocessOnLinux, browserExecutable, binariesDirectory, entryPoint, crf, preset, gopSize, timeoutMs, onLog = () => {}, onSegment = () => {} }) => {
  const results = [];
  for (let i = 0; i < plan.chunks.length; i++) {
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
        const record = { index: i, type: chunk.type, outputStartFrame: chunk.outputStartFrame, outputEndFrame: chunk.outputEndFrame, path: outputPath, status: "done", reused: true, checksum: verification.checksum, verifiedAt: new Date().toISOString() };
        results.push(record);
        onSegment(record);
        continue;
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
        renderDetail = await renderPlainChunk({ ffmpegPath, ffprobePath, env, sourceVideoPath, chunk, outputPath: tmpOutputPath, destWidth, destHeight, srcWidth, srcHeight, fps, crf, preset, gopSize, workDir: `${chunkOutputDir}/pieces-${i}`, onLog });
      } else {
        renderDetail = await renderCompositeChunk({ cwd, env, propsJobFile, outputPath: tmpOutputPath, chunk, concurrency, enableMultiprocessOnLinux, browserExecutable, binariesDirectory, entryPoint, crf, preset, gopSize, timeoutMs, onLog });
      }
    } catch (err) {
      await fs.rm(tmpOutputPath, { force: true }).catch(() => {});
      const record = { index: i, type: chunk.type, outputStartFrame: chunk.outputStartFrame, outputEndFrame: chunk.outputEndFrame, path: null, status: "error", reused: false, error: String(err.message ?? err) };
      results.push(record);
      onSegment(record);
      throw err;
    }
    const renderMs = Date.now() - startedAt;

    const verification = await verifyChunkIntegrity({ ffmpegPath, ffprobePath, env, filePath: tmpOutputPath, expectedFrames });
    if (!verification.ok) {
      await fs.rm(tmpOutputPath, { force: true }).catch(() => {});
      const record = { index: i, type: chunk.type, outputStartFrame: chunk.outputStartFrame, outputEndFrame: chunk.outputEndFrame, path: null, status: "error", reused: false, error: `recién renderizado pero no pasó la verificación de integridad: ${verification.reason}` };
      results.push(record);
      onSegment(record);
      throw new Error(record.error);
    }
    await fs.rename(tmpOutputPath, outputPath);
    const record = { index: i, type: chunk.type, outputStartFrame: chunk.outputStartFrame, outputEndFrame: chunk.outputEndFrame, path: outputPath, status: "done", reused: false, checksum: verification.checksum, renderMs, startupMs: renderDetail?.startupMs ?? null, copiedFraction: renderDetail?.copiedFraction ?? null, verifiedAt: new Date().toISOString() };
    results.push(record);
    onSegment(record);
  }
  return results;
};

export { ensureRenderBundle };
