/** Generates an original cover image as SVG from a seed. No outside artwork is used. */
const PALETTES: Record<string, [string, string, string]> = {
  'Lo-Fi': ['#3b2a4a', '#c97b63', '#f2d6a2'],
  Synthwave: ['#1a1040', '#e0359a', '#27d8e6'],
  Ambient: ['#0f2a33', '#3f8f8c', '#c7e8d5'],
  House: ['#11162e', '#ff7a2f', '#ffd24a'],
  Chiptune: ['#171a3a', '#5ae25a', '#ff5fa2'],
};
const FALLBACK: [string, string, string] = ['#1b1f2a', '#5f7cff', '#b4f0ff'];

function hashText(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function coverSvg(seedText: string, genre: string | undefined): string {
  let state = hashText(seedText) || 1;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
  const [bg, mid, hi] = PALETTES[genre ?? ''] ?? FALLBACK;
  const parts: string[] = [];

  if (genre === 'Synthwave') {
    const cx = 120 + random() * 160;
    parts.push(`<circle cx="${cx}" cy="185" r="${80 + random() * 40}" fill="url(#g)"/>`);
    for (let i = 0; i < 9; i++) {
      const y = 262 + i * i * 1.8;
      parts.push(`<line x1="0" x2="400" y1="${y}" y2="${y}" stroke="${hi}" stroke-opacity=".55" stroke-width="1.5"/>`);
    }
    for (let i = -8; i <= 8; i++) {
      parts.push(`<line x1="200" y1="262" x2="${200 + i * 62}" y2="400" stroke="${hi}" stroke-opacity=".4" stroke-width="1.2"/>`);
    }
  } else if (genre === 'Chiptune') {
    const cell = 40;
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 10; y++) {
        if (random() < 0.48) {
          const fill = random() < 0.5 ? mid : hi;
          parts.push(`<rect x="${x * cell}" y="${y * cell}" width="${cell}" height="${cell}" fill="${fill}"/>`);
          parts.push(`<rect x="${(9 - x) * cell}" y="${y * cell}" width="${cell}" height="${cell}" fill="${fill}"/>`);
        }
      }
    }
  } else if (genre === 'House') {
    const count = 6 + Math.floor(random() * 5);
    for (let i = count; i > 0; i--) {
      const r = (i / count) * 230;
      parts.push(`<circle cx="${100 + random() * 200}" cy="${100 + random() * 200}" r="${r}" fill="none" stroke="${i % 2 ? mid : hi}" stroke-width="${6 + random() * 18}" stroke-opacity=".9"/>`);
    }
  } else if (genre === 'Ambient') {
    for (let i = 0; i < 6; i++) {
      const base = 110 + i * 50 + random() * 16;
      const a = base - 34 - random() * 40;
      const b = base + 24 + random() * 40;
      parts.push(`<path d="M0 ${base} C 120 ${a}, 260 ${b}, 400 ${base - 16} V 400 H 0 Z" fill="${i % 2 ? mid : hi}" fill-opacity="${0.14 + i * 0.05}"/>`);
    }
  } else {
    parts.push(`<circle cx="${110 + random() * 180}" cy="${100 + random() * 90}" r="${50 + random() * 40}" fill="${hi}"/>`);
    for (let i = 0; i < 5; i++) {
      const y = 200 + i * 42 + random() * 18;
      parts.push(`<path d="M0 ${y} Q 200 ${y - 60 - random() * 40} 400 ${y + 10} V 400 H 0 Z" fill="${i % 2 ? mid : bg}" fill-opacity="${0.45 + i * 0.1}"/>`);
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${hi}"/><stop offset="1" stop-color="${mid}"/></linearGradient></defs><rect width="400" height="400" fill="${bg}"/>${parts.join('')}</svg>`;
}
