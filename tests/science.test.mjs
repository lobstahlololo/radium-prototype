import test from 'node:test';
import assert from 'node:assert/strict';

import { letterGrade, piecewise, GRADE_BANDS, UNRATED } from '../js/science/grade.js';
import { MISSION_PROFILES, computeSuitability, weightShares, evaluateFactor } from '../js/science/suitability.js';
import { comparePair, dimensionSimilarity, rankPlanetMatches, earthFactorGrades, SUBSTRATE_AFFINITY, VOLATILE_AFFINITY, SIMILARITY_DIMENSIONS } from '../js/science/similarity.js';
import { geometricSolarFraction, effectiveSolar, marsPressureKPa } from '../js/science/solar.js';
import { DemGrid, sampleRamp } from '../js/science/terrain.js';
import { summarizeClimate, summarizePowerClimate, terrainFromElevations, toaDailyMJ, terrainSamplePoints } from '../js/data/earth-climate.js';
import { MOON_SITES } from '../js/data/moon-sites.js';
import { MARS_SITES } from '../js/data/mars-sites.js';

const TERRAIN = {
  elevationM: -1800,
  slopeDeg: 4,
  roughnessM: 12,
  windowKm: 30,
  resolutionKm: 14.8,
  datasetLabel: 'test DEM',
};

function earthCandidate(overrides = {}) {
  return {
    id: 'test-earth',
    name: 'Test Earth site',
    substrateGroup: 'basalt',
    volatileGroup: 'none',
    climate: { tempMeanK: 290, diurnalAmpK: 15, solarFraction: 0.62, source: 'test' },
    terrain: { elevationM: 900, slopeDeg: 3, roughnessM: 10, resolutionKm: 10 },
    ...overrides,
  };
}

test('grade bands are monotonic and cover the 0-100 range', () => {
  assert.equal(letterGrade(100), 'A');
  assert.equal(letterGrade(80), 'A');
  assert.equal(letterGrade(79.99), 'B');
  assert.equal(letterGrade(65), 'B');
  assert.equal(letterGrade(64.9), 'C');
  assert.equal(letterGrade(50), 'C');
  assert.equal(letterGrade(35), 'D');
  assert.equal(letterGrade(34.9), 'F');
  assert.equal(letterGrade(0), 'F');
  assert.equal(letterGrade(null), UNRATED);
  assert.equal(GRADE_BANDS[GRADE_BANDS.length - 1].min, 0);
});

test('piecewise interpolation clamps and interpolates', () => {
  assert.equal(piecewise(0, [[0, 10], [10, 20]]), 10);
  assert.equal(piecewise(5, [[0, 10], [10, 20]]), 15);
  assert.equal(piecewise(50, [[0, 10], [10, 20]]), 20);
  assert.equal(piecewise(null, [[0, 10]]), null);
});

test('mission profile weights sum to one for every profile', () => {
  for (const p of Object.values(MISSION_PROFILES)) {
    const total = Object.values(p.weights).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `${p.id} weights sum to ${total}`);
  }
});

test('missing data is excluded and remaining weights renormalise', () => {
  const site = { ...MOON_SITES[0], tempMeanK: null, ice: null };
  const result = computeSuitability(site, TERRAIN, 'lunar_base', {});
  const available = result.factors.filter((f) => f.available);
  const eff = available.reduce((s, f) => s + f.effectiveWeight, 0);
  assert.ok(Math.abs(eff - 1) < 1e-9, 'available effective weights normalise to 1');
  assert.ok(result.coverage < 1);
  assert.deepEqual(result.missing.map((m) => m.id).sort(), ['ice', 'temp']);
  assert.ok(result.score >= 0 && result.score <= 100);
});

test('priority multipliers change weights but stay normalised', () => {
  const site = MOON_SITES.find((s) => s.id === 'connecting-ridge');
  const base = computeSuitability(site, TERRAIN, 'lunar_base', {});
  const boosted = computeSuitability(site, TERRAIN, 'lunar_base', { ice: 3, solar: 0.5 });
  const shares = weightShares(MISSION_PROFILES.lunar_base, { ice: 3, solar: 0.5 });
  assert.ok(Math.abs(shares.reduce((s, x) => s + x.share, 0) - 1) < 1e-9);
  const baseIce = base.factors.find((f) => f.id === 'ice').effectiveWeight;
  const boostedIce = boosted.factors.find((f) => f.id === 'ice').effectiveWeight;
  assert.ok(boostedIce > baseIce, 'raising the ice priority increases its effective weight');
});

