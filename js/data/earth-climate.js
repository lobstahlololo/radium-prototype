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

const CLIMATE_CACHE_KEY = 'radium.earth.climate.v2';
const POWER_URL = 'https://power.larc.nasa.gov/api/temporal/climatology/point';
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

  return {
    tempMeanK: Number((meanC + 273.15).toFixed(1)),
    tempMeanC: Number(meanC.toFixed(1)),
    diurnalAmpK: rangeN > 0 ? Number((rangeSum / rangeN).toFixed(1)) : null,
    precipMm: precipMm === null ? null : Number(precipMm.toFixed(0)),
    et0Mm: et0Mm === null ? null : Number(et0Mm.toFixed(0)),
    aridityIndex: precipMm !== null && et0Mm ? Number((precipMm / Math.max(1, et0Mm)).toFixed(3)) : null,
    solarFraction: solarFraction === null ? null : Number(solarFraction.toFixed(3)),
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
    parameters: 'T2M,T2M_MAX,T2M_MIN,PRECTOTCORR,ALLSKY_SFC_SW_DWN',
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

/** Batched elevation lookup (up to 100 points per request). */
export async function fetchElevations(points) {
  const out = [];
  for (let i = 0; i < points.length; i += 100) {
    const chunk = points.slice(i, i + 100);
    const params = new URLSearchParams({
      latitude: chunk.map((p) => p.lat.toFixed(4)).join(','),
      longitude: chunk.map((p) => p.lon.toFixed(4)).join(','),
    });
    const res = await fetch(`https://api.open-meteo.com/v1/elevation?${params}`);
    if (!res.ok) throw new Error(`Elevation service returned ${res.status}.`);
    const json = await res.json();
    if (!Array.isArray(json.elevation)) throw new Error('Elevation response malformed.');
    out.push(...json.elevation);
  }
  return out;
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

/** Full Earth profile for one point: climate + terrain + derived indices. */
export async function buildEarthProfile(analog) {
  const { points, dLat, dLon } = terrainSamplePoints(analog.lat, analog.lon);
  const [elevations, climateResult] = await Promise.all([
    fetchElevations(points).catch((err) => ({ error: err })),
    fetchClimate(analog.lat, analog.lon).catch((err) => ({ error: err })),
  ]);
  const climate = climateResult && !climateResult.error ? climateResult : null;
  const terrain = Array.isArray(elevations) ? terrainFromElevations(analog.lat, elevations, dLat, dLon, 10) : null;
  return {
    ...analog,
    climate,
    terrain,
    fetchedAt: new Date().toISOString(),
    dataIssue: !climate
      ? `Climate normals unavailable: ${climateResult?.error?.message || 'unknown service error'}`
      : !terrain
        ? 'Elevation grid unavailable for this point.'
        : null,
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

/** Top-of-atmosphere reference used for the Earth solar fraction (exported for tests). */
export const SOLAR_REFERENCE = { geometricSolarFraction };
