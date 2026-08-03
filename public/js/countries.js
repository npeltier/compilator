// Country picker options — ISO-3166-1 alpha-2 → English name, from the same
// dataset the world map uses. Loaded once and cached. Used by the admin
// validation screen and the compilation editor so a human-set country carries
// both a display label and the ISO code the map colours by.

let cache = null;

export async function loadCountryOptions() {
  if (cache) return cache;
  const dn = new Intl.DisplayNames(['en'], { type: 'region' });
  const codes = await fetch('https://cdn.jsdelivr.net/npm/i18n-iso-countries@7/codes.json').then((r) => r.json());
  cache = codes
    .map(([a2]) => ({ code: a2, name: dn.of(a2) || a2 }))
    .filter((c) => c.name && c.name !== c.code)
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
  return cache;
}

// <option> markup for a <select>, with `selected` pre-selected by ISO code.
export function countryOptionsHTML(options, selected) {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<option value="">— pays —</option>`
    + options.map((c) => `<option value="${c.code}"${c.code === selected ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
}

export function countryName(options, code) {
  return options.find((c) => c.code === code)?.name || null;
}
