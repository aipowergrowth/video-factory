// Prueba la garantía de CTA (punto 13-b y 13-c del operador): un recurso
// de CTA que cae entero dentro de un corte se reubica en vez de
// desaparecer, y cada CTA que sobrevive lleva su posición editada
// (segundo + porcentaje) para poder verificarla sin renderizar.
import { buildTimeline } from "./timeline.mjs";
import {
  relocateToNearestSurvivingInterval,
  remapResourcesWithCtaGuarantee,
  isRenderableIn3A,
  computePendingResources,
} from "./cta-guarantee.mjs";

let failures = 0;
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const check = (label, cond) => {
  if (!cond) {
    failures++;
    console.log(`FAIL: ${label}`);
  } else {
    console.log(`ok: ${label}`);
  }
};
const noopLog = () => {};

// --- relocateToNearestSurvivingInterval ---

{
  // Video de 100s con un corte 40-60. El recurso 45-50 cae entero en el
  // corte -> debe reubicarse en el tramo más cercano (0-40 o 60-100).
  const t = buildTimeline(100, [{ startSeconds: 40, endSeconds: 60 }]);
  const relocated = relocateToNearestSurvivingInterval(t, { startSeconds: 45, endSeconds: 50 });
  check(
    "reubicación: centro (47.5) más cerca del tramo 0-40 -> queda en su borde derecho",
    relocated !== null && approx(relocated.endSeconds, 40),
  );
}

{
  // Si TODO el video es un corte, no queda ningún tramo donde reubicar.
  const t = buildTimeline(100, [{ startSeconds: 0, endSeconds: 100 }]);
  const relocated = relocateToNearestSurvivingInterval(t, { startSeconds: 45, endSeconds: 50 });
  check("reubicación imposible (video entero cortado): devuelve null", relocated === null);
}

// --- remapResourcesWithCtaGuarantee: recurso normal (sin ctaPosition) ---

{
  const t = buildTimeline(100, [{ startSeconds: 40, endSeconds: 60 }]);
  const { resources, droppedCount, ctaIssues } = remapResourcesWithCtaGuarantee({
    resources: [
      { id: "r1", description: "recurso normal en el corte", startSeconds: 45, endSeconds: 50 },
      { id: "r2", description: "mitad", startSeconds: 10, endSeconds: 15, ctaPosition: "middle" },
      { id: "r3", description: "cierre", startSeconds: 90, endSeconds: 95, ctaPosition: "end" },
      { id: "r4", description: "inicio", startSeconds: 1, endSeconds: 4, ctaPosition: "start" },
    ],
    timeline: t,
    log: noopLog,
  });
  check("recurso normal en un corte: se descarta (comportamiento preexistente)", droppedCount === 1);
  check("recurso normal en un corte: no aparece en la lista final", !resources.some((r) => r.id === "r1"));
  check("CTA de inicio, mitad y cierre fuera del corte: sin issues", ctaIssues.length === 0);
}

// --- punto (b): CTA que cae en un corte se reubica, nunca se descarta en silencio ---

{
  const t = buildTimeline(100, [{ startSeconds: 40, endSeconds: 60 }]);
  const logs = [];
  const { resources, ctaIssues } = remapResourcesWithCtaGuarantee({
    resources: [
      { id: "cta-start", description: "CTA de inicio", startSeconds: 1, endSeconds: 4, ctaPosition: "start" },
      { id: "cta-middle", description: "CTA de mitad", startSeconds: 45, endSeconds: 50, ctaPosition: "middle" },
      { id: "cta-end", description: "CTA de cierre", startSeconds: 90, endSeconds: 95, ctaPosition: "end" },
    ],
    timeline: t,
    log: (msg) => logs.push(msg),
  });
  const middleCta = resources.find((r) => r.ctaPosition === "middle");
  check("CTA de mitad en un corte: NO se descarta, aparece reubicado", middleCta !== undefined);
  check("CTA de mitad reubicado: log explica la reubicación", logs.some((l) => l.includes("reubicado")));
  check("CTA de inicio, mitad y cierre presentes: sin ctaIssues", ctaIssues.length === 0);
}

