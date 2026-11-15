// PRUEBA SIMULADA (nivel 2 de honestidad de evidencia, CLAUDE.md) --
// server/segment-render.mjs + server/segment-assemble.mjs: solo las
// partes puras (armado de argumentos/filtros, planificación de piezas,
// sin ejecutar FFmpeg ni Remotion). La confirmación de que el render
// híbrido funciona de verdad (splicing, cortes fuera de keyframe,
// fuente con FPS variable, verificación de integridad con un tramo
// truncado, sincronía de audio, equivalencia visual frente al render
// completo -- puertas G1/G2-R) vive en test-hybrid-render.mjs (CI,
// Linux real) -- no se puede ejecutar un render real en esta máquina
// de desarrollo (ver README.md).

import { buildPlainPieceFfmpegArgs, computeObjectFitCover, buildObjectFitCoverFilter, canStreamCopyPlainChunks, planPlainChunkPieces, classifyFrameTimingVariability, nativeFpsMatchesDestination } from "./segment-render.mjs";
import { buildAudioFilterComplex, buildTsToMp4ConcatArgs } from "./segment-assemble.mjs";

let failures = 0;
const check = (label, cond, detail = "") => {
  if (!cond) {
    failures++;
    console.log(`FAIL: ${label}${detail ? ` -- ${detail}` : ""}`);
  } else {
    console.log(`ok: ${label}`);
  }
};

// --- computeObjectFitCover / buildObjectFitCoverFilter / canStreamCopyPlainChunks ---

{
  // Misma resolución: identidad, sin filtro.
  check("computeObjectFitCover: misma resolución -- escala 1, sin recorte", JSON.stringify(computeObjectFitCover(1920, 1080, 1920, 1080)) === JSON.stringify({ scaledWidth: 1920, scaledHeight: 1080, cropX: 0, cropY: 0 }));
  check("buildObjectFitCoverFilter: misma resolución -- null (sin filtro, nunca un scale/crop inútil)", buildObjectFitCoverFilter(1920, 1080, 1920, 1080) === null);
  check("canStreamCopyPlainChunks: misma resolución -- true", canStreamCopyPlainChunks(1920, 1080, 1920, 1080) === true);
}

{
  // Mismo aspecto (16:9), tamaño distinto: escala uniforme, sin recorte.
  const cover = computeObjectFitCover(640, 360, 1920, 1080);
  check("computeObjectFitCover: mismo aspecto 16:9, tamaño menor -- escala uniforme a destino exacto, sin recorte", cover.scaledWidth === 1920 && cover.scaledHeight === 1080 && cover.cropX === 0 && cover.cropY === 0, JSON.stringify(cover));
  check("canStreamCopyPlainChunks: resolución distinta -- false (no se puede copiar un flujo y escalar a la vez)", canStreamCopyPlainChunks(640, 360, 1920, 1080) === false);
}

{
  // Misma resolución pero fuente VFR: false -- una copia de flujo no puede normalizar a FPS constante (adenda criterio 3/B).
  check("canStreamCopyPlainChunks: misma resolución pero fuente VFR -- false (la copia no puede normalizar FPS, solo recodificar puede)", canStreamCopyPlainChunks(1920, 1080, 1920, 1080, true) === false);
  check("canStreamCopyPlainChunks: misma resolución, disableStreamCopy sin dar (por defecto false) -- true, comportamiento sin cambios", canStreamCopyPlainChunks(1920, 1080, 1920, 1080) === true);
}

// --- nativeFpsMatchesDestination (adenda criterio 1/3-B, 14-nov-2026 -- causa raíz real de CI: una fuente CFR real puede seguir dando un conteo de cuadros equivocado si su FPS nativo no es el de salida) ---

