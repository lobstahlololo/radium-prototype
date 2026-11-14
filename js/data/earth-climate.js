/**
 * Earth measurements: NASA POWER climatology (ERA5 fallback) + Copernicus DEM.
 *
 * Live, keyless services:
 *  - NASA POWER 25-year climatology (primary; ~2 KB per point)
 *  - Open-Meteo archive API / ERA5 (fallback daily series)
 *  - Open-Meteo elevation API / Copernicus DEM GLO-90
 *
 * Climate values are reanalysis-based normals, not station observations, and
 * air temperature is an Earth-side thermal proxy. Those limits are surfaced in
 * the UI. Results are cached in localStorage with a TTL.
 */

import { geometricSolarFraction } from '../science/solar.js';
import { fetchVolcanoContext } from './earth-context.js';

const CLIMATE_CACHE_KEY = 'radium.earth.climate.v3';
const SOIL_CACHE_KEY = 'radium.earth.soil.v1';
const POWER_URL = 'https://power.larc.nasa.gov/api/temporal/climatology/point';
const SOIL_URL = 'https://rest.isric.org/soilgrids/v2.0/properties/query';
const POWER_MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const CLIMATE_YEARS = [2023, 2024]; // ERA5 fallback window
export const SOLAR_CONSTANT_DAILY_MJ = (1361 * 86400) / 1e6; // 117.6 MJ/m²/day
export const CLIMATE_SOURCE_LABEL = 'NASA POWER 25-year climatology (ERA5 fallback)';
const START_DATE = `${CLIMATE_YEARS[0]}-01-01`;
const END_DATE = `${CLIMATE_YEARS[CLIMATE_YEARS.length - 1]}-12-31`;

