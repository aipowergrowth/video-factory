// Pruebas puras (sin FFmpeg, sin Remotion) de server/subtitles.mjs:
// shouldBurnCaptions (decisión por destino + override), formatSrtTimestamp
// y buildSrt (remapeo a la línea EDITADA, huecos por corte, sin solapes).
// La verificación con Remotion real (que el MP4 de YouTube sale sin
// subtítulos pegados) vive en .github/workflows/captions-destination-test.yml.
import { shouldBurnCaptions, formatSrtTimestamp, buildSrt } from "./subtitles.mjs";
import { buildTimeline } from "./timeline.mjs";

let failures = 0;
const check = (label, cond, detail = "") => {
  if (!cond) {
    failures++;
    console.log(`FAIL: ${label}${detail ? ` -- ${detail}` : ""}`);
  } else {
    console.log(`ok: ${label}`);
  }
};

// --- shouldBurnCaptions ---

check("youtube-16-9 sin override: NO pega subtítulos", shouldBurnCaptions({ destination: "youtube-16-9" }) === false);
check("vertical-9-16 sin override: SÍ pega subtítulos", shouldBurnCaptions({ destination: "vertical-9-16" }) === true);
check("youtube-16-9 con burnCaptions=true: se fuerza a pegar", shouldBurnCaptions({ destination: "youtube-16-9", burnCaptions: true }) === true);
check("vertical-9-16 con burnCaptions=false: se fuerza a NO pegar", shouldBurnCaptions({ destination: "vertical-9-16", burnCaptions: false }) === false);

// --- formatSrtTimestamp ---

check("formatSrtTimestamp: 0ms", formatSrtTimestamp(0) === "00:00:00,000");
check("formatSrtTimestamp: 1h 1min 1.5s", formatSrtTimestamp(3661500) === "01:01:01,500");
check("formatSrtTimestamp: negativo se recorta a 0", formatSrtTimestamp(-50) === "00:00:00,000");
check("formatSrtTimestamp: redondea milisegundos fraccionarios", formatSrtTimestamp(1234.7) === "00:00:01,235");

// --- buildSrt ---

{
  // Sin cortes: los tiempos de salida son idénticos a los originales.
  const timeline = buildTimeline(20, []);
  const captions = [
    { text: "Hola", startMs: 1000, endMs: 2000 },
    { text: "Mundo", startMs: 2000, endMs: 3000 },
  ];
  const srt = buildSrt(captions, timeline);
  check("sin cortes: 2 entradas, numeradas 1 y 2", srt.includes("1\n00:00:01,000 --> 00:00:02,000\nHola") && srt.includes("2\n00:00:02,000 --> 00:00:03,000\nMundo"));
}

{
  // Caso explícito pedido: un corte ANTES del primer subtítulo -- todo
  // se desplaza hacia atrás por la duración del corte.
  const timeline = buildTimeline(20, [{ id: "c0", startSeconds: 0, endSeconds: 5 }]);
  const captions = [{ text: "Después del corte", startMs: 10000, endMs: 12000 }];
  const srt = buildSrt(captions, timeline);
  check(
    "corte antes del primer subtítulo: el tiempo se desplaza 5s hacia atrás (10-12s -> 5-7s)",
    srt.includes("00:00:05,000 --> 00:00:07,000\nDespués del corte"),
  );
}

{
  // Un subtítulo que cae ENTERO dentro de un corte desaparece del .srt.
  const timeline = buildTimeline(20, [{ id: "c0", startSeconds: 4, endSeconds: 8 }]);
  const captions = [
    { text: "Sobrevive antes", startMs: 1000, endMs: 2000 },
    { text: "Se come el corte", startMs: 5000, endMs: 6000 },
    { text: "Sobrevive después", startMs: 10000, endMs: 11000 },
  ];
  const srt = buildSrt(captions, timeline);
  check("subtítulo entero dentro de un corte: no aparece en el .srt", !srt.includes("Se come el corte"));
  check("subtítulo antes del corte: tiempo sin cambios", srt.includes("00:00:01,000 --> 00:00:02,000\nSobrevive antes"));
  check("subtítulo después del corte: desplazado 4s hacia atrás (10-11s -> 6-7s)", srt.includes("00:00:06,000 --> 00:00:07,000\nSobrevive después"));
  check("solo quedan 2 entradas (la del medio desapareció)", (srt.match(/-->/g) ?? []).length === 2);
}

{
  // Un subtítulo PARTIDO por un corte en el medio -- dos entradas
  // separadas, nunca se inventa continuidad entre los dos pedazos.
  const timeline = buildTimeline(20, [{ id: "c0", startSeconds: 2, endSeconds: 3 }]);
  const captions = [{ text: "Partido por el corte", startMs: 1000, endMs: 4000 }];
  const srt = buildSrt(captions, timeline);
  check("subtítulo partido por un corte: produce 2 entradas", (srt.match(/-->/g) ?? []).length === 2);
  check("subtítulo partido: el primer pedazo termina justo donde empieza el corte (1-2s)", srt.includes("00:00:01,000 --> 00:00:02,000\nPartido por el corte"));
  check("subtítulo partido: el segundo pedazo arranca justo donde termina el corte, ya desplazado (2-3s)", srt.includes("00:00:02,000 --> 00:00:03,000\nPartido por el corte"));
}

{
  // Sin solapes: los tiempos de salida deben quedar en orden y sin
  // superponerse, incluso con varios cortes y subtítulos.
  const timeline = buildTimeline(30, [
    { id: "c0", startSeconds: 5, endSeconds: 6 },
    { id: "c1", startSeconds: 15, endSeconds: 17 },
  ]);
  const captions = [
    { text: "uno", startMs: 1000, endMs: 3000 },
    { text: "dos", startMs: 8000, endMs: 10000 },
    { text: "tres", startMs: 20000, endMs: 22000 },
    { text: "cuatro", startMs: 25000, endMs: 27000 },
  ];
  const srt = buildSrt(captions, timeline);
  const timestamps = [...srt.matchAll(/(\d\d:\d\d:\d\d,\d\d\d) --> (\d\d:\d\d:\d\d,\d\d\d)/g)].map((m) => [m[1], m[2]]);
  check("sin solapes: hay 4 entradas (ninguna cayó en un corte)", timestamps.length === 4);
  // Cada inicio debe quedar en orden no decreciente, sin saltos hacia atrás.
  let strictlyOrdered = true;
  for (let i = 1; i < timestamps.length; i++) {
    if (timestamps[i][0] < timestamps[i - 1][0]) strictlyOrdered = false;
  }
  check("sin solapes: los tiempos de inicio quedan en orden no decreciente", strictlyOrdered);
}

{
  // Sin subtítulos: .srt vacío, no revienta.
  const timeline = buildTimeline(10, []);
  check("sin captions: devuelve string vacío", buildSrt([], timeline) === "");
  check("captions undefined: devuelve string vacío, no lanza", buildSrt(undefined, timeline) === "");
}

{
  // UTF-8: acentos y eñes pasan sin modificar.
  const timeline = buildTimeline(10, []);
  const captions = [{ text: "El doctor Cameron Sepah habló de dopamina, atención y añoranza", startMs: 0, endMs: 1000 }];
  const srt = buildSrt(captions, timeline);
  check("UTF-8: el texto con acentos/eñes pasa sin modificar", srt.includes("El doctor Cameron Sepah habló de dopamina, atención y añoranza"));
}

console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
process.exit(failures === 0 ? 0 : 1);