{
  check("nativeFpsMatchesDestination: 30 contra 30 -- coincide exacto", nativeFpsMatchesDestination(30, 30) === true);
  check("nativeFpsMatchesDestination: 29.97 (NTSC real) contra 30 declarado -- coincide (0,1% de diferencia, puro redondeo)", nativeFpsMatchesDestination(29.97002997002997, 30) === true);
  check("nativeFpsMatchesDestination: 24 contra 30 -- NO coincide (20% de diferencia, el caso real de CI: fuente CFR a 24fps, salida a 30fps)", nativeFpsMatchesDestination(24, 30) === false);
  check("nativeFpsMatchesDestination: 25 contra 30 -- NO coincide (16,7% de diferencia)", nativeFpsMatchesDestination(25, 30) === false);
  check("nativeFpsMatchesDestination: declaredFps nulo -- false, nunca lanza", nativeFpsMatchesDestination(null, 30) === false);
  check("nativeFpsMatchesDestination: destFps cero -- false, nunca lanza", nativeFpsMatchesDestination(30, 0) === false);
}

{
  // Aspecto DISTINTO (fuente 4:3, destino 16:9): object-fit:cover recorta los lados.
  const cover = computeObjectFitCover(1200, 900, 1920, 1080); // fuente 4:3, destino 16:9
  // escala = max(1920/1200, 1080/900) = max(1.6, 1.2) = 1.6 -> escalado 1920x1440, recorte vertical centrado: (1440-1080)/2=180
  check("computeObjectFitCover: aspecto distinto (4:3 -> 16:9) -- escala por el eje que MENOS recorta (1.6x), recorta el otro eje centrado", cover.scaledWidth === 1920 && cover.scaledHeight === 1440 && cover.cropX === 0 && cover.cropY === 180, JSON.stringify(cover));
  const filter = buildObjectFitCoverFilter(1200, 900, 1920, 1080);
  check("buildObjectFitCoverFilter: arma scale+crop con esos valores exactos", filter === "scale=1920:1440:flags=lanczos,crop=1920:1080:0:180", filter);
}

// --- classifyFrameTimingVariability (adenda criterio 1, 14-nov-2026 -- mide, no compara texto) ---

{
  // Caso REAL del VPS, job 1fd239de: declarado 30fps, promedio medido 29,9987fps (0,004% de diferencia) -- puro redondeo del contenedor, NUNCA debe clasificarse como VFR.
  // Simula 300 cuadros (10s) a un intervalo real de 1/29.9987s (en vez de exactamente 1/30s) -- la misma magnitud de desvío que el job real.
  const realIntervalSeconds = 1 / 29.9987;
  const presentationTimes = Array.from({ length: 300 }, (_, i) => i * realIntervalSeconds);
  const result = classifyFrameTimingVariability(presentationTimes, 30);
  check("caso real del VPS (30 declarado vs 29.9987 medido, 0,004% de diferencia): NUNCA se clasifica como VFR (antes, comparando como texto, SIEMPRE salía VFR)", result.isVfr === false, JSON.stringify(result));
  check("caso real del VPS: la fracción irregular es prácticamente 0 (el redondeo del encoder, no una fuente variable)", result.irregularFraction < 0.01, `irregularFraction=${result.irregularFraction}`);
}

{
  // Fuente GENUINAMENTE variable (como el caso B sintético de test-hybrid-render.mjs): la mitad de los intervalos a 1/24s, la otra mitad a 1/30s -- declarado 30fps.
  const presentationTimes = [];
  let t = 0;
  for (let i = 0; i < 120; i++) {
    presentationTimes.push(t);
    t += i < 60 ? 1 / 24 : 1 / 30;
  }
  const result = classifyFrameTimingVariability(presentationTimes, 30);
  check("fuente genuinamente VFR (mitad a 24fps, mitad a 30fps, declarado 30fps): SÍ se clasifica como VFR", result.isVfr === true, JSON.stringify(result));
  check("fuente genuinamente VFR: la fracción irregular es sustancial (~50%, los cuadros a 24fps se desvían ~25% del intervalo esperado a 30fps)", result.irregularFraction > 0.4, `irregularFraction=${result.irregularFraction}`);
}