function readCache() {
  try {
    const raw = localStorage.getItem(CLIMATE_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeCache(cache) {
  try {
    localStorage.setItem(CLIMATE_CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* storage can be full or disabled; caching is optional */
  }
}

function mean(arr) {
  const vals = arr.filter((v) => Number.isFinite(v));
  if (!vals.length) return null;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

function sum(arr) {
  const vals = arr.filter((v) => Number.isFinite(v));
  if (!vals.length) return null;
  return vals.reduce((s, v) => s + v, 0);
}

/** Daily top-of-atmosphere insolation on a horizontal surface, MJ/m²/day. */
export function toaDailyMJ(latDeg, dateIso) {
  const date = new Date(`${dateIso}T00:00:00Z`);
  const day = Math.floor((date - Date.UTC(date.getUTCFullYear(), 0, 1)) / 86400000) + 1;
  const decl = (23.44 * Math.PI) / 180 * Math.sin((2 * Math.PI * (day - 80)) / 365.25);
  const phi = (latDeg * Math.PI) / 180;
  const cosH0 = -Math.tan(phi) * Math.tan(decl);
  const H0 = Math.acos(Math.max(-1, Math.min(1, cosH0)));
  const cosZenith = Math.sin(phi) * Math.sin(decl) * H0 + Math.cos(phi) * Math.cos(decl) * Math.sin(H0);
  const S0 = 1361; // W/m²
  const seconds = 86400;
  return Math.max(0, (S0 * seconds * Math.max(0, cosZenith)) / Math.PI / 1e6);
}

/**
 * Pure summariser for Open-Meteo daily JSON. Exported for tests.
 * @returns {object|null} climate summary with K temperatures and documented proxies
 */
export function summarizeClimate(json, lat) {
  const d = json?.daily;
  if (!d || !Array.isArray(d.time) || d.time.length === 0) return null;

  const temps = d.temperature_2m_mean?.length ? d.temperature_2m_mean : null;
  const tmax = d.temperature_2m_max || [];
  const tmin = d.temperature_2m_min || [];
  const meanC = temps ? mean(temps) : mean(tmax.map((v, i) => (Number.isFinite(v) && Number.isFinite(tmin[i]) ? (v + tmin[i]) / 2 : null)));
  if (meanC === null) return null;

  const diurnal = mean(tmax.map((v, i) => (Number.isFinite(v) && Number.isFinite(tmin[i]) ? v - tmin[i] : null)));
  const days = d.time.length;
  const years = days / 365.25;
  const precipTotal = sum(d.precipitation_sum);
  const et0Total = sum(d.et0_fao_evapotranspiration);
  const precipMm = precipTotal === null ? null : precipTotal / years;
  const et0Mm = et0Total === null ? null : et0Total / years;

  // Comparable across bodies: annual mean surface insolation divided by the
  // 24-hour solar constant (1361 W/m² → 117.6 MJ/m²/day). This is the same
  // physical quantity as the planetary geometric solar fraction.
  let solarFraction = null;
  if (Array.isArray(d.shortwave_radiation_sum)) {
    const r = mean(d.shortwave_radiation_sum);
    if (r !== null) solarFraction = Math.max(0, Math.min(1, r / SOLAR_CONSTANT_DAILY_MJ));
  }

  return {
    tempMeanK: Number((meanC + 273.15).toFixed(1)),
    tempMeanC: Number(meanC.toFixed(1)),
    diurnalAmpK: diurnal === null ? null : Number(diurnal.toFixed(1)),
    precipMm: precipMm === null ? null : Number(precipMm.toFixed(0)),
    et0Mm: et0Mm === null ? null : Number(et0Mm.toFixed(0)),
    aridityIndex: precipMm !== null && et0Mm !== null ? Number((precipMm / Math.max(1, et0Mm)).toFixed(3)) : null,
    solarFraction: solarFraction === null ? null : Number(solarFraction.toFixed(3)),
    albedo: null,
    soilWetnessTop: null,
    soilWetnessRoot: null,
    aod550: null,
    period: `${START_DATE} → ${END_DATE}`,
    years: CLIMATE_YEARS.slice(),
    source: 'ERA5 reanalysis via Open-Meteo archive API (fallback)',
    tempType: '2 m air temperature (thermal-environment proxy, not a skin temperature)',
    resolutionKm: 25,
    et0Method: 'FAO-56 reference evapotranspiration from ERA5 (Open-Meteo)',
    quality: 'Reanalysis; smoothed terrain and cloud effects. Not a station observation.',
  };
}

/**
 * Summarises a NASA POWER climatology response. Exported for tests.
 * Uses the 25-year monthly normals: annual mean temperature, mean monthly
 * diurnal range, annual precipitation, annual mean solar radiation, and a
 * documented Hargreaves evapotranspiration estimate (not a POWER product).
 */
export function summarizePowerClimate(json, lat) {
  const params = json?.properties?.parameter;
  if (!params?.T2M) return null;
  const get = (key, month) => {
    const v = params?.[key]?.[month];
    return Number.isFinite(v) && v !== -999 ? v : null;
  };

  const meanC = get('T2M', 'ANN');
  if (meanC === null) return null;

  let rangeSum = 0;
  let rangeN = 0;
  let etSum = 0;
  let etN = 0;
  POWER_MONTHS.forEach((month, idx) => {
    const tmax = get('T2M_MAX', month);
    const tmin = get('T2M_MIN', month);
    const tmean = get('T2M', month);
    if (tmax !== null && tmin !== null) {
      rangeSum += Math.max(0, tmax - tmin);
      rangeN += 1;
    }
    if (tmax !== null && tmin !== null && tmean !== null) {
      const date = `2023-${String(idx + 1).padStart(2, '0')}-15`;
      const raMm = toaDailyMJ(lat, date) * 0.408; // extraterrestrial radiation, mm/day equivalent
      etSum += 0.0023 * raMm * (tmean + 17.8) * Math.sqrt(Math.max(0, tmax - tmin));
      etN += 1;
    }
  });

  const precipDay = get('PRECTOTCORR', 'ANN');
  const precipMm = precipDay === null ? null : precipDay * 365.25;
  const et0Mm = etN > 0 ? (etSum / etN) * 365.25 : null;
  const swKwh = get('ALLSKY_SFC_SW_DWN', 'ANN');
  const solarFraction = swKwh === null ? null : Math.max(0, Math.min(1, (swKwh * 3.6) / SOLAR_CONSTANT_DAILY_MJ));
  const albedo = get('ALLSKY_SRF_ALB', 'ANN');
  const soilTop = get('GWETTOP', 'ANN');
  const soilRoot = get('GWETROOT', 'ANN');
  const aod550 = get('AOD_55', 'ANN');

  return {
    tempMeanK: Number((meanC + 273.15).toFixed(1)),
    tempMeanC: Number(meanC.toFixed(1)),
    diurnalAmpK: rangeN > 0 ? Number((rangeSum / rangeN).toFixed(1)) : null,
    precipMm: precipMm === null ? null : Number(precipMm.toFixed(0)),
    et0Mm: et0Mm === null ? null : Number(et0Mm.toFixed(0)),
    aridityIndex: precipMm !== null && et0Mm ? Number((precipMm / Math.max(1, et0Mm)).toFixed(3)) : null,
    solarFraction: solarFraction === null ? null : Number(solarFraction.toFixed(3)),
    albedo: albedo === null ? null : Number(albedo.toFixed(3)),
    soilWetnessTop: soilTop === null ? null : Number(soilTop.toFixed(3)),
    soilWetnessRoot: soilRoot === null ? null : Number(soilRoot.toFixed(3)),
    aod550: aod550 === null ? null : Number(aod550.toFixed(3)),
    period: json?.header?.range || 'NASA POWER 25-year climatology (Jan 2001 – Dec 2025)',
    years: null,
    source: 'NASA POWER 25-year climatology (MERRA-2/POWER)',
    tempType: '2 m air temperature (thermal-environment proxy, not a skin temperature)',
    resolutionKm: 50,
    et0Method: 'Hargreaves estimate from monthly temperature range and TOA radiation (RADIUM-derived)',
    quality: 'Reanalysis-based climatology; coarse resolution and smoothed extremes. Not a station observation.',
  };
}

async function fetchPowerClimate(lat, lon) {
  const params = new URLSearchParams({
    parameters: 'T2M,T2M_MAX,T2M_MIN,PRECTOTCORR,ALLSKY_SFC_SW_DWN,ALLSKY_SRF_ALB,GWETTOP,GWETROOT,AOD_55',
    community: 'RE',
    longitude: String(lon),
    latitude: String(lat),
    format: 'JSON',
  });
  const res = await fetch(`${POWER_URL}?${params}`);
  if (!res.ok) throw new Error(`NASA POWER returned ${res.status}.`);
  const json = await res.json();
  const summary = summarizePowerClimate(json, lat);
  if (!summary) throw new Error('NASA POWER returned no usable climatology.');
  return summary;
}

async function fetchEra5Climate(lat, lon) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    start_date: START_DATE,
    end_date: END_DATE,
    daily: 'temperature_2m_mean,temperature_2m_max,temperature_2m_min,precipitation_sum,et0_fao_evapotranspiration,shortwave_radiation_sum',
    timezone: 'UTC',
  });
  const res = await fetch(`https://archive-api.open-meteo.com/v1/archive?${params}`);
  if (!res.ok) throw new Error(`ERA5 service returned ${res.status}.`);
  const json = await res.json();
  if (json?.error) throw new Error(json.reason || 'ERA5 service error.');
  const summary = summarizeClimate(json, lat);
  if (!summary) throw new Error('ERA5 response contained no usable daily values.');
  return summary;
}

/** Fetches one site's climate normals (cached). POWER first, ERA5 fallback. */
export async function fetchClimate(lat, lon) {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const cache = readCache();
  const hit = cache[key];
  if (hit && Date.now() - hit.t < TTL_MS) return hit.v;

  let summary = null;
  let powerError = null;
  try {
    summary = await fetchPowerClimate(lat, lon);
  } catch (err) {
    powerError = err.message;
  }
  if (!summary) {
    try {
      summary = await fetchEra5Climate(lat, lon);
    } catch (err) {
      throw new Error(`Climate unavailable. NASA POWER: ${powerError}; ERA5 fallback: ${err.message}`);
    }
  }
  cache[key] = { t: Date.now(), v: summary };
  writeCache(cache);
  return summary;
}

function readSoilCache() {
  try {
    const raw = localStorage.getItem(SOIL_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeSoilCache(cache) {
  try {
    localStorage.setItem(SOIL_CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* storage can be full or disabled; caching is optional */
  }
}

/** USDA-style texture class from SoilGrids sand/clay/silt percentages. */
export function classifySoilTexture(sandPct, clayPct, siltPct) {
  if (![sandPct, clayPct, siltPct].some(Number.isFinite)) return null;
  const sand = Number.isFinite(sandPct) ? sandPct : 0;
  const clay = Number.isFinite(clayPct) ? clayPct : 0;
  const silt = Number.isFinite(siltPct) ? siltPct : 0;
  if (clay >= 40) return 'clay';
  if (sand >= 70) return 'sand';
  if (silt >= 60) return 'silt';
  if (clay >= 27) return 'clay loam';
  if (sand >= 50) return 'sandy loam';
  return 'loam';
}

/** Summarises SoilGrids 0–30 cm means. This is a topsoil proxy, not bedrock geology. */
export function summarizeSoil(json) {
  const layers = json?.properties?.layers;
  if (!Array.isArray(layers) || !layers.length) return null;
  const layerMean = (name) => {
    const layer = layers.find((entry) => entry.name === name);
    const values = (layer?.depths || []).map((depth) => depth?.values?.mean).filter(Number.isFinite);
    if (!values.length) return null;
    const factor = Number(layer?.unit_measure?.d_factor) || 1;
    return Number((mean(values) / factor).toFixed(1));
  };
  const sandPct = layerMean('sand');
  const clayPct = layerMean('clay');
  const siltPct = layerMean('silt');
  const coarsePct = layerMean('cfvo');
  const bulkDensity = layerMean('bdod');
  const ph = layerMean('phh2o');
  if (![sandPct, clayPct, siltPct, coarsePct, bulkDensity, ph].some(Number.isFinite)) return null;
  return {
    sandPct,
    clayPct,
    siltPct,
    coarsePct,
    bulkDensity,
    ph,
    textureClass: classifySoilTexture(sandPct, clayPct, siltPct),
    depth: '0–30 cm mean',
    resolution: '250 m',
    source: 'SoilGrids 2.0 (ISRIC World Soil Information)',
    note: 'Topsoil texture and coarse-fragment content are a regolith-surface proxy. They are context only and are not substituted for bedrock mineralogy or a curated geological substrate.',
  };
}

/** Fetches the SoilGrids 0–30 cm topsoil profile for a point. */
export async function fetchSoil(lat, lon) {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const cache = readSoilCache();
  const hit = cache[key];
  if (hit && Date.now() - hit.t < TTL_MS) return hit.v;
  const params = new URLSearchParams({ lon: String(lon), lat: String(lat) });
  for (const property of ['clay', 'sand', 'silt', 'cfvo', 'bdod', 'phh2o']) params.append('property', property);
  for (const depth of ['0-5cm', '5-15cm', '15-30cm']) params.append('depth', depth);
  params.set('value', 'mean');
  const res = await fetch(`${SOIL_URL}?${params}`);
  if (!res.ok) throw new Error(`SoilGrids returned ${res.status}.`);
  const json = await res.json();
  const summary = summarizeSoil(json);
  if (!summary) throw new Error('SoilGrids returned no usable topsoil values.');
  cache[key] = { t: Date.now(), v: summary };
  writeSoilCache(cache);
  return summary;
}

async function fetchOpenMeteoElevations(points) {
  const out = [];
  for (let i = 0; i < points.length; i += 100) {
    const chunk = points.slice(i, i + 100);
    const params = new URLSearchParams({
      latitude: chunk.map((p) => p.lat.toFixed(4)).join(','),
      longitude: chunk.map((p) => p.lon.toFixed(4)).join(','),
    });
    const res = await fetch(`https://api.open-meteo.com/v1/elevation?${params}`);
    if (!res.ok) throw new Error(`Open-Meteo elevation returned ${res.status}.`);
    const json = await res.json();
    if (!Array.isArray(json.elevation) || json.elevation.length !== chunk.length) {
      throw new Error('Open-Meteo elevation response malformed.');
    }
    out.push(...json.elevation);
  }
  return out;
}

async function fetchOpenElevationFallback(points) {
  const locations = points.map((p) => `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`).join('|');
  const res = await fetch(`https://api.open-elevation.com/api/v1/lookup?locations=${encodeURIComponent(locations)}`);
  if (!res.ok) throw new Error(`Open-Elevation returned ${res.status}.`);
  const json = await res.json();
  const values = Array.isArray(json?.results) ? json.results.map((result) => result.elevation) : [];
  if (values.length !== points.length || values.some((value) => !Number.isFinite(value))) {
    throw new Error('Open-Elevation response malformed.');
  }
  return values;
}

async function openElevationWithRetry(points) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await fetchOpenElevationFallback(points);
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  }
  throw lastError || new Error('Open-Elevation failed.');
}

/** Terrarium tiles are an independent global DEM fallback; z10 is ≈150 m near the equator. */
const TERRARIUM_CACHE = new Map();

function terrariumTileFor(lat, lon, zoom = 10) {
  const n = 2 ** zoom;
  const latRad = (Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180;
  const xFloat = ((lon + 180) / 360) * n;
  const yFloat = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  const x = Math.floor(xFloat);
  const y = Math.floor(yFloat);
  return {
    x,
    y,
    px: Math.min(255, Math.max(0, Math.floor((xFloat - x) * 256))),
    py: Math.min(255, Math.max(0, Math.floor((yFloat - y) * 256))),
  };
}

function loadTerrariumTile(x, y) {
  const key = `${x}/${y}`;
  if (TERRARIUM_CACHE.has(key)) return TERRARIUM_CACHE.get(key);
  const promise = new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 256;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, 256, 256).data;
        const elevations = new Float32Array(256 * 256);
        for (let i = 0; i < 256 * 256; i += 1) {
          const offset = i * 4;
          elevations[i] = pixels[offset] * 256 + pixels[offset + 1] + pixels[offset + 2] / 256 - 32768;
        }
        resolve(elevations);
      } catch (error) {
        reject(new Error(`Terrarium tile could not be decoded: ${error.message}`));
      }
    };
    image.onerror = () => reject(new Error('Terrarium tile failed to load.'));
    image.src = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/10/${x}/${y}.png`;
  });
  TERRARIUM_CACHE.set(key, promise);
  promise.catch(() => TERRARIUM_CACHE.delete(key));
  return promise;
}

async function fetchTerrariumElevations(points) {
  const tilePromises = new Map();
  for (const point of points) {
    const tile = terrariumTileFor(point.lat, point.lon);
    const key = `${tile.x}/${tile.y}`;
    if (!tilePromises.has(key)) tilePromises.set(key, loadTerrariumTile(tile.x, tile.y));
  }
  const tiles = await Promise.all(tilePromises.values());
  const values = new Map([...tilePromises.keys()].map((key, index) => [key, tiles[index]]));
  return points.map((point) => {
    const tile = terrariumTileFor(point.lat, point.lon);
    const pixels = values.get(`${tile.x}/${tile.y}`);
    return pixels ? pixels[tile.py * 256 + tile.px] : NaN;
  });
}

/** Batched elevation lookup with independent SRTM and Terrarium fallbacks. */
export async function fetchElevations(points) {
  let primaryError = null;
  let openElevationError = null;
  try {
    return { values: await fetchOpenMeteoElevations(points), source: 'Open-Meteo elevation / Copernicus DEM GLO-90' };
  } catch (error) {
    primaryError = error.message;
  }
  try {
    return { values: await openElevationWithRetry(points), source: 'Open-Elevation / SRTM 250 m fallback' };
  } catch (error) {
    openElevationError = error.message;
  }
  try {
    const values = await fetchTerrariumElevations(points);
    if (values.length !== points.length || values.some((value) => !Number.isFinite(value))) {
      throw new Error('Terrarium returned no usable elevation.');
    }
    return { values, source: 'AWS Terrain Tiles / Terrarium fallback (≈150 m)' };
  } catch (error) {
    throw new Error(`Elevation unavailable. Open-Meteo: ${primaryError}; Open-Elevation: ${openElevationError}; Terrarium: ${error.message}`);
  }
}

function terrainScalePlan(detailed) {
  const scales = detailed
    ? [['fine', 1], ['regional', 10], ['broad', 50]]
    : [['regional', 10]];
  return scales.map(([key, spacingKm]) => ({ key, spacingKm }));
}

/** Builds the adaptive 3×3 sampling grid (~20 km window) around a site. */
export function terrainSamplePoints(lat, lon, spacingKm = 10) {
  const dLat = spacingKm / 110.57;
  const cosLat = Math.max(0.05, Math.cos((lat * Math.PI) / 180));
  const dLon = Math.min(0.9, Math.max(0.01, spacingKm / (111.32 * cosLat)));
  const points = [];
  for (let dr = -1; dr <= 1; dr += 1) {
    for (let dc = -1; dc <= 1; dc += 1) {
      points.push({ lat: Math.max(-89.9, Math.min(89.9, lat + dr * dLat)), lon: lon + dc * dLon });
    }
  }
  return { points, dLat, dLon, spacingKm };
}

/** Pure terrain summary from 9 elevation samples (row-major from south to north? we use north-first order below). */
export function terrainFromElevations(centerLat, elevations, dLatDeg, dLonDeg, spacingKm) {
  if (!Array.isArray(elevations) || elevations.length !== 9 || elevations.some((v) => !Number.isFinite(v))) return null;
  const dxM = dLonDeg * 111320 * Math.cos((centerLat * Math.PI) / 180);
  const dyM = dLatDeg * 110570;
  const z = (dr, dc) => elevations[(dr + 1) * 3 + (dc + 1)];
  const a = z(-1, -1); const b = z(-1, 0); const c = z(-1, 1);
  const d = z(0, -1); const e = z(0, 0); const f = z(0, 1);
  const g = z(1, -1); const h = z(1, 0); const i = z(1, 1);
  const dzdx = ((c + 2 * f + i) - (a + 2 * d + g)) / (8 * Math.max(1, dxM));
  const dzdy = ((g + 2 * h + i) - (a + 2 * b + c)) / (8 * Math.max(1, dyM));
  const mean = elevations.reduce((s, v) => s + v, 0) / 9;
  const variance = elevations.reduce((s, v) => s + (v - mean) ** 2, 0) / 9;
  return {
    elevationM: Number(e.toFixed(0)),
    slopeDeg: Number(((Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI).toFixed(2)),
    roughnessM: Number(Math.sqrt(variance).toFixed(1)),
    resolutionKm: spacingKm,
    windowKm: spacingKm * 2,
    datasetLabel: 'Copernicus DEM GLO-90, sampled on a 10 km grid',
    datasetId: 'copernicus_dem',
    method: 'Horn 3×3 slope on a ~10 km sampling grid; elevation σ over 9 samples',
  };
}

/** Full Earth profile for one point: climate, multi-scale terrain and optional context. */
export async function buildEarthProfile(analog, { detailed = false, includeContext = false } = {}) {
  const plan = terrainScalePlan(detailed);
  const grids = plan.map((scale) => ({
    ...scale,
    ...terrainSamplePoints(analog.lat, analog.lon, scale.spacingKm),
  }));
  const allPoints = grids.flatMap((grid) => grid.points);
  const [elevationResult, climateResult, soilResult, volcanoResult] = await Promise.all([
    fetchElevations(allPoints).catch((error) => ({ error })),
    fetchClimate(analog.lat, analog.lon).catch((error) => ({ error })),
    includeContext ? fetchSoil(analog.lat, analog.lon).catch((error) => ({ error })) : Promise.resolve(null),
    includeContext ? fetchVolcanoContext(analog.lat, analog.lon).catch((error) => ({ error })) : Promise.resolve(null),
  ]);

  const climate = climateResult && !climateResult.error ? climateResult : null;
  const soil = soilResult && !soilResult.error ? soilResult : null;
  const volcano = volcanoResult && !volcanoResult.error ? volcanoResult : null;
  const terrains = {};
  if (elevationResult && !elevationResult.error) {
    let offset = 0;
    for (const grid of grids) {
      const values = elevationResult.values.slice(offset, offset + 9);
      offset += 9;
      const terrain = terrainFromElevations(analog.lat, values, grid.dLat, grid.dLon, grid.spacingKm);
      if (terrain) {
        terrain.elevationSource = elevationResult.source;
        terrain.datasetLabel = `${elevationResult.source} · ${grid.spacingKm} km sampling grid`;
      }
      terrains[grid.key] = terrain;
    }
  }
  const terrain = terrains.regional || null;
  const dataStatus = {
    climate: climate
      ? { ok: true, source: climate.source, detail: climate.period }
      : { ok: false, error: climateResult?.error?.message || 'unknown climate service error' },
    terrain: terrain
      ? { ok: true, source: terrain.elevationSource, detail: `${grids.length} sampling scale${grids.length === 1 ? '' : 's'}` }
      : { ok: false, error: elevationResult?.error?.message || 'unknown elevation service error' },
    ...(includeContext
      ? {
          soil: soil
            ? { ok: true, source: soil.source, detail: `${soil.textureClass || 'texture unavailable'} · ${soil.depth}` }
            : { ok: false, error: soilResult?.error?.message || 'unknown SoilGrids error' },
          volcano: volcano
            ? { ok: true, source: volcano.source, detail: `${volcano.name} · ${Math.round(volcano.distanceKm)} km` }
            : { ok: false, error: volcanoResult?.error?.message || 'unknown volcano catalog error' },
        }
      : {}),
  };
  const issues = [];
  if (!climate) issues.push(`Climate normals unavailable: ${dataStatus.climate.error}`);
  if (!terrain) issues.push(`Terrain unavailable: ${dataStatus.terrain.error}`);
  return {
    ...analog,
    climate,
    terrain,
    terrainFine: terrains.fine || null,
    terrainBroad: terrains.broad || null,
    terrainSource: terrain?.elevationSource || null,
    soil,
    volcano,
    dataStatus,
    experimental: analog.id === 'custom-earth-point',
    fetchedAt: new Date().toISOString(),
    dataIssue: issues.length ? issues.join(' ') : null,
  };
}

/** Builds profiles for the whole pool with limited concurrency and progress callbacks. */
export async function buildPool(analogs, onProgress) {
  const results = new Array(analogs.length);
  let done = 0;
  const concurrency = 5;
  let cursor = 0;

  async function worker() {
    while (cursor < analogs.length) {
      const idx = cursor;
      cursor += 1;
      try {
        results[idx] = await buildEarthProfile(analogs[idx]);
      } catch (err) {
        results[idx] = { ...analogs[idx], climate: null, terrain: null, dataIssue: err.message };
      }
      done += 1;
      onProgress?.({ done, total: analogs.length, name: analogs[idx].name });
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, analogs.length) }, worker));
  return results;
}

/**
 * RADIUM display class for annual surface albedo. These thresholds are
 * descriptive, not a mission-suitability scale or a NASA classification.
 */
export function brightnessClass(albedo) {
  if (albedo === null || albedo === undefined || Number.isNaN(Number(albedo))) return null;
  const a = Number(albedo);
  if (a < 0.1) return { id: 'very-dark', label: 'Very dark', note: 'Less than 10% of incident shortwave is reflected.' };
  if (a < 0.2) return { id: 'dark', label: 'Dark', note: '10–20% of incident shortwave is reflected.' };
  if (a < 0.35) return { id: 'moderate', label: 'Moderately bright', note: '20–35% of incident shortwave is reflected.' };
  if (a < 0.6) return { id: 'bright', label: 'Bright', note: '35–60% of incident shortwave is reflected.' };
  return { id: 'very-bright', label: 'Very bright', note: 'At least 60% of incident shortwave is reflected; typical of snow and ice.' };
}

/** Top-of-atmosphere reference used for the Earth solar fraction (exported for tests). */
export const SOLAR_REFERENCE = { geometricSolarFraction };
