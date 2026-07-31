// World map view at /map.
//
// A country-level choropleth of where songs' artists are from (via the
// MusicBrainz-resolved `artistCountryCode`), coloured by song count. Click a
// country to list + play its songs and see the top contributing authors. An
// author multiselect filters the whole map.
//
// Rendering: d3-geo + topojson-client + world-atlas TopoJSON, all as ESM/JSON
// from a CDN (no build step, matching the app's other CDN imports). Our data
// keys by ISO-3166-1 alpha-2; the world-atlas geometries key by ISO numeric, so
// i18n-iso-countries/codes.json bridges the two.

import { geoNaturalEarth1, geoPath } from 'https://cdn.jsdelivr.net/npm/d3-geo@3/+esm';
import { feature } from 'https://cdn.jsdelivr.net/npm/topojson-client@3/+esm';
import {
  ensureSongsLoaded,
  songsByCountry,
  visibleAuthors,
  visibleSongDecades,
  displayNameFor,
  authorSlug,
  trackFromSongId,
} from '../catalog.js';
import { playQueue } from '../player.js';
import { filterBarHTML, wireFilterBar } from '../filter-bar.js';

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Sequential single-hue ramp (dark→bright orange): more songs = more intense.
// No-data countries get a recessive neutral so "no data" reads apart from "few".
const RAMP = ['#3d241c', '#7a3420', '#b34526', '#e6562e', '#f5936a'];
const NO_DATA = '#241f1a';
const W = 960;
const H = 500;

// Fetched once per session and reused across navigations.
let geoCache = null;      // { world: FeatureCollection, a2ToNum, numToA2 }
async function loadGeo() {
  if (geoCache) return geoCache;
  const [topo, codes] = await Promise.all([
    fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json').then((r) => r.json()),
    fetch('https://cdn.jsdelivr.net/npm/i18n-iso-countries@7/codes.json').then((r) => r.json()),
  ]);
  const a2ToNum = {};
  const numToA2 = {};
  for (const [a2, , num] of codes) { a2ToNum[a2] = num; numToA2[num] = a2; }
  geoCache = { world: feature(topo, topo.objects.countries), a2ToNum, numToA2 };
  return geoCache;
}

// Quantile bins over the non-zero counts → step 1..5 (0 = no data). Quantiles
// (not linear) so a few huge countries don't wash out the long tail.
function makeScale(byCountry) {
  const vals = [...byCountry.values()].map((e) => e.count).sort((a, b) => a - b);
  const q = (p) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] ?? 0;
  const th = vals.length ? [q(0.2), q(0.4), q(0.6), q(0.8)] : [];
  const step = (c) => {
    if (!c) return 0;
    let s = 1;
    for (const t of th) if (c > t) s += 1;
    return Math.min(RAMP.length, s);
  };
  return { step, thresholds: th };
}