{
  // Un solo cuadro repetido/perdido AISLADO en 300 (jitter normal de cualquier captura real) -- no debe bastar para marcar VFR (maxIrregularFraction=1% por defecto, esto es 1/299 ≈ 0.33%).
  const baseInterval = 1 / 30;
  const presentationTimes = Array.from({ length: 300 }, (_, i) => i * baseInterval);
  presentationTimes[150] += baseInterval * 0.5; // un solo cuadro con un retraso real de media duración de cuadro -- afecta a los DOS intervalos que lo tocan (el de antes se alarga, el de después se acorta)
  const result = classifyFrameTimingVariability(presentationTimes, 30);
  check("un solo cuadro con jitter aislado (2 de 299 intervalos afectados, ~0.67%): no alcanza el umbral de 1% -- no se clasifica como VFR", result.isVfr === false, JSON.stringify(result));
  check("los DOS intervalos que tocan ese cuadro SÍ se cuentan como irregulares (no se pasan por alto, solo no alcanzan para clasificar toda la fuente)", result.irregularCount === 2, JSON.stringify(result));
}

check("classifyFrameTimingVariability: menos de 2 tiempos de presentación -- nunca VFR, nunca lanza", classifyFrameTimingVariability([1.0], 30).isVfr === false && classifyFrameTimingVariability([], 30).isVfr === false);
check("classifyFrameTimingVariability: sin FPS declarado (null, p.ej. ffprobe no lo pudo determinar) -- nunca VFR por defecto, nunca lanza", classifyFrameTimingVariability([0, 0.033, 0.066], null).isVfr === false);

// --- planPlainChunkPieces ---

{
  // Sin poder copiar (resolución distinta): SIEMPRE una sola pieza recodificada, sin importar los keyframes.
  const { pieces, copiedFraction } = planPlainChunkPieces({ sourceStartSeconds: 10, sourceEndSeconds: 15, keyframeTimes: [10, 11, 12, 13, 14], canStreamCopy: false, fps: 30, expectedTotalFrames: 150 });
  check("sin poder copiar (resolución distinta): 1 sola pieza, recodificada completa", pieces.length === 1 && pieces[0].kind === "reencode" && pieces[0].startSeconds === 10 && pieces[0].endSeconds === 15);
  check("sin poder copiar: copiedFraction=0", copiedFraction === 0);
  check("sin poder copiar: la única pieza lleva TODOS los cuadros esperados (150)", pieces[0].frameCount === 150);
}

{
  // Puede copiar, hay keyframes que encierran un cuerpo grande: 3 piezas (borde+cuerpo+borde). 9.4s * 30fps = 282 cuadros exactos.
  const { pieces, copiedFraction } = planPlainChunkPieces({ sourceStartSeconds: 10.3, sourceEndSeconds: 19.7, keyframeTimes: [9, 11, 15, 19, 21], canStreamCopy: true, fps: 30, expectedTotalFrames: 282 });
  // kStart = primer keyframe >= 10.3 y < 19.7 -> 11. kEnd = último keyframe <= 19.7 y > 10.3 -> 19.
  check("puede copiar: 3 piezas -- borde inicial (10.3-11, recodificado), cuerpo (11-19, copiado), borde final (19-19.7, recodificado)", pieces.length === 3 && pieces[0].kind === "reencode" && pieces[1].kind === "copy" && pieces[2].kind === "reencode", JSON.stringify(pieces));
  check("cuerpo copiado: exactamente 11 a 19 (los dos keyframes que lo encierran)", pieces[1].startSeconds === 11 && pieces[1].endSeconds === 19);
  check("borde inicial: 10.3 a 11 (hasta el primer keyframe)", Math.abs(pieces[0].startSeconds - 10.3) < 1e-9 && pieces[0].endSeconds === 11);
  check("borde final: 19 a 19.7 (desde el último keyframe)", pieces[2].startSeconds === 19 && Math.abs(pieces[2].endSeconds - 19.7) < 1e-9);
  check("copiedFraction: 8s de 9.4s totales copiados sin recodificar (~85%)", Math.abs(copiedFraction - 8 / 9.4) < 1e-9, `copiedFraction=${copiedFraction}`);
  check("los frameCount de las 3 piezas suman EXACTO el total esperado (282), nunca de más ni de menos por redondeo", pieces.reduce((s, p) => s + p.frameCount, 0) === 282, JSON.stringify(pieces.map((p) => p.frameCount)));
  check("la ÚLTIMA pieza absorbe el resto de redondeo (no las del medio) -- borde inicial y cuerpo con su cálculo directo", pieces[0].frameCount === Math.round(0.7 * 30) && pieces[1].frameCount === Math.round(8 * 30));
}

