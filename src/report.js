import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';
import { createT } from './i18n.js';
import { mascotSvg, reportMood } from './mascot.js';

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' };
const IMG = /(<img\b[^>]*?\bsrc=")([^"]+)(")/gi;
const isInline = (src) => /^(data:|https?:)/i.test(src);

export function inlineImages(html, baseDir) {
  const root = path.resolve(baseDir);
  return html.replace(IMG, (m, before, src, after) => {
    if (isInline(src)) return m;
    let file;
    try {
      file = path.resolve(root, decodeURI(src));
    } catch {
      return m;
    }
    if (!file.startsWith(root + path.sep)) return m;
    const mime = MIME[path.extname(file).toLowerCase()];
    if (!mime || !existsSync(file)) return m;
    return `${before}data:${mime};base64,${readFileSync(file).toString('base64')}${after}`;
  });
}

export function unembeddedRefs(html) {
  return [...html.matchAll(IMG)].map((m) => m[2]).filter((s) => !isInline(s));
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const wrapTables = (html) => html.replace(/<table>[\s\S]*?<\/table>/g, (m) => `<div class="scroll">${m}</div>`);

// Mismo sistema visual que el informe HTML de /wp-audit: tokens claros y oscuros, y ninguna
// regla nombra un color directamente, para que el modo oscuro no deje bloques blancos.
const TOKENS_LIGHT = `--ink:#1b1f24;--muted:#5b6672;--rule:#e3e7ec;--canvas:#f6f7f9;--paper:#fff;
  --ok:#1a7f4b;--ok-bg:#e6f4ec;--ok-rule:#c6e6d5;--bad:#c0362c;--bad-bg:#fbeae8;--bad-rule:#f2cfcb;
  --mid:#9a6a00;--mid-bg:#fdf3e0;--mid-rule:#f0dcb4;--info:#2b5fa8;--info-bg:#e9f0fb;--info-rule:#cfe0f6;
  --na:#7a828c;--na-bg:#eef0f3;--na-rule:#dfe3e8;--bar:rgba(255,255,255,.96);--hover:#fafbfc;color-scheme:light;`;
const TOKENS_DARK = `--ink:#e6e9ee;--muted:#9aa4b0;--rule:#2c333c;--canvas:#0f1318;--paper:#171c22;
  --ok:#4cc38a;--ok-bg:#11291d;--ok-rule:#1d4a33;--bad:#ff7b72;--bad-bg:#3a1714;--bad-rule:#5c2520;
  --mid:#e3b341;--mid-bg:#352a0c;--mid-rule:#5a4513;--info:#79b8ff;--info-bg:#132a45;--info-rule:#24476e;
  --na:#8b949e;--na-bg:#232a32;--na-rule:#333b45;--bar:rgba(23,28,34,.94);--hover:#1c232b;color-scheme:dark;`;

const CSS = `
:root{${TOKENS_LIGHT}}
@media (prefers-color-scheme:dark){:root{${TOKENS_DARK}}}
:root:has(#theme:checked){${TOKENS_DARK}}
@media (prefers-color-scheme:dark){:root:has(#theme:checked){${TOKENS_LIGHT}}}
*{box-sizing:border-box}
body{margin:0;background:var(--canvas);color:var(--ink);
  font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  -webkit-text-size-adjust:100%}
.wrap{max-width:1180px;margin:0 auto;padding:0 24px}
h1{font-size:30px;margin:.1em 0 .2em;letter-spacing:-.01em}
h2{font-size:22px;margin:0 0 16px;padding-bottom:8px;border-bottom:2px solid var(--rule);
  display:flex;align-items:center;gap:10px;flex-wrap:wrap}
h3{font-size:13px;margin:18px 0 6px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
p{margin:0 0 12px}
a{color:var(--info)}
code{background:var(--na-bg);padding:1px 5px;border-radius:4px;font-size:.9em}
pre{background:var(--na-bg);padding:10px 12px;border-radius:8px;overflow-x:auto}
pre code{background:none;padding:0}
img{max-width:100%;height:auto}
.top{background:var(--paper);border-bottom:1px solid var(--rule);padding:34px 0 26px}
.brand{display:flex;align-items:center;gap:16px} .mascot{flex:none}
.kicker{margin:0;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.1em}
.meta{margin:2px 0;color:var(--muted);font-size:13.5px}
.kpis{display:flex;flex-wrap:wrap;gap:12px;margin-top:20px}
.kpi{background:var(--canvas);border:1px solid var(--rule);border-radius:10px;padding:12px 16px;min-width:120px}
.kpi b{display:block;font-size:26px;line-height:1.1}
.kpi span{color:var(--muted);font-size:12.5px}
.kpi.big{background:var(--info-bg);border-color:var(--info-rule)}
.kpi.big b{font-size:34px;color:var(--info)}
b.ok{color:var(--ok)} b.bad{color:var(--bad)} b.mid{color:var(--mid)} b.info{color:var(--info)} b.na{color:var(--na)}
.toc{position:sticky;top:0;z-index:5;background:var(--bar);border-bottom:1px solid var(--rule);
  backdrop-filter:saturate(1.6) blur(6px)}
.toc .wrap{display:flex;align-items:center;gap:4px;overflow-x:auto;padding-top:6px;padding-bottom:6px}
.toc a{white-space:nowrap;padding:6px 10px;border-radius:7px;text-decoration:none;color:var(--muted);font-size:13px}
.toc a:hover{background:var(--na-bg);color:var(--ink)}
.theme{margin-left:auto;white-space:nowrap;cursor:pointer;font-size:13px;background:var(--paper);color:var(--ink);
  border:1px solid var(--rule);border-radius:7px;padding:5px 11px}
.theme .to-light{display:none}
:root:has(#theme:focus-visible) .theme{outline:2px solid var(--info);outline-offset:2px}
:root:has(#theme:checked) .theme .to-dark{display:none}
:root:has(#theme:checked) .theme .to-light{display:inline}
@media (prefers-color-scheme:dark){
  .theme .to-dark{display:none} .theme .to-light{display:inline}
  :root:has(#theme:checked) .theme .to-dark{display:inline}
  :root:has(#theme:checked) .theme .to-light{display:none}
}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
main.wrap{padding:28px 24px 60px}
section{background:var(--paper);border:1px solid var(--rule);border-radius:12px;padding:24px;margin:0 0 22px;
  scroll-margin-top:64px}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:0 0 12px}
table{border-collapse:collapse;width:100%;font-size:13.5px}
th,td{text-align:left;vertical-align:top;padding:8px 10px;border-bottom:1px solid var(--rule)}
thead th{background:var(--canvas);color:var(--muted);font-size:12px;text-transform:uppercase;
  letter-spacing:.04em;white-space:nowrap}
tbody tr:hover{background:var(--hover)}
td.num{font-variant-numeric:tabular-nums;white-space:nowrap;font-weight:600}
td.nowrap{white-space:nowrap}
.muted{color:var(--na)}
.chip{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;white-space:nowrap;
  border:1px solid transparent;font-weight:600}
.st-corregido{background:var(--ok-bg);color:var(--ok);border-color:var(--ok-rule)}
.st-mitigado{background:var(--mid-bg);color:var(--mid);border-color:var(--mid-rule)}
.st-no-codigo{background:var(--info-bg);color:var(--info);border-color:var(--info-rule)}
.st-pendiente{background:var(--bad-bg);color:var(--bad);border-color:var(--bad-rule)}
.st-otro{background:var(--na-bg);color:var(--na);border-color:var(--na-rule)}
.h-title{flex:1 1 0;min-width:0}
.num-badge{display:inline-flex;flex:none;align-items:center;justify-content:center;min-width:30px;height:30px;
  border-radius:8px;background:var(--canvas);border:1px solid var(--rule);font-size:15px;font-variant-numeric:tabular-nums}
.qa{margin:0 0 18px;padding:12px 16px;background:var(--canvas);border-left:3px solid var(--info);border-radius:0 8px 8px 0}
.qa .kicker{margin-bottom:4px}
.qa p:last-child{margin-bottom:0}
.ba{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:0 0 6px}
.ba>div{border:1px solid var(--rule);border-radius:10px;overflow:hidden;background:var(--canvas)}
.ba .label{margin:0;padding:8px 12px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;
  border-bottom:1px solid var(--rule)}
.ba .before .label{color:var(--bad);background:var(--bad-bg);border-color:var(--bad-rule)}
.ba .after .label{color:var(--ok);background:var(--ok-bg);border-color:var(--ok-rule)}
figure{margin:0;padding:10px 12px}
figure+figure{border-top:1px solid var(--rule)}
figure img{display:block;max-height:640px;width:auto;margin:0 auto;border-radius:6px;border:1px solid var(--rule);background:var(--paper)}
figcaption{color:var(--muted);font-size:12.5px;margin-top:6px;text-align:center}
.empty{padding:24px 12px;text-align:center;color:var(--na);font-size:13px}
.files{margin:0;padding-left:18px} .files li{margin-bottom:4px}
.note{color:var(--muted);font-size:13px;border-left:3px solid var(--rule);padding-left:12px;margin-top:14px}
.legend{margin:0;padding-left:18px;font-size:13.5px} .legend li{margin-bottom:8px}
footer.wrap{color:var(--muted);font-size:12.5px;padding-bottom:36px}
@media (max-width:720px){
  .wrap{padding:0 14px} main.wrap{padding:18px 14px 40px} section{padding:16px}
  h1{font-size:24px} .mascot{width:56px;height:auto} .kpi.big b{font-size:28px} .ba{grid-template-columns:1fr}
}
@media print{
  :root,:root:has(#theme:checked){${TOKENS_LIGHT}}
  body{background:#fff} .toc,.theme{display:none}
  section{border:none;padding:0;margin-bottom:18px}
  h2{break-after:avoid} tr,figure{break-inside:avoid}
}`;

function page({ title, headerHtml, tocHtml = '', mainHtml, footer, t }) {
  return `<!DOCTYPE html>
<html lang="${t('report.lang')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
<input type="checkbox" id="theme" class="sr">
<header class="top"><div class="wrap">${headerHtml}</div></header>
<nav class="toc"><div class="wrap">${tocHtml}
<label class="theme" for="theme"><span class="to-dark">${t('report.dark')}</span><span class="to-light">${t('report.light')}</span></label></div></nav>
<main class="wrap">
${mainHtml}
</main>
<footer class="wrap"><p>${escapeHtml(footer ?? title)}</p></footer>
</body>
</html>
`;
}

// Informe libre en Markdown: respaldo cuando Claude no deja informe.json.
export function renderReport(md, { title, lang = 'es' } = {}) {
  const tr = createT(lang);
  const t = title ?? tr('report.defaultTitle');
  return page({
    t: tr,
    title: t,
    headerHtml: `<div class="brand">${mascotSvg()}<div>\n<p class="kicker">${tr('report.kicker')}</p>\n<h1>${escapeHtml(t)}</h1>\n</div></div>`,
    mainHtml: `<section>\n${wrapTables(marked.parse(md ?? ''))}\n</section>`,
  });
}

// --- Informe estructurado (informe.json) -------------------------------------

export const STATUSES = {
  corregido: { label: 'Corregido', tone: 'ok', plural: 'Corregidos' },
  mitigado: { label: 'Mitigado', tone: 'mid', plural: 'Mitigados' },
  'no-codigo': { label: 'No es de código', tone: 'info', plural: 'No son de código' },
  pendiente: { label: 'Pendiente', tone: 'bad', plural: 'Pendientes' },
};

const statusKey = (s) => (Object.hasOwn(STATUSES, String(s ?? '').toLowerCase()) ? String(s).toLowerCase() : 'otro');
const statusLabel = (s, t = createT('es')) => {
  const k = statusKey(s);
  return k === 'otro' ? String(s ?? '—') : t(`status.${k}`);
};

export function parseQaReport(text, { lang = 'es' } = {}) {
  const t = createT(lang);
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(t('report.errInvalidJson', { error: err.message }));
  }
  if (!data || !Array.isArray(data.issues) || data.issues.length === 0) {
    throw new Error(t('report.errNoIssues'));
  }
  data.issues.forEach((issue, i) => {
    if (!issue || typeof issue.title !== 'string' || !issue.title.trim()) {
      throw new Error(t('report.errNoTitle', { n: i + 1 }));
    }
  });
  return data;
}

export function qaSummary(report, { lang = 'es' } = {}) {
  const t = createT(lang);
  return report.issues.map((issue, i) => `${i + 1}. ${issue.title} — ${statusLabel(issue.status, t)}`).join('\n');
}

// Texto de Claude o de la QA: se escapa todo y solo se interpretan `código` y saltos de línea.
function text(value) {
  if (value == null || value === '') return '';
  return String(value)
    .trim()
    .split(/\n\s*\n/)
    .map((para) => `<p>${escapeHtml(para).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

// Solo rutas relativas (img/...) o data:image; cualquier otro esquema se descarta.
const safeSrc = (src) => typeof src === 'string' && (/^data:image\//i.test(src) || (!/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith('//')));

function figures(list, fallbackLabel, t) {
  const shots = (Array.isArray(list) ? list : [])
    .map((item) => (typeof item === 'string' ? { src: item } : item))
    .filter((item) => item && safeSrc(item.src));
  if (!shots.length) return `<p class="empty">${t('report.noShot')}</p>`;
  return shots
    .map((shot, i) => {
      const alt = shot.label || `${fallbackLabel} ${i + 1}`;
      const caption = shot.label ? `<figcaption>${escapeHtml(shot.label)}</figcaption>` : '';
      return `<figure><img src="${escapeHtml(shot.src)}" alt="${escapeHtml(alt)}" loading="lazy">${caption}</figure>`;
    })
    .join('');
}

function issueCard(issue, i, t) {
  const n = i + 1;
  const key = statusKey(issue.status);
  const qa = issue.qa ?? {};
  const before = [...(Array.isArray(qa.images) ? qa.images : []), ...(Array.isArray(issue.before) ? issue.before : [])];
  const files = Array.isArray(issue.files) && issue.files.length
    ? `<h3>${t('report.files')}</h3><ul class="files">${issue.files.map((f) => `<li><code>${escapeHtml(f)}</code></li>`).join('')}</ul>`
    : '';
  const rows = (Array.isArray(issue.measurements) ? issue.measurements : []).filter((m) => m && typeof m === 'object');
  const measurements = rows.length
    ? `<h3>${t('report.measurements')}</h3><div class="scroll"><table><thead><tr><th>${t('report.element')}</th><th>${t('report.property')}</th><th>${t('report.before')}</th><th>${t('report.after')}</th></tr></thead><tbody>${rows
        .map(
          (m) =>
            `<tr><td><code>${escapeHtml(m.element ?? '')}</code>${m.viewport ? ` <span class="muted">${escapeHtml(m.viewport)}</span>` : ''}</td><td>${escapeHtml(
              m.property ?? '',
            )}</td><td class="nowrap">${escapeHtml(m.before ?? '')}</td><td class="nowrap">${escapeHtml(m.after ?? '')}</td></tr>`,
        )
        .join('')}</tbody></table></div>`
    : '';
  const block = (label, value) => (value ? `<h3>${label}</h3>${text(value)}` : '');
  return `<section id="issue-${n}">
<h2><span class="num-badge">${n}</span><span class="h-title">${escapeHtml(issue.title)}</span> <span class="chip st-${key}">${escapeHtml(statusLabel(issue.status, t))}</span></h2>
${qa.message ? `<div class="qa"><p class="kicker">${t('report.qaReport')}</p>${text(qa.message)}</div>` : ''}
<div class="ba">
<div class="before"><p class="label">${t('report.before')}</p>${figures(before, t('report.before'), t)}</div>
<div class="after"><p class="label">${t('report.after')}</p>${figures(issue.after, t('report.after'), t)}</div>
</div>
${block(t('report.cause'), issue.cause)}
${block(t('report.fix'), issue.fix)}
${files}
${measurements}
${block(t('report.notes'), issue.notes)}
</section>`;
}

export function renderQaReport(report, { site, date, lang = 'es' } = {}) {
  const t = createT(lang);
  const s = report.site ?? site ?? '';
  const d = report.date ?? date ?? '';
  const title = report.title ?? `QA ${[s, d].filter(Boolean).join(' ')}`;
  const issues = report.issues;
  const count = (k) => issues.filter((issue) => statusKey(issue.status) === k).length;
  const kpi = (k) => {
    const n = count(k);
    return `<div class="kpi"><b class="${n ? STATUSES[k].tone : 'na'}">${n}</b><span>${escapeHtml(t(`statusPlural.${k}`))}</span></div>`;
  };
  const header = `<div class="brand">${mascotSvg(reportMood(issues.map((issue) => statusKey(issue.status))))}<div>
<p class="kicker">${t('report.kicker')}</p>
<h1>${escapeHtml(s || title)}</h1>
<p class="meta">${escapeHtml([d, report.branch].filter(Boolean).join(' · '))}</p>
</div></div>
<div class="kpis">
<div class="kpi big"><b>${issues.length}</b><span>${issues.length === 1 ? t('report.issue') : t('report.issues')}</span></div>
${Object.keys(STATUSES).map(kpi).join('\n')}
</div>`;
  const toc = [['resumen', t('report.summary')], ...issues.map((issue, i) => [`issue-${i + 1}`, `${i + 1}. ${issue.title}`])]
    .map(([id, label]) => `<a href="#${id}">${escapeHtml(label.length > 40 ? `${label.slice(0, 39)}…` : label)}</a>`)
    .join('');
  const rows = issues
    .map(
      (issue, i) =>
        `<tr><td class="num">${i + 1}</td><td><a href="#issue-${i + 1}">${escapeHtml(issue.title)}</a></td><td class="nowrap"><span class="chip st-${statusKey(
          issue.status,
        )}">${escapeHtml(statusLabel(issue.status, t))}</span></td></tr>`,
    )
    .join('');
  const summary = `<section id="resumen"><h2>${t('report.summary')}</h2>
${text(report.context)}
<div class="scroll"><table><thead><tr><th>#</th><th>${t('report.colIssue')}</th><th>${t('report.colStatus')}</th></tr></thead><tbody>${rows}</tbody></table></div>
</section>`;
  return page({
    title,
    headerHtml: header,
    tocHtml: toc,
    mainHtml: `${summary}\n${issues.map((issue, i) => issueCard(issue, i, t)).join('\n')}`,
    footer: t('report.footer', { parts: [s, d].filter(Boolean).join(' · ') }),
    t,
  });
}

export function summaryFromMarkdown(md, max = 3500) {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.trim().startsWith('|'));
  if (start < 0) return '';
  const table = [];
  for (let i = start; i < lines.length && lines[i].trim().startsWith('|'); i++) table.push(lines[i].trim());
  return table.join('\n').slice(0, max);
}
