const COMMON = ({ site, sitePath, jobDir }) => `
Trabajas en modo desatendido para un bot de Telegram. El dueño solo te lee por Telegram.
Sitio: ${site} (${sitePath}). Carpeta del trabajo: ${jobDir}. Capturas del dueño: ${jobDir}/img/.
Escribe en español, frases cortas, sin tablas decorativas. Telegram no renderiza Markdown complejo:
usa listas simples y bloques de código cortos.
Nunca hagas git commit ni git push. Nunca instales Playwright ni navegadores.
Si necesitas algo del dueño, pregúntalo en texto al final de tu respuesta.`;

const PLAN = `
FASE: PLAN (solo lectura). No edites ni crees archivos.
Lee las capturas con Read. Investiga el código (usa el grafo codebase-memory antes de grep) y,
si hace falta, abre el sitio local en el navegador y mide.
Responde con un plan numerado, un bloque por issue:
N. <título corto>
Causa: <causa probable>
Arreglo: <qué vas a cambiar>
Archivos: <rutas>
En todo cambio visual incluye los valores medidos con getComputedStyle y getBoundingClientRect
(escritorio y móvil) y el valor que propones.
Si un issue no es de código, dilo y explica qué hay que revisar.
El dueño aprueba con un botón; no llames a ExitPlanMode.`;

const IMPLEMENT = ({ jobDir }) => `
FASE: IMPLEMENTACIÓN. Aplica solo lo aprobado en el plan de esta conversación.
Deja los cambios sin commitear en la rama activa. Si el tema tiene build (npm run build), ejecútalo.
En cada cambio visual mide antes y después con getComputedStyle y getBoundingClientRect en
escritorio y móvil, en todos los elementos que compartan la clase. Si no coincide con lo esperado,
para y pregunta.
Haz capturas del «Después» en ${jobDir}/img/ con nombres NN-descripcion.png.
Al terminar escribe ${jobDir}/informe.md e ${jobDir}/informe.html:
- Título «QA <fecha>: correcciones», párrafo de contexto (dónde y cómo se probó, estado de git).
- Tabla resumen: #, Issue, Estado (Corregido / Mitigado / No es de código / Pendiente).
- Por issue: Antes (captura qa-NN), Causa, Arreglo, Después (captura nueva).
- En el HTML, imágenes con rutas relativas img/..., CSS inline, legible en móvil.
Termina tu respuesta con un resumen de 3 a 6 líneas.`;

export function systemPrompt({ phase, ...ctx }) {
  const body = phase === 'implement' ? IMPLEMENT(ctx) : PLAN;
  return `${COMMON(ctx)}\n${body}`.trim();
}

export function userMessage(items) {
  return items
    .map((it) => (it.type === 'image' ? `[Captura: ${it.path}]` : it.text))
    .join('\n\n');
}
