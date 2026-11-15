// PRUEBA SIMULADA (nivel 2 de honestidad de evidencia, CLAUDE.md) --
// server/video-compare.mjs: solo las funciones PURAS (sin ejecutar
// FFmpeg). La confirmación de que el emparejamiento por tiempo de
// presentación (`-r <fps>` forzado en ambas decodificaciones) y el
// desglose por tramo/empalme funcionan de verdad contra un render real
// vive en test-hybrid-render.mjs (CI, Linux real).

import { psnrFromMse, computeFramePsnr, summarizePsnrSeries, summarizePsnrByChunks } from "./video-compare.mjs";

let failures = 0;
const check = (label, cond, detail = "") => {
  if (!cond) {
    failures++;
    console.log(`FAIL: ${label}${detail ? ` -- ${detail}` : ""}`);
  } else {
    console.log(`ok: ${label}`);
  }
};

// --- psnrFromMse ---

check("psnrFromMse: error cuadrático 0 -> Infinity (cuadros idénticos)", psnrFromMse(0) === Infinity);
check("psnrFromMse: fórmula estándar con maxValue=255 (mse=1 -> 10*log10(65025) ≈ 48.13dB)", Math.abs(psnrFromMse(1) - 48.13) < 0.01, String(psnrFromMse(1)));
check("psnrFromMse: mse más alto -> PSNR más bajo", psnrFromMse(100) < psnrFromMse(1));

// --- computeFramePsnr ---

{
  const a = Buffer.from([10, 20, 30, 40]);
  const b = Buffer.from([10, 20, 30, 40]);
  check("computeFramePsnr: cuadros idénticos -> Infinity", computeFramePsnr(a, b) === Infinity);
}
{
  const a = Buffer.from([0, 0, 0, 0]);
  const b = Buffer.from([10, 10, 10, 10]);
  const psnr = computeFramePsnr(a, b);
  check("computeFramePsnr: diferencia uniforme de 10 por byte -> un PSNR finito y razonable", Number.isFinite(psnr) && psnr > 0 && psnr < 50, String(psnr));
}
check("computeFramePsnr: tamaños distintos -> null (nunca compara cosas de tamaño diferente)", computeFramePsnr(Buffer.from([1, 2]), Buffer.from([1, 2, 3])) === null);
check("computeFramePsnr: buffers vacíos -> null", computeFramePsnr(Buffer.from([]), Buffer.from([])) === null);

// --- summarizePsnrSeries ---

{
  const summary = summarizePsnrSeries([40, 35, Infinity, 30]);
  check("summarizePsnrSeries: framesCompared cuenta TODOS los valores, incluidos los idénticos", summary.framesCompared === 4);
  check("summarizePsnrSeries: identicalFrames cuenta solo los Infinity", summary.identicalFrames === 1);
  check("summarizePsnrSeries: averagePsnr es el promedio de los NO idénticos (40+35+30)/3=35", summary.averagePsnr === 35);
  check("summarizePsnrSeries: minPsnr es el peor cuadro FINITO (30, nunca Infinity aunque sea 'mejor')", summary.minPsnr === 30);
}
check("summarizePsnrSeries: serie vacía -> todo null, nunca NaN ni un número inventado", JSON.stringify(summarizePsnrSeries([])) === JSON.stringify({ framesCompared: 0, identicalFrames: 0, averagePsnr: null, minPsnr: null }));
check("summarizePsnrSeries: TODOS idénticos -> averagePsnr=minPsnr=Infinity (igual que reporta FFmpeg, nunca 0 falso)", summarizePsnrSeries([Infinity, Infinity]).averagePsnr === Infinity && summarizePsnrSeries([Infinity, Infinity]).minPsnr === Infinity);

// --- summarizePsnrByChunks (adenda criterio 2, 14-nov-2026: "PSNR por tramo y en cada empalme") ---

