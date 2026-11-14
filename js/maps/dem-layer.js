/**
 * Builds map layers from the bundled planetary DEMs.
 *
 * These are real gridded products at 0.25°/px — not interpolated site values.
 * Elevation is shown with a hypsometric ramp scaled to the 2nd–98th percentile
 * of the actual grid; slope and roughness are derived with documented methods.
 */

import { sampleRamp } from '../science/terrain.js';

const PALETTES = {
  elevation: [
    [0.0, [9, 20, 46, 215]],
    [0.18, [22, 66, 121, 215]],
    [0.36, [36, 122, 156, 215]],
    [0.52, [104, 166, 137, 220]],
    [0.66, [206, 189, 129, 225]],
    [0.82, [236, 226, 208, 230]],
    [1.0, [255, 255, 255, 235]],
  ],
  slope: [
    [0.0, [68, 1, 84, 220]],
    [0.2, [59, 82, 139, 220]],
    [0.42, [33, 145, 140, 220]],
    [0.64, [94, 201, 98, 225]],
    [0.82, [208, 226, 63, 230]],
    [1.0, [253, 231, 37, 235]],
  ],
  roughness: [
    [0.0, [7, 4, 24, 220]],
    [0.25, [81, 18, 124, 225]],
    [0.5, [183, 55, 121, 230]],
    [0.75, [252, 137, 97, 235]],
    [1.0, [252, 253, 191, 240]],
  ],
};

export const TERRAIN_LAYERS = {
  elevation: {
    id: 'elevation',
    label: 'Elevation',
    unit: 'm',
    title: 'Global elevation',
    method: 'Bilinear DEM; hypsometric ramp scaled to the grid 2nd–98th percentile.',
    ticks: (min, max) => [
      { pos: 0, label: `${Math.round(min)} m` },
      { pos: 0.5, label: `${Math.round((min + max) / 2)} m` },
      { pos: 1, label: `${Math.round(max)} m` },
    ],
  },
  slope: {
    id: 'slope',
    label: 'Terrain slope',
    unit: '°',
    title: 'Regional slope',
    method: 'Horn derivative on native 0.25° cells (~7.6 km Moon / ~14.8 km Mars at the equator). Regional, not landing-hazard scale.',
    ticks: () => [
      { pos: 0, label: '0°' },
      { pos: 0.33, label: '10°' },
      { pos: 0.66, label: '20°' },
      { pos: 1, label: '30°+' },
    ],
  },
  roughness: {
    id: 'roughness',
    label: 'Terrain roughness',
    unit: 'm σ',
    title: 'Elevation variability',
    method: 'Population standard deviation over a 3×3 native-cell window (~15–30 km). Display layer only; site panels use a fixed 10 km sampling grid.',
    ticks: () => [
      { pos: 0, label: '0 m' },
      { pos: 0.33, label: '30 m' },
      { pos: 0.66, label: '70 m' },
      { pos: 1, label: '110 m+' },
    ],
  },
};

const cache = new Map();

function cssGradient(stops) {
  return `linear-gradient(90deg, ${stops
    .map(([p, c]) => `rgba(${c[0]},${c[1]},${c[2]},1) ${(p * 100).toFixed(1)}%`)
    .join(', ')})`;
}

function legendFor(kind, body, meta) {
  const def = TERRAIN_LAYERS[kind];
  const stops = PALETTES[kind];
  let min = meta.p02M;
  let max = meta.p98M;
  let note = def.method;
  if (kind === 'slope') { min = 0; max = 30; }
  if (kind === 'roughness') { min = 0; max = 110; }
  return {
    title: def.title,
    unit: def.unit,
    gradient: cssGradient(stops),
    ticks: def.ticks(min, max),
    note,
    sourceLabel: `${meta.datasetLabel} · 0.25°/px`,
    datasetId: meta.datasetId,
    body,
  };
}

/**
 * @param {import('../science/terrain.js').DemGrid} dem
 * @param {'elevation'|'slope'|'roughness'} kind
 * @param {string} body
 */
export function buildTerrainRaster(dem, kind, body) {
  const key = `${body}:${kind}:${dem.width}x${dem.height}`;
  if (cache.has(key)) return cache.get(key);

  const { width, height, radiusM, meta } = dem;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(width, height);
  const data = img.data;
  const stops = PALETTES[kind];
  const lonSpacingM = (2 * Math.PI * radiusM) / width;
  const latSpacingM = (Math.PI * radiusM) / height;
  const lo = kind === 'elevation' ? dem.meta.p02M : 0;
  const hi = kind === 'elevation' ? dem.meta.p98M : kind === 'slope' ? 30 : 110;

  const z = (r, c) => dem.elevationAtRowCol(r, ((c % width) + width) % width);

  for (let r = 0; r < height; r += 1) {
    const lat = 90 - (r + 0.5) * (180 / height);
    const dxM = Math.max(1, lonSpacingM * Math.cos((lat * Math.PI) / 180));
    const dyM = latSpacingM;
    for (let c = 0; c < width; c += 1) {
      let value;
      if (kind === 'elevation') {
        value = z(r, c);
      } else if (kind === 'slope') {
        const a = z(r - 1, c - 1); const b = z(r - 1, c); const cc = z(r - 1, c + 1);
        const d = z(r, c - 1); const f = z(r, c + 1);
        const g = z(r + 1, c - 1); const h = z(r + 1, c); const i = z(r + 1, c + 1);
        const dzdx = ((cc + 2 * f + i) - (a + 2 * d + g)) / (8 * dxM);
        const dzdy = ((g + 2 * h + i) - (a + 2 * b + cc)) / (8 * dyM);
        value = (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;
      } else {
        const vals = [];
        for (let dr = -1; dr <= 1; dr += 1) {
          for (let dc = -1; dc <= 1; dc += 1) vals.push(z(r + dr, c + dc));
        }
        const mean = vals.reduce((s, v) => s + v, 0) / 9;
        value = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / 9);
      }
      const t = (value - lo) / (hi - lo || 1);
      const rgba = sampleRamp(stops, Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : NaN);
      const idx = (r * width + c) * 4;
      if (!rgba) {
        data[idx + 3] = 0;
      } else {
        data[idx] = rgba[0];
        data[idx + 1] = rgba[1];
        data[idx + 2] = rgba[2];
        data[idx + 3] = rgba[3];
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  const result = {
    canvas,
    legend: legendFor(kind, body, meta),
    width,
    height,
  };
  cache.set(key, result);
  return result;
}

export function clearRasterCache() {
  cache.clear();
}