{
  // Caso extremo del punto (b): si no hay NINGÚN tramo posible, debe
  // quedar como error visible en ctaIssues, nunca desaparecer sin aviso.
  const t = buildTimeline(100, [{ startSeconds: 0, endSeconds: 100 }]);
  const { resources, ctaIssues } = remapResourcesWithCtaGuarantee({
    resources: [{ id: "cta-middle", description: "CTA de mitad", startSeconds: 45, endSeconds: 50, ctaPosition: "middle" }],
    timeline: t,
    log: noopLog,
  });
  check("CTA imposible de reubicar: no aparece en resources", resources.length === 0);
  check(
    "CTA imposible de reubicar: queda registrado en ctaIssues (no desaparece sin aviso)",
    ctaIssues.some((i) => i.includes("no se pudo ubicar")),
  );
}

// --- falta de CTA obligatorio (middle o end nunca propuesto en absoluto) ---

{
  const t = buildTimeline(100, []);
  const { ctaIssues } = remapResourcesWithCtaGuarantee({
    resources: [{ id: "cta-start", description: "CTA inicial", startSeconds: 1, endSeconds: 3, ctaPosition: "start" }],
    timeline: t,
    log: noopLog,
  });
  check("sin CTA de mitad ni de cierre: ambos quedan en ctaIssues", ctaIssues.length === 2);
  check("issue específico de mitad", ctaIssues.some((i) => i.includes('"middle"')));
  check("issue específico de cierre", ctaIssues.some((i) => i.includes('"end"')));
}

// Corrección del dictamen de cierre de talking-head (30-oct-2026): el
// CTA de inicio ahora es obligatorio SIEMPRE, igual que mitad y cierre
// -- antes era condicional a que el presentador lo pidiera verbalmente.
{
  const t = buildTimeline(100, []);
  const { ctaIssues } = remapResourcesWithCtaGuarantee({
    resources: [
      { id: "cta-middle", description: "mitad", startSeconds: 45, endSeconds: 50, ctaPosition: "middle" },
      { id: "cta-end", description: "cierre", startSeconds: 95, endSeconds: 99, ctaPosition: "end" },
    ],
    timeline: t,
    log: noopLog,
  });
  check("sin CTA de inicio (ahora obligatorio): queda en ctaIssues", ctaIssues.length === 1 && ctaIssues[0].includes('"start"'));
}

{
  // Un ctaIssue ya existente (p.ej. porque planMiddleCta falló antes de
  // llegar aquí) se preserva junto con los nuevos, no se pierde.
  const t = buildTimeline(100, []);
  const { ctaIssues } = remapResourcesWithCtaGuarantee({
    resources: [{ id: "cta-end", description: "cierre", startSeconds: 95, endSeconds: 99, ctaPosition: "end" }],
    timeline: t,
    log: noopLog,
    existingCtaIssues: ['Falta el CTA obligatorio de "middle": la llamada falló (timeout).'],
  });
  check("ctaIssue preexistente se conserva", ctaIssues.some((i) => i.includes("timeout")));
  check("no se duplica un segundo issue de mitad", ctaIssues.filter((i) => i.includes('"middle"')).length === 1);
  check("CTA de inicio ausente (ahora obligatorio): también queda en ctaIssues", ctaIssues.some((i) => i.includes('"start"')));
}

// --- Fase 3A (autorizada 30-oct-2026): qué se renderiza, qué queda pendiente de 3B ---

{
  check("CTA (cualquier type) es renderizable en 3A, aunque no traiga displayText", isRenderableIn3A({ type: "graphic", ctaPosition: "start" }));
  check("text-highlight CON displayText es renderizable en 3A", isRenderableIn3A({ type: "text-highlight", displayText: "hola" }));
  check("text-highlight SIN displayText NO es renderizable (nunca se usa description)", !isRenderableIn3A({ type: "text-highlight", description: "texto resaltado: algo" }));
  check("broll sin CTA NO es renderizable en 3A", !isRenderableIn3A({ type: "broll" }));
  check("document-reference NO es renderizable en 3A", !isRenderableIn3A({ type: "document-reference" }));
  check("graphic sin CTA NO es renderizable en 3A", !isRenderableIn3A({ type: "graphic" }));
}

