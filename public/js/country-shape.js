import { geoMercator, geoPath } from 'https://cdn.jsdelivr.net/npm/d3-geo@3/+esm';
import { feature } from 'https://cdn.jsdelivr.net/npm/topojson-client@3/+esm';

let countriesPromise = null;

async function loadCountries() {
  if (!countriesPromise) {
    countriesPromise = Promise.all([
      fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json').then((r) => {
        if (!r.ok) throw new Error(`world atlas ${r.status}`);
        return r.json();
      }),
      fetch('https://cdn.jsdelivr.net/npm/i18n-iso-countries@7/codes.json').then((r) => {
        if (!r.ok) throw new Error(`country codes ${r.status}`);
        return r.json();
      }),
    ]).then(([topology, codes]) => {
      const byNumericCode = new Map(
        feature(topology, topology.objects.countries).features.map((country) => [String(country.id), country]),
      );
      const alpha2ToNumeric = new Map(codes.map(([alpha2, , numeric]) => [alpha2, String(numeric)]));
      return { byNumericCode, alpha2ToNumeric };
    });
  }
  return countriesPromise;
}

export async function countryShapeHTML(code) {
  if (!/^[A-Za-z]{2}$/.test(code || '')) return '';
  const { byNumericCode, alpha2ToNumeric } = await loadCountries();
  const numericCode = alpha2ToNumeric.get(code.toUpperCase());
  const country = numericCode ? byNumericCode.get(numericCode) : null;
  if (!country) return '';

  const width = 30;
  const height = 20;
  const projection = geoMercator().fitExtent([[1, 1], [width - 1, height - 1]], country);
  const path = geoPath(projection)(country);
  return path
    ? `<svg class="country-shape" viewBox="0 0 ${width} ${height}" aria-hidden="true"><path d="${path}"></path></svg>`
    : '';
}