{
  // El corte cae EXACTO en un keyframe en ambos extremos: sin bordes, 1 sola pieza (copia pura, 100%).
  const { pieces, copiedFraction } = planPlainChunkPieces({ sourceStartSeconds: 10, sourceEndSeconds: 20, keyframeTimes: [10, 15, 20], canStreamCopy: true, fps: 30, expectedTotalFrames: 300 });
  check("cortes exactos en keyframes: 1 sola pieza, copiada por completo, 100%", pieces.length === 1 && pieces[0].kind === "copy" && copiedFraction === 1, JSON.stringify(pieces));
  check("cortes exactos en keyframes: la pieza copiada lleva el frameCount EXACTO esperado (300)", pieces[0].frameCount === 300);
}

{
  // Chunk muy corto, sin dos keyframes que lo encierren con un cuerpo de tamaño mínimo: recodifica completo (nunca un cuerpo degenerado).
  const { pieces, copiedFraction } = planPlainChunkPieces({ sourceStartSeconds: 10, sourceEndSeconds: 10.2, keyframeTimes: [9, 15], canStreamCopy: true, fps: 30, expectedTotalFrames: 6, minBodySeconds: 0.5 });
  check("chunk corto sin keyframes propios (el único par encierra menos del mínimo): 1 pieza recodificada completa, nunca un cuerpo degenerado", pieces.length === 1 && pieces[0].kind === "reencode", JSON.stringify(pieces));
  check("sin cuerpo copiable: copiedFraction=0", copiedFraction === 0);
}

{
  // Lista de keyframes vacía (no se pudo sondear): recodifica completo, nunca lanza.
  const { pieces } = planPlainChunkPieces({ sourceStartSeconds: 0, sourceEndSeconds: 5, keyframeTimes: [], canStreamCopy: true, fps: 30, expectedTotalFrames: 150 });
  check("sin keyframes conocidos: 1 pieza recodificada completa, nunca lanza", pieces.length === 1 && pieces[0].kind === "reencode");
}

// --- buildPlainPieceFfmpegArgs ---

{
  const args = buildPlainPieceFfmpegArgs({ sourceVideoPath: "/src.mp4", piece: { kind: "copy", startSeconds: 11, endSeconds: 19 }, outputPath: "/out.ts", destWidth: 1920, destHeight: 1080, srcWidth: 1920, srcHeight: 1080, fps: 30 });
  check("pieza 'copy': -c:v copy (nunca libx264)", args.includes("-c:v") && args[args.indexOf("-c:v") + 1] === "copy");
  check("pieza 'copy': -ss ANTES de -i, con la duración exacta (19-11=8) -- sin frameCount, cae al respaldo por -t", args.indexOf("-ss") < args.indexOf("-i") && args[args.indexOf("-ss") + 1] === "11" && args[args.indexOf("-t") + 1] === "8");
  check("pieza 'copy': salida .ts (mpegts), sin audio", args.includes("-an") && args[args.indexOf("-f") + 1] === "mpegts");
  check("pieza 'copy': SIN -vf (nunca escala/recorta una copia de flujo)", !args.includes("-vf"));
}

{
  // Con frameCount explícito (lo normal -- lo da planPlainChunkPieces): -frames:v EXACTO, nunca -t (inmune al redondeo de punto flotante).
  const args = buildPlainPieceFfmpegArgs({ sourceVideoPath: "/src.mp4", piece: { kind: "copy", startSeconds: 11, endSeconds: 19, frameCount: 240 }, outputPath: "/out.ts", destWidth: 1920, destHeight: 1080, srcWidth: 1920, srcHeight: 1080, fps: 30 });
  check("pieza con frameCount: usa -frames:v con el valor EXACTO, nunca -t", args.includes("-frames:v") && args[args.indexOf("-frames:v") + 1] === "240" && !args.includes("-t"));
}