test('a documented hard constraint caps the grade at F', () => {
  const result = computeSuitability(MARS_SITES[0], { ...TERRAIN, slopeDeg: 22 }, 'mars_robotic', {});
  assert.equal(result.grade, 'F');
  assert.equal(result.violations.length, 1);
  assert.match(result.ratingNote, /capped at F/i);
});

test('insufficient coverage yields no letter grade', () => {
  const bare = { id: 'bare', body: 'moon', lat: 0, lon: 0, ice: null, tempMeanK: null };
  const result = computeSuitability(bare, TERRAIN, 'lunar_base', {});
  assert.equal(result.grade, null);
  assert.ok(result.coverage < 0.5);
});

test('solar geometry: equator exceeds pole and Mars transmission reduces the fraction', () => {
  const eq = geometricSolarFraction('moon', 0);
  const pole = geometricSolarFraction('moon', 89.9);
  assert.ok(eq > 0.3 && eq < 0.35, `equatorial energy fraction ${eq}`);
  assert.ok(pole < eq);
  const marsEq = effectiveSolar({ body: 'mars', lat: 0 }).value;
  assert.ok(marsEq < eq, 'Mars dust transmission lowers the modelled resource');
  const polar = effectiveSolar({ body: 'moon', lat: -89.45, solarOverride: { value: 0.83, note: 'test' } });
  assert.ok(polar.value < 0.1, 'polar solar ENERGY is small even when illumination time is high');
  assert.equal(polar.publishedIllumination.value, 0.83);
});

test('Mars pressure approximation decreases with altitude', () => {
  const low = marsPressureKPa(-4000);
  const high = marsPressureKPa(8000);
  assert.ok(low > high);
  assert.ok(low > 0.5 && low < 1.2);
});

test('similarity is bounded, symmetric for categorical dimensions and 1 for identical values', () => {
  for (const dim of SIMILARITY_DIMENSIONS) {
    if (!dim.scale) continue;
    const s = dimensionSimilarity(dim.id, 100, 100);
    assert.equal(s, 1);
    const far = dimensionSimilarity(dim.id, 0, dim.scale * 5);
    assert.ok(far >= 0 && far <= 1);
  }
  assert.equal(dimensionSimilarity('substrate', 'basalt', 'tephra'), 0.9);
  assert.equal(dimensionSimilarity('substrate', 'tephra', 'basalt'), 0.9);
  assert.equal(dimensionSimilarity('volatile', 'ground_ice', 'surface_ice'), 0.85);
  assert.equal(dimensionSimilarity('volatile', 'surface_ice', 'ground_ice'), 0.85);
});

test('affinity matrices are symmetric and bounded', () => {
  for (const matrix of [SUBSTRATE_AFFINITY, VOLATILE_AFFINITY]) {
    for (const [a, row] of Object.entries(matrix)) {
      for (const [b, value] of Object.entries(row)) {
        assert.ok(value >= 0 && value <= 1, `${a}/${b} out of range`);
        if (matrix[b] && typeof matrix[b][a] === 'number') {
          assert.ok(Math.abs(matrix[b][a] - value) < 1e-9, `asymmetry ${a}/${b}`);
        }
      }
    }
  }
});

test('Earth Twin comparison excludes unavailable dimensions and reports incomparable physics', () => {
  const site = MOON_SITES.find((s) => s.id === 'apollo-11');
  const result = comparePair({ site, terrain: TERRAIN, body: 'moon' }, earthCandidate());
  assert.ok(result.score !== null);
  assert.ok(result.score >= 0 && result.score <= 100);
  assert.equal(result.dimensions.length, SIMILARITY_DIMENSIONS.length);
  assert.ok(result.coverage > 0.9);
  assert.ok(result.incomparable.some((d) => d.id === 'gravity'));

  const noClimate = comparePair({ site, terrain: TERRAIN, body: 'moon' }, earthCandidate({ climate: null }));
  assert.ok(noClimate.coverage < result.coverage);
  assert.ok(noClimate.dimensions.filter((d) => !d.available).length >= 3);
  assert.ok(noClimate.caveats.some((c) => /climate normals are unavailable/i.test(c)));
});