{
  // Defecto real corregido: un text-highlight sin displayText queda
  // pendiente con un motivo específico (no el genérico de "tipo no
  // soportado"), y nunca se usa description como si fuera el texto.
  const logs = [];
  const pending = computePendingResources(
    [{ id: "th-sin-texto", type: "text-highlight", description: "Texto resaltado: 'algo que dijo el presentador'", essential: false }],
    (msg) => logs.push(msg),
  );
  check("text-highlight sin displayText: queda pendiente", pending.length === 1 && pending[0].id === "th-sin-texto");
  check("text-highlight sin displayText: motivo específico (no el genérico de tipo no soportado)", pending[0].reason.includes("displayText") && !pending[0].reason.includes("Fase 3B (necesita adquisición"));
  check("text-highlight sin displayText: pendingResources.description sigue siendo la description original (solo para el informe, nunca para mostrar en video)", pending[0].description === "Texto resaltado: 'algo que dijo el presentador'");
}

{
  const logs = [];
  const resources = [
    { id: "cta-start", type: "text-highlight", description: "suscribite", ctaPosition: "start", essential: false },
    { id: "r-broll", type: "broll", description: "imagen de un cerebro", essential: false },
    { id: "r-doc", type: "document-reference", description: "estudio de UCSF sobre dopamina", essential: true },
  ];
  const pending = computePendingResources(resources, (msg) => logs.push(msg));
  check("pendingResources: el CTA no queda pendiente", !pending.some((p) => p.id === "cta-start"));
  check("pendingResources: broll y document-reference sí quedan pendientes", pending.length === 2);
  check("pendingResources: conserva su type y description originales", pending.some((p) => p.id === "r-doc" && p.type === "document-reference" && p.description === "estudio de UCSF sobre dopamina"));
  check("pendingResources: marca cuál es essential", pending.find((p) => p.id === "r-doc").essential === true);
  check(
    "pendingResources: el log advierte que hay un recurso ESENCIAL pendiente (entrega no completa)",
    logs.some((l) => l.includes("ESENCIAL") && l.toLowerCase().includes("no se puede tratar como completa")),
  );
}

{
  // Sin ningún recurso pendiente: no genera ruido en el log.
  const logs = [];
  const pending = computePendingResources(
    [{ id: "cta-end", type: "graphic", description: "like y suscríbete", ctaPosition: "end", essential: false }],
    (msg) => logs.push(msg),
  );
  check("sin recursos pendientes: array vacío", pending.length === 0);
  check("sin recursos pendientes: no loguea nada", logs.length === 0);
}

// --- punto (c): verificabilidad sin render -- editedSeconds / editedPercent ---

{
  const t = buildTimeline(200, [{ startSeconds: 0, endSeconds: 20 }]); // salida: 180s
  const { resources } = remapResourcesWithCtaGuarantee({
    resources: [
      // source 100-105 -> tras el corte de 20s, output 80-85.
      { id: "cta-middle", description: "mitad", startSeconds: 100, endSeconds: 105, ctaPosition: "middle" },
    ],
    timeline: t,
    log: noopLog,
  });
  const middleCta = resources.find((r) => r.ctaPosition === "middle");
  check("editedSeconds refleja la línea de tiempo YA editada (80s, no 100s)", middleCta && approx(middleCta.editedSeconds, 80));
  check(
    "editedPercent = 80/180 * 100 = 44.4%",
    middleCta && approx(middleCta.editedPercent, 44.4, 0.05),
  );
}

{
  // Un recurso SIN ctaPosition nunca lleva editedSeconds/editedPercent --
  // ese campo es exclusivo de los 3 CTA obligatorios.
  const t = buildTimeline(100, []);
  const { resources } = remapResourcesWithCtaGuarantee({
    resources: [{ id: "r1", description: "recurso normal", startSeconds: 10, endSeconds: 15 }],
    timeline: t,
    log: noopLog,
  });
  check("recurso normal: sin editedSeconds", resources[0].editedSeconds === undefined);
}

console.log(failures === 0 ? "\nTODOS LOS TESTS PASARON" : `\n${failures} TEST(S) FALLARON`);
process.exit(failures === 0 ? 0 : 1);