{
  const args = buildPlainPieceFfmpegArgs({ sourceVideoPath: "/src.mp4", piece: { kind: "reencode", startSeconds: 4, endSeconds: 6.5 }, outputPath: "/out.ts", destWidth: 1920, destHeight: 1080, srcWidth: 1200, srcHeight: 900, fps: 30, crf: 20, preset: "fast", gopSize: 60 });
  check("pieza 'reencode': -c:v libx264 con crf/preset dados", args[args.indexOf("-c:v") + 1] === "libx264" && args[args.indexOf("-crf") + 1] === "20" && args[args.indexOf("-preset") + 1] === "fast");
  check("pieza 'reencode': -vf con el filtro object-fit:cover (resoluciones distintas)", args[args.indexOf("-vf") + 1] === "scale=1920:1440:flags=lanczos,crop=1920:1080:0:180");
  check("pieza 'reencode': -r normaliza a FPS constante (fuente con FPS variable)", args[args.indexOf("-r") + 1] === "30");
  check("pieza 'reencode': -g con el mismo GOP que los tramos compuestos", args[args.indexOf("-g") + 1] === "60");
  check("pieza 'reencode': -bf 0 (sin B-frames -- un borde puede ser de 1-2 cuadros, muy corto para la profundidad de B-frames por defecto)", args[args.indexOf("-bf") + 1] === "0");
  check("pieza 'reencode': salida .ts (mpegts), sin audio", args.includes("-an") && args[args.indexOf("-f") + 1] === "mpegts");
}

{
  const args = buildPlainPieceFfmpegArgs({ sourceVideoPath: "/src.mp4", piece: { kind: "reencode", startSeconds: 0, endSeconds: 1 }, outputPath: "/out.ts", destWidth: 1920, destHeight: 1080, srcWidth: 1920, srcHeight: 1080, fps: 30 });
  check("pieza 'reencode' con resolución YA IGUAL al destino: sin -vf (buildObjectFitCoverFilter da null)", !args.includes("-vf"));
}

// --- buildTsToMp4ConcatArgs: remux final SIN recodificar (adenda criterio 1) ---

{
  const args = buildTsToMp4ConcatArgs({ inputPath: "/joined.ts", outputPath: "/final.mp4" });
  check("buildTsToMp4ConcatArgs: +genpts+igndts (tolera discontinuidades de PTS/DTS entre tramos, ya concatenados a nivel de bytes)", args[args.indexOf("-fflags") + 1] === "+genpts+igndts");
  check("buildTsToMp4ConcatArgs: -c:v copy (NUNCA recodifica -- adenda criterio 1)", args[args.indexOf("-c:v") + 1] === "copy");
  check("buildTsToMp4ConcatArgs: salida .mp4", args.includes("mp4"));
}

// --- buildAudioFilterComplex (sin cambios de comportamiento, se conserva) ---

{
  const timeline = { segments: [{ sourceStart: 0, sourceEnd: 4 }, { sourceStart: 6, sourceEnd: 10 }], outputDurationInSeconds: 8 };
  const filter = buildAudioFilterComplex(timeline);
  check("buildAudioFilterComplex: un atrim por tramo SOBREVIVIENTE (2 tramos -> 2 atrim)", (filter.match(/atrim/g) ?? []).length === 2);
  check("buildAudioFilterComplex: los límites de cada atrim son los del tramo real (0-4 y 6-10, NUNCA el original completo)", filter.includes("atrim=start=0:end=4") && filter.includes("atrim=start=6:end=10"));
  check("buildAudioFilterComplex: concat con n=2 (un tramo por segmento sobreviviente)", filter.includes("concat=n=2:v=0:a=1[aout]"));
}

check("buildAudioFilterComplex: sin ningún tramo sobreviviente (línea de tiempo vacía) -> null, nunca un filtro vacío/inválido", buildAudioFilterComplex({ segments: [] }) === null);

console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
process.exit(failures === 0 ? 0 : 1);