test('Earth site with identical substrate scores above a mismatched substrate when climate and terrain are equal', () => {
  const site = MARS_SITES.find((s) => s.id === 'jezero');
  const close = comparePair({ site, terrain: TERRAIN, body: 'mars' }, earthCandidate({ substrateGroup: 'clay', volatileGroup: 'hydrated_minerals' }));
  const far = comparePair({ site, terrain: TERRAIN, body: 'mars' }, earthCandidate({ substrateGroup: 'salt', volatileGroup: 'none' }));
  assert.ok(close.score > far.score, `clay ${close.score} should outrank salt ${far.score}`);
  const clayDim = close.dimensions.find((d) => d.id === 'substrate');
  const saltDim = far.dimensions.find((d) => d.id === 'substrate');
  assert.equal(clayDim.similarity, 1);
  assert.ok(saltDim.similarity < 0.3);
});

test('Earth-to-planet ranking is the inverse match and keeps planetary identity', () => {
  const earth = earthCandidate({ substrateGroup: 'clay', volatileGroup: 'hydrated_minerals' });
  const planet = (id, substrateGroup) => ({
    body: 'mars',
    terrain: TERRAIN,
    site: {
      id,
      name: id,
      body: 'mars',
      substrateGroup,
      volatileGroup: 'hydrated_minerals',
      tempMeanK: { value: 290 },
      tempAmpK: { value: 15 },
      solarFraction: { value: 0.62 },
    },
  });
  const ranked = rankPlanetMatches(earth, [planet('mismatch', 'salt'), planet('match', 'clay')]);
  assert.equal(ranked[0].planetSite.id, 'match');
  assert.equal(ranked[0].planetBody, 'mars');
  assert.equal(ranked[1].planetSite.id, 'mismatch');
  assert.ok(ranked[0].score > ranked[1].score);
});

test('eight Earth factor grades use available dimensions and leave unsupported factors unassessed', () => {
  const site = MOON_SITES.find((s) => s.id === 'apollo-11');
  const compare = comparePair({ site, terrain: TERRAIN, body: 'moon' }, earthCandidate());
  const factors = earthFactorGrades(compare);
  assert.equal(factors.length, 8);
  assert.ok(factors.find((f) => f.id === 'materials').available);
  assert.ok(factors.find((f) => f.id === 'terrain').available);
  assert.ok(factors.find((f) => f.id === 'environment').available);
  assert.ok(factors.find((f) => f.id === 'volatiles').available);
  assert.equal(factors.find((f) => f.id === 'processes').status, 'unassessed');
  assert.equal(factors.find((f) => f.id === 'biology').status, 'unassessed');
  assert.equal(factors.find((f) => f.id === 'subsurface').status, 'unassessed');
  assert.equal(factors.find((f) => f.id === 'operations').status, 'partial');
  assert.ok(factors.filter((f) => f.available).every((f) => f.grade && f.similarity !== null));
});

test('DEM bilinear sampling and Horn slope behave on a synthetic grid', () => {
  const width = 360;
  const height = 180;
  const meta = {
    width,
    height,
    radiusM: 1737400,
    scale: 1,
    offset: 0,
    lonOrigin: 0,
    datasetLabel: 'synthetic',
    datasetId: 'synthetic',
  };
  const flat = new Int16Array(width * height).fill(100);
  const flatGrid = new DemGrid(meta, flat);
  assert.equal(flatGrid.elevation(0, 0), 100);
  assert.equal(flatGrid.sample(10, 20).slopeDeg, 0);
  assert.equal(flatGrid.sample(10, 20).roughnessM, 0);

  const ramp = new Int16Array(width * height);
  for (let r = 0; r < height; r += 1) {
    for (let c = 0; c < width; c += 1) ramp[r * width + c] = c * 10;
  }
  const rampGrid = new DemGrid(meta, ramp);
  // Sample away from the 0°/360° grid seam so the ramp is continuous.
  const s = rampGrid.sample(0, 90);
  assert.ok(s.slopeDeg > 0);
  const dxM = (2 * Math.PI * 1737400) / width;
  const expected = (Math.atan(10 / dxM) * 180) / Math.PI;
  assert.ok(Math.abs(s.slopeDeg - expected) < 1e-3);
  assert.ok(s.roughnessM > 0, 'a sloped 3×3 window has non-zero relief');

  // PDS longitude origin: the same grid interpreted as 0–360°E vs −180–180°E
  // must sample different columns. This locks the LOLA/MOLA convention.
  const origin0 = new DemGrid({ ...meta, lonOrigin: 0 }, ramp);
  const origin180 = new DemGrid({ ...meta, lonOrigin: -180 }, ramp);
  assert.ok(Math.abs(origin0.elevation(0, 90) - 895) < 20);
  assert.ok(Math.abs(origin180.elevation(0, 90) - 2695) < 20);
  assert.ok(origin0.elevation(0, -90) > 2000, '−90°E maps to the western half of a 0–360 grid');
});

