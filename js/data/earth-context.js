/**
 * Point context for Earth coordinates.
 *
 * The Smithsonian Global Volcanism Program catalog is bundled as a trimmed
 * local snapshot because its WFS does not expose browser CORS headers. This
 * module only reports the nearest Holocene center; it does not claim that a
 * lava tube or cave exists at the clicked point.
 */

const VOLCANO_URL = 'data/volcanoes.json';
let volcanoPromise = null;

function haversineKm(a, b) {
  const radius = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function eruptionLabel(year) {
  if (!Number.isFinite(Number(year))) return 'Unknown';
  const value = Number(year);
  if (value < 0) return `${Math.abs(value).toLocaleString('en-US')} BCE`;
  return `${value} CE`;
}

/** Pure nearest-center lookup, exported for tests. */
export function nearestVolcano(lat, lon, catalog) {
  const volcanoes = catalog?.volcanoes;
  if (!Array.isArray(volcanoes) || !volcanoes.length) return null;
  let nearest = null;
  for (const volcano of volcanoes) {
    if (!Number.isFinite(volcano.lat) || !Number.isFinite(volcano.lon)) continue;
    const distanceKm = haversineKm({ lat, lon }, volcano);
    if (!nearest || distanceKm < nearest.distanceKm) {
      nearest = { ...volcano, distanceKm };
    }
  }
  if (!nearest) return null;
  return {
    ...nearest,
    name: nearest.n,
    country: nearest.c,
    region: nearest.r,
    type: nearest.t,
    year: nearest.y,
    url: nearest.u,
    distanceKm: Number(nearest.distanceKm.toFixed(1)),
    eruption: eruptionLabel(nearest.y),
    note: 'Nearest Holocene volcanic center in the Smithsonian catalog. Proximity is context only; it is not evidence of local lava tubes, caves or subsurface access.',
    source: catalog.source || 'Smithsonian Global Volcanism Program, Volcanoes of the World',
  };
}

/** Loads the bundled GVP snapshot once and returns the nearest Holocene center. */
export async function fetchVolcanoContext(lat, lon) {
  if (!volcanoPromise) {
    volcanoPromise = fetch(VOLCANO_URL, { cache: 'force-cache' })
      .then((response) => {
        if (!response.ok) throw new Error(`Volcano catalog returned ${response.status}.`);
        return response.json();
      })
      .then((catalog) => {
        if (!Array.isArray(catalog?.volcanoes) || !catalog.volcanoes.length) {
          throw new Error('Volcano catalog is malformed.');
        }
        return catalog;
      })
      .catch((error) => {
        volcanoPromise = null;
        throw error;
      });
  }
  const catalog = await volcanoPromise;
  return nearestVolcano(lat, lon, catalog);
}