export async function mount(el, { query }) {
  el.innerHTML = `<div class="shell"><div class="notice">Chargement de la carte…</div></div>`;

  let geo;
  try {
    [geo] = await Promise.all([loadGeo(), ensureSongsLoaded()]);
  } catch (err) {
    el.innerHTML = `<div class="shell"><div class="notice">Carte indisponible (${escape(err.message)}).</div></div>`;
    return;
  }

  const allAuthors = visibleAuthors();
  const selected = new Set(); // empty = all authors
  const decades = visibleSongDecades(); // e.g. [1950, 1960, …]
  let selectedDecade = null; // null = all decades

  el.innerHTML = `
    <div class="shell map-shell">
      <h1>Carte du monde</h1>
      ${filterBarHTML(`
        <div class="chip-row" id="mapAuthors">
          <a href="#" class="chip active" data-all role="button">Tous les auteurs</a>
        </div>
      `)}
      <p class="map-sub" id="mapSub"></p>
      <div class="map-wrap">
        <svg class="map-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Carte des morceaux par pays"></svg>
        <div class="map-legend" id="mapLegend" aria-hidden="true"></div>
      </div>
      <div class="map-decades" id="mapDecades" hidden>
        <span class="map-decade-caption">Décennie</span>
        <input type="range" id="decadeSlider" min="0" max="0" step="1" value="0" aria-label="Filtrer par décennie">
        <span class="map-decade-label" id="decadeLabel">Toutes</span>
      </div>
      <div class="map-panel" id="mapPanel"></div>
    </div>
  `;
  wireFilterBar(el);

  // Author chips.
  const chipRow = el.querySelector('#mapAuthors');
  for (const email of allAuthors) {
    const a = document.createElement('a');
    a.className = 'chip';
    a.href = '#';
    a.setAttribute('role', 'button');
    a.dataset.email = email;
    a.textContent = displayNameFor(email);
    chipRow.appendChild(a);
  }
  const allChip = chipRow.querySelector('[data-all]');

  const svg = el.querySelector('.map-svg');
  const legendEl = el.querySelector('#mapLegend');
  const subEl = el.querySelector('#mapSub');
  const panelEl = el.querySelector('#mapPanel');

  const projection = geoNaturalEarth1().fitSize([W, H], geo.world);
  const pathGen = geoPath(projection);

  // Floating tooltip (one, reused).
  const tip = document.createElement('div');
  tip.className = 'map-tip';
  tip.hidden = true;
  document.body.appendChild(tip);

  let current = null; // { byCountry, unknown, total, scale }

  function recompute() {
    const authors = selected.size ? [...selected] : null;
    const { byCountry, unknown, total } = songsByCountry({ authors, decade: selectedDecade });
    const scale = makeScale(byCountry);
    current = { byCountry, unknown, total, scale };

    // Paint countries.
    const paths = geo.world.features.map((f) => {
      const a2 = geo.numToA2[f.id];
      const data = a2 ? byCountry.get(a2) : null;
      const fill = data ? RAMP[scale.step(data.count) - 1] : NO_DATA;
      const name = f.properties?.name || a2 || '';
      return `<path d="${pathGen(f)}" fill="${fill}" data-num="${f.id}" data-name="${escape(name)}" data-count="${data?.count || 0}"></path>`;
    }).join('');
    svg.innerHTML = `<g class="map-countries">${paths}</g>`;

    subEl.textContent = `${total} morceau${total > 1 ? 'x' : ''} situé${total > 1 ? 's' : ''} dans ${byCountry.size} pays`
      + (unknown ? ` · ${unknown} sans localisation` : '');
    renderLegend(scale);

    // Keep the open panel in sync with the new filter.
    if (openCode && byCountry.has(openCode)) openCountry(openCode);
    else { openCode = null; panelEl.innerHTML = ''; }
  }

  function renderLegend(scale) {
    const th = scale.thresholds;
    const ranges = [];
    let lo = 1;
    for (let i = 0; i < RAMP.length; i += 1) {
      const hi = i < th.length ? th[i] : Infinity;
      ranges.push(hi === Infinity ? `${lo}+` : (lo === hi ? `${lo}` : `${lo}–${hi}`));
      lo = hi + 1;
    }
    legendEl.innerHTML = `<span class="map-legend-label">Morceaux</span>`
      + RAMP.map((c, i) => `<span class="map-legend-item"><span class="sw" style="background:${c}"></span>${ranges[i]}</span>`).join('');
  }

  let openCode = null;
  function openCountry(code) {
    openCode = code;
    const data = current.byCountry.get(code);
    if (!data) { panelEl.innerHTML = ''; return; }
    const name = countryName(code);
    const tracks = data.songs.map((s) => trackFromSongId(s.id)).filter(Boolean);
    const authors = [...data.byAuthor.entries()].sort((a, b) => b[1] - a[1]);

    panelEl.innerHTML = `
      <div class="map-panel-head">
        <h2>${escape(name)} <span class="map-count">${data.count}</span></h2>
        <button class="btn-accent" id="mapShuffle">🔀 Écouter (${data.count})</button>
      </div>
      <div class="map-panel-cols">
        <div class="map-authors">
          <h3>Auteurs</h3>
          <ol>${authors.map(([email, n]) => `<li><a href="/author/${escape(authorSlug(email))}">${escape(displayNameFor(email))}</a><span class="n">${n}</span></li>`).join('')}</ol>
        </div>
        <div class="map-songs">
          <h3>Morceaux</h3>
          <ol id="mapSongs">${data.songs.map((s, i) => `<li data-i="${i}"><span class="t">${escape(s.title || 'Sans titre')}</span><span class="a">${escape(s.artist || '')}</span></li>`).join('')}</ol>
        </div>
      </div>
    `;
    panelEl.querySelector('#mapShuffle').addEventListener('click', () => {
      if (tracks.length) playQueue(tracks, { shuffle: true, sourceLabel: `🌍 ${name}` });
    });
    panelEl.querySelector('#mapSongs').addEventListener('click', (e) => {
      const li = e.target.closest('li[data-i]');
      if (!li) return;
      const i = Number(li.dataset.i);
      if (tracks[i]) playQueue(tracks, { startIndex: i, sourceLabel: `🌍 ${name}` });
    });
    panelEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function countryName(a2) {
    const num = geo.a2ToNum[a2];
    const f = geo.world.features.find((x) => x.id === num);
    return f?.properties?.name || a2;
  }

  // Hover tooltip + selection highlight.
  svg.addEventListener('mousemove', (e) => {
    const p = e.target.closest('path[data-num]');
    if (!p) { tip.hidden = true; return; }
    const count = Number(p.dataset.count);
    tip.innerHTML = `<strong>${escape(p.dataset.name)}</strong>${count ? ` — ${count} morceau${count > 1 ? 'x' : ''}` : ' — aucun'}`;
    tip.hidden = false;
    tip.style.left = `${e.clientX + 12}px`;
    tip.style.top = `${e.clientY + 12}px`;
  });
  svg.addEventListener('mouseleave', () => { tip.hidden = true; });
  svg.addEventListener('click', (e) => {
    const p = e.target.closest('path[data-num]');
    if (!p) return;
    const a2 = geo.numToA2[p.dataset.num];
    if (!a2 || !current.byCountry.has(a2)) return;
    svg.querySelectorAll('path.sel').forEach((x) => x.classList.remove('sel'));
    p.classList.add('sel');
    openCountry(a2);
  });

  // Author filter wiring.
  chipRow.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    e.preventDefault();
    if (chip.dataset.all !== undefined) {
      selected.clear();
    } else {
      const email = chip.dataset.email;
      if (selected.has(email)) selected.delete(email); else selected.add(email);
    }
    allChip.classList.toggle('active', selected.size === 0);
    chipRow.querySelectorAll('[data-email]').forEach((c) => c.classList.toggle('active', selected.has(c.dataset.email)));
    recompute();
  });

  // Decade slider: index 0 = all, 1..N = decades[i-1]. Hidden if no years.
  const decadesEl = el.querySelector('#mapDecades');
  const slider = el.querySelector('#decadeSlider');
  const decadeLabel = el.querySelector('#decadeLabel');
  if (decades.length) {
    decadesEl.hidden = false;
    slider.max = String(decades.length);
    slider.addEventListener('input', () => {
      const i = Number(slider.value);
      selectedDecade = i === 0 ? null : decades[i - 1];
      decadeLabel.textContent = selectedDecade == null ? 'Toutes' : `${selectedDecade}s`;
      recompute();
    });
  }

  recompute();

  // Deep-link: /map?country=US opens that country if it has songs.
  if (query?.country) {
    const code = String(query.country).toUpperCase();
    if (current.byCountry.has(code)) openCountry(code);
  }

  // Cleanup: drop the tooltip when navigating away.
  return () => { tip.remove(); };
}