test('colour ramp sampling returns RGBA and handles bounds', () => {
  const stops = [[0, [0, 0, 0, 255]], [1, [255, 255, 255, 200]]];
  assert.deepEqual(sampleRamp(stops, 0), [0, 0, 0, 255]);
  assert.deepEqual(sampleRamp(stops, 1), [255, 255, 255, 200]);
  assert.deepEqual(sampleRamp(stops, 0.5), [128, 128, 128, 228]);
  assert.equal(sampleRamp(stops, NaN), null);
});

test('climate summariser converts real ERA5-shaped input without inventing values', () => {
  const daily = {
    time: ['2023-01-01', '2023-01-02', '2023-01-03', '2023-01-04'],
    temperature_2m_mean: [20, 22, 24, 26],
    temperature_2m_max: [30, 32, 34, 36],
    temperature_2m_min: [10, 12, 14, 16],
    precipitation_sum: [0, 0, 2, 0],
    et0_fao_evapotranspiration: [4, 4, 5, 5],
    shortwave_radiation_sum: [22, 22, 20, 20],
  };
  const c = summarizeClimate({ daily }, -24);
  assert.equal(c.tempMeanK, 296.1);
  assert.equal(c.diurnalAmpK, 20);
  assert.equal(c.precipMm, 183);
  assert.ok(c.aridityIndex > 0);
  assert.ok(c.solarFraction > 0 && c.solarFraction < 0.3, 'Earth surface insolation is a comparable fraction of the solar constant');
  assert.equal(summarizeClimate({ daily: {} }, 0), null);
  assert.equal(summarizeClimate(null, 0), null);
  assert.ok(toaDailyMJ(0, '2023-03-21') > 25);
});

test('NASA POWER climatology summariser uses monthly normals without inventing values', () => {
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const p = { T2M: { ANN: 20 }, T2M_MAX: {}, T2M_MIN: {}, PRECTOTCORR: { ANN: 0.5 }, ALLSKY_SFC_SW_DWN: { ANN: 6 } };
  months.forEach((m) => { p.T2M[m] = 20; p.T2M_MAX[m] = 30; p.T2M_MIN[m] = 15; });
  const c = summarizePowerClimate({ properties: { parameter: p }, header: { range: '2001–2025 test' } }, 0);
  assert.ok(Math.abs(c.tempMeanK - 293.1) < 0.2);
  assert.equal(c.diurnalAmpK, 15);
  assert.equal(c.precipMm, 183);
  assert.ok(c.solarFraction > 0.15 && c.solarFraction < 0.21);
  assert.ok(c.et0Mm > 500 && c.et0Mm < 4000);
  assert.ok(c.aridityIndex > 0);
  assert.match(c.et0Method, /Hargreaves/);
  const missing = JSON.parse(JSON.stringify(p));
  months.forEach((m) => { missing.T2M_MAX[m] = -999; });
  const c2 = summarizePowerClimate({ properties: { parameter: missing } }, 0);
  assert.equal(c2.diurnalAmpK, null);
  assert.equal(summarizePowerClimate({}, 0), null);
});

test('Earth terrain metrics from nine samples are scale-aware', () => {
  const lat = 24;
  const elevations = [100, 100, 100, 100, 100, 100, 100, 100, 100];
  const flat = terrainFromElevations(lat, elevations, 10 / 110.57, 0.01, 10);
  assert.equal(flat.slopeDeg, 0);
  assert.equal(flat.roughnessM, 0);
  const tilted = [0, 0, 0, 100, 100, 100, 200, 200, 200];
  const t = terrainFromElevations(lat, tilted, 10 / 110.57, 0.01, 10);
  assert.ok(t.slopeDeg > 0);
  assert.ok(t.roughnessM > 0);
  assert.equal(terrainFromElevations(lat, [1, 2], 1, 1, 10), null);
  const grid = terrainSamplePoints(lat, 10);
  assert.equal(grid.points.length, 9);
});
