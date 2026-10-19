// Mascota del bot (docs/brand/) en SVG inline para la cabecera de los informes.
// Variante sin fondo: el borde oscuro de la cabeza la separa de un fondo claro.

const G = '#22C55E';
const R = '#EF4444';
const W = '#F8FAFC';

const FACES = {
  neutral: `<circle cx="408" cy="544" r="46" fill="${G}"/><circle cx="420" cy="530" r="14" fill="${W}"/><circle cx="616" cy="544" r="46" fill="${G}"/><circle cx="628" cy="530" r="14" fill="${W}"/><path d="M466 612Q512 648 558 612" fill="none" stroke="${G}" stroke-width="40" stroke-linecap="round"/>`,
  happy: `<path d="M368 560Q408 500 448 560M576 560Q616 500 656 560" fill="none" stroke="${G}" stroke-width="30" stroke-linecap="round"/><path d="M452 596Q512 650 572 596" fill="none" stroke="${G}" stroke-width="32" stroke-linecap="round"/>`,
  worried: `<path d="M360 500L440 476M664 500L584 476" stroke="${R}" stroke-width="22" stroke-linecap="round"/><circle cx="408" cy="556" r="36" fill="${R}"/><circle cx="616" cy="556" r="36" fill="${R}"/><path d="M462 624Q487 604 512 624T562 624" fill="none" stroke="${R}" stroke-width="20" stroke-linecap="round"/><path d="M770 390Q790 425 790 440A20 20 0 0 1 750 440Q750 425 770 390Z" fill="#7DD3FC"/>`,
};

export const MOODS = Object.keys(FACES);

export function mascotSvg(mood = 'neutral', size = 80) {
  const face = FACES[mood] ?? FACES.neutral;
  return `<svg class="mascot" xmlns="http://www.w3.org/2000/svg" viewBox="140 100 760 670" width="${size}" height="${Math.round((size * 670) / 760)}" aria-hidden="true" focusable="false">
<path d="M512 350V268" stroke="#94A3B8" stroke-width="52" stroke-linecap="round"/>
<path d="M480 170Q462 136 436 124M544 170Q562 136 588 124" fill="none" stroke="#F59E0B" stroke-width="34" stroke-linecap="round"/>
<ellipse cx="512" cy="222" rx="70" ry="80" fill="#F59E0B"/>
<rect x="160" y="500" width="64" height="160" rx="32" fill="#F59E0B"/><rect x="800" y="500" width="64" height="160" rx="32" fill="#F59E0B"/>
<rect x="222" y="350" width="580" height="400" rx="120" fill="${W}" stroke="#0F172A" stroke-width="20"/>
<rect x="276" y="448" width="472" height="206" rx="103" fill="#0F172A"/>
${face}
</svg>`;
}

// Recibe las claves de estado de los issues (corregido, pendiente...).
// Contenta si todo quedó resuelto, preocupada si queda algo pendiente.
export function reportMood(keys) {
  if (keys.includes('pendiente')) return 'worried';
  if (keys.length && keys.every((k) => k === 'corregido' || k === 'no-codigo')) return 'happy';
  return 'neutral';
}