{
  // 3 tramos de 10 cuadros cada uno (plano, compuesto, plano) -- valores PSNR por cuadro conocidos de antemano.
  const values = [
    ...Array(10).fill(40), // tramo 0 (plano): todo 40dB
    ...Array(10).fill(30), // tramo 1 (compuesto): todo 30dB
    ...Array(10).fill(40), // tramo 2 (plano): todo 40dB
  ];
  const chunks = [
    { type: "plain", outputStartFrame: 0, outputEndFrame: 10 },
    { type: "composite", outputStartFrame: 10, outputEndFrame: 20 },
    { type: "plain", outputStartFrame: 20, outputEndFrame: 30 },
  ];
  const { byChunk, byBoundary } = summarizePsnrByChunks(values, chunks, { boundaryMarginFrames: 3 });
  check("summarizePsnrByChunks: un resumen por tramo (3 tramos -> 3 entradas)", byChunk.length === 3);
  check("summarizePsnrByChunks: el PSNR de cada tramo es el de SUS PROPIOS cuadros (40, 30, 40 -- no un promedio global que los mezcle)", byChunk[0].averagePsnr === 40 && byChunk[1].averagePsnr === 30 && byChunk[2].averagePsnr === 40, JSON.stringify(byChunk));
  check("summarizePsnrByChunks: cada entrada de byChunk lleva su tipo y rango de cuadros", byChunk[1].type === "composite" && byChunk[1].outputStartFrame === 10 && byChunk[1].outputEndFrame === 20);
  check("summarizePsnrByChunks: un resumen por EMPALME (2 fronteras entre 3 tramos -> 2 entradas)", byBoundary.length === 2);
  check("summarizePsnrByChunks: el empalme en el cuadro 10 (plano->compuesto) usa una ventana ±3 cuadros alrededor (7-13)", byBoundary[0].boundaryFrame === 10 && byBoundary[0].windowStart === 7 && byBoundary[0].windowEnd === 13, JSON.stringify(byBoundary[0]));
  check("summarizePsnrByChunks: ese empalme mezcla los dos lados (40 y 30) -- su promedio queda ENTRE los dos, nunca igual a ninguno de los dos tramos puros", byBoundary[0].averagePsnr > 30 && byBoundary[0].averagePsnr < 40, JSON.stringify(byBoundary[0]));
  check("summarizePsnrByChunks: fromType/toType identifican qué tramos se tocan en ese empalme", byBoundary[0].fromType === "plain" && byBoundary[0].toType === "composite");
}

{
  // Un defecto REAL localizado en UN empalme (PSNR muy bajo justo ahí) debe verse en byBoundary sin contaminar el promedio global de los tramos vecinos.
  const values = [...Array(10).fill(40), 12, ...Array(9).fill(40)]; // un solo cuadro muy malo justo al cruzar al segundo tramo (índice 10)
  const chunks = [
    { type: "plain", outputStartFrame: 0, outputEndFrame: 10 },
    { type: "plain", outputStartFrame: 10, outputEndFrame: 20 },
  ];
  const { byChunk, byBoundary } = summarizePsnrByChunks(values, chunks, { boundaryMarginFrames: 2 });
  check("defecto real en un empalme: el tramo 0 (cuadros 0-9, NO toca el cuadro malo) sigue mostrando 40dB limpio", byChunk[0].averagePsnr === 40);
  check("defecto real en un empalme: byBoundary SÍ muestra el mínimo bajo (12dB) -- localiza el defecto exactamente donde está", byBoundary[0].minPsnr === 12, JSON.stringify(byBoundary[0]));
}

check("summarizePsnrByChunks: sin chunks (null/vacío) -> listas vacías, nunca lanza", JSON.stringify(summarizePsnrByChunks([1, 2], [])) === JSON.stringify({ byChunk: [], byBoundary: [] }) && JSON.stringify(summarizePsnrByChunks([1, 2], null)) === JSON.stringify({ byChunk: [], byBoundary: [] }));
check("summarizePsnrByChunks: un solo tramo -> 0 empalmes (no hay frontera entre un tramo y sí mismo)", summarizePsnrByChunks([1, 2, 3], [{ type: "plain", outputStartFrame: 0, outputEndFrame: 3 }]).byBoundary.length === 0);

console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
process.exit(failures === 0 ? 0 : 1);
