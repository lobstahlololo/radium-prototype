/**
 * RADIUM application controller.
 *
 * Data flow: DEM sampling → suitability engine → letter grades → map markers
 * and panels. Earth Twin Mode is a separate pipeline: live NASA POWER/DEM profiles →
 * similarity engine → analog ranking and side-by-side comparison. Nothing in
 * the interface is hardcoded to a site; every letter comes from the engines.
 */

import { BODIES, MISSION_CAVEAT } from './data/constants.js';
import { MOON_SITES } from './data/moon-sites.js';
import { MARS_SITES } from './data/mars-sites.js';
import { EARTH_ANALOGS } from './data/analogs.js';
import { getDataset } from './data/datasets.js';
import { MISSION_PROFILES, FACTORS, computeSuitability, profileForBody, weightShares } from './science/suitability.js';
import { letterGrade, gradeMeta, confidenceLabel, round, UNRATED, fmt } from './science/grade.js';
import { comparePair, rankAnalogs, rankPlanetMatches, earthFactorGrades, discoverNewAnalogs, SIMILARITY_DIMENSIONS } from './science/similarity.js';
import { effectiveSolar, marsPressureKPa, meanSurfaceIrradiance } from './science/solar.js';
import { loadDem } from './science/terrain.js';
import { buildTerrainRaster, TERRAIN_LAYERS } from './maps/dem-layer.js';
import { PlanetGlobe } from './maps/globe.js';
import { EarthMap, EARTH_LAYERS, EARTH_BASEMAPS } from './maps/earth.js';
import { drawContextThumb } from './maps/thumb.js';
import { buildEarthProfile, buildPool, brightnessClass } from './data/earth-climate.js';
import { openModal } from './ui/modals.js';

const BODY_SITES = { moon: MOON_SITES, mars: MARS_SITES };
const GRADE_ORDER = { A: 0, B: 1, C: 2, D: 3, F: 4, [UNRATED]: 5 };
const EVIDENCE_LABEL = {
  observed: 'Observed',
  derived: 'Derived',
  modeled: 'Modelled',
  'published-model': 'Published model',
  inferred: 'Inferred',
  assessment: 'Assessment',
};

const state = {
  body: 'moon',
  missionId: 'lunar_base',
  priorities: {},
  layer: 'sites',
  baseVisible: true,
  basemap: 'blue-marble',
  earthOverlay: 'none',
  labels: true,
  dems: {},
  assessed: null,
  globe: null,
  globeBody: null,
  earthMap: null,
  selection: null,
  earthPool: [],
  earthPoolState: 'idle',
  earthPoolProgress: null,
  earthPoolPromise: null,
  earthMatches: {},
  earthMatchPromises: new Map(),
  earthMatchErrors: {},
  earthPoolRatingState: 'idle',
  earthPoolRatingPromise: null,
  planetMatchPool: null,
  planetMatchPoolPromise: null,
  twin: { active: false, planetSiteId: null, rankings: [], allRankings: [], measuredCount: 0, selectedAnalogId: null, compare: null, custom: null },
  lastRecalc: null,
  loading: null,
  search: '',
};

const $ = (sel) => document.querySelector(sel);
const app = $('#app');
const inspector = $('#inspector');
const candidatesBody = $('#candidates-body');
const toastRegion = $('#toast-region');
const inspectorRail = $('#inspector-rail');
const analysisToggle = $('#analysis-toggle');
const railScrim = $('#rail-scrim');

/* ------------------------------------------------------------------ helpers */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function pct(n, digits = 0) {
  return `${(n * 100).toFixed(digits)}%`;
}

function humanize(value) {
  return String(value ?? '').replace(/_/g, ' ');
}

function formatCoord(lat, lon) {
  const la = `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}`;
  const lo = `${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;
  return `${la} · ${lo}`;
}

function siteDistanceKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function nearestSite(body, lat, lon) {
  let best = null;
  for (const site of BODY_SITES[body] || []) {
    const km = siteDistanceKm({ lat, lon }, site);
    if (!best || km < best.km) best = { site, km };
  }
  return best;
}

function earthMatchKey(profile) {
  return profile.id === 'custom-earth-point'
    ? `custom:${Number(profile.lat).toFixed(3)},${Number(profile.lon).toFixed(3)}`
    : profile.id;
}

/** Loads both planetary DEMs once so an Earth site can be matched against every curated site. */
function ensurePlanetMatchPool() {
  if (state.planetMatchPool) return Promise.resolve(state.planetMatchPool);
  if (state.planetMatchPoolPromise) return state.planetMatchPoolPromise;
  const promise = (async () => {
    await Promise.all(
      ['moon', 'mars'].map(async (body) => {
        if (!state.dems[body]) state.dems[body] = await loadDem(body);
      }),
    );
    const pool = [];
    for (const body of ['moon', 'mars']) {
      const dem = state.dems[body];
      if (!dem) throw new Error(`${BODIES[body].label} DEM unavailable for planetary matching.`);
      for (const site of BODY_SITES[body]) {
        pool.push({ site, terrain: dem.sample(site.lat, site.lon), body });
      }
    }
    state.planetMatchPool = pool;
    return pool;
  })();
  state.planetMatchPoolPromise = promise;
  promise.then(
    () => { state.planetMatchPoolPromise = null; },
    () => { state.planetMatchPoolPromise = null; },
  );
  return promise;
}

function ensureEarthMatches(profile) {
  const key = earthMatchKey(profile);
  if (state.earthMatches[key]) return Promise.resolve(state.earthMatches[key]);
  if (state.earthMatchPromises.has(key)) return state.earthMatchPromises.get(key);
  const promise = (async () => {
    const planets = await ensurePlanetMatchPool();
    const matches = rankPlanetMatches(profile, planets);
    state.earthMatches[key] = matches;
    delete state.earthMatchErrors[key];
    return matches;
  })();
  state.earthMatchPromises.set(key, promise);
  promise.then(
    () => { if (state.earthMatchPromises.get(key) === promise) state.earthMatchPromises.delete(key); },
    () => { if (state.earthMatchPromises.get(key) === promise) state.earthMatchPromises.delete(key); },
  );
  return promise;
}

async function queueEarthMatch(profile) {
  const key = earthMatchKey(profile);
  try {
    await ensureEarthMatches(profile);
  } catch (err) {
    state.earthMatchErrors[key] = err.message;
  }
  if (state.selection?.kind === 'earth' && earthMatchKey(state.selection.profile) === key) {
    renderCandidates();
    renderInspector();
    updateEarthMarkers();
  }
}

/** Rates every Earth candidate against its best planetary match once the live pool is ready. */
async function rateEarthPool() {
  if (state.earthPoolRatingState === 'ready' || !state.earthPool.length) return;
  if (state.earthPoolRatingPromise) return state.earthPoolRatingPromise;
  const promise = (async () => {
    state.earthPoolRatingState = 'loading';
    await Promise.all(
      state.earthPool
        .filter((profile) => profile.climate || profile.terrain)
        .map(async (profile) => {
          try {
            await ensureEarthMatches(profile);
          } catch (err) {
            state.earthMatchErrors[earthMatchKey(profile)] = err.message;
          }
        }),
    );
    state.earthPoolRatingState = 'ready';
  })();
  state.earthPoolRatingPromise = promise;
  try {
    return await promise;
  } finally {
    state.earthPoolRatingPromise = null;
    if (state.body === 'earth' && !state.twin.active) {
      renderCandidates();
      updateEarthMarkers();
      if (state.selection?.kind === 'earth') renderInspector();
    }
  }
}

function toast(message, kind = 'info', ms = 6000) {
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.innerHTML = `<span>${esc(message)}</span><button type="button" aria-label="Dismiss">✕</button>`;
  el.querySelector('button').addEventListener('click', () => el.remove());
  toastRegion.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function setInspectorOpen(open) {
  inspectorRail?.classList.toggle('is-open', open);
  analysisToggle?.setAttribute('aria-expanded', String(open));
  if (railScrim) railScrim.hidden = !open;
}

function openInspector() {
  setInspectorOpen(true);
  renderMissionStrip();
}

function closeInspector() {
  setInspectorOpen(false);
}

function setDemStatus(text, ok = true) {
  const el = $('#dem-status');
  el.textContent = text;
  el.classList.toggle('pill-warn', !ok);
}

function updateEarthStatus() {
  const el = $('#earth-status');
  if (state.earthPoolState === 'loading' && state.earthPoolProgress) {
    el.textContent = `Profiles ${state.earthPoolProgress.done}/${state.earthPoolProgress.total}`;
  } else if (state.earthPoolState === 'ready') {
    el.textContent = `${state.earthPool.length} sites ready`;
  } else if (state.earthPoolState === 'error') {
    el.textContent = 'Unavailable';
  } else {
    el.textContent = 'On demand';
  }
  el.classList.toggle('pill-warn', state.earthPoolState === 'error');
}

function updateSelectionStatus() {
  const el = $('#selection-status');
  if (!el) return;
  const sel = state.selection;
  let text = 'No site selected';
  if (sel?.kind === 'site') {
    const site = (BODY_SITES[state.body] || []).find((s) => s.id === sel.siteId);
    text = site ? site.name : 'Site selected';
  } else if (sel?.kind === 'twin') {
    const planet = selectedAssessment();
    const earth = state.twin.compare?.earthName || 'Earth analog';
    text = planet ? `${planet.site.name} ↔ ${earth}` : 'Twin comparison';
  } else if (sel?.kind === 'earth') {
    text = sel.profile?.name || 'Earth site';
  } else if (sel?.kind === 'earth-loading') {
    text = 'Measuring Earth coordinate';
  } else if (sel?.kind === 'earth-error') {
    text = 'Earth measurement unavailable';
  } else if (sel?.kind === 'planet-point') {
    text = 'Terrain-only coordinate';
  } else if (state.twin.active) {
    text = 'Awaiting Earth analog';
  }
  el.textContent = text;
  el.title = text;
}

function renderMissionStrip() {
  const objective = $('#mission-objective');
  if (!objective) return;
  if (state.twin.active) {
    objective.textContent = `${BODIES[state.body].label} ↔ Earth · direct analog analysis`;
  } else if (state.body === 'earth') {
    objective.textContent = `Terrestrial analog screening · ${EARTH_ANALOGS.length} curated sites`;
  } else {
    const profile = MISSION_PROFILES[state.missionId];
    objective.textContent = `${profile?.label || `${BODIES[state.body].label} screening`} · ${(BODY_SITES[state.body] || []).length} curated sites`;
  }
  updateSelectionStatus();
}

function startClock() {
  const clock = $('#utc-clock');
  if (!clock) return;
  const tick = () => { clock.textContent = new Date().toISOString().slice(11, 19); };
  tick();
  setInterval(tick, 1000);
}

function readUrlState() {
  const raw = location.hash.replace(/^#/, '');
  if (!raw) return {};
  const params = new URLSearchParams(raw);
  const body = ['moon', 'mars', 'earth'].includes(params.get('body')) ? params.get('body') : null;
  const lat = params.has('lat') ? Number(params.get('lat')) : null;
  const lon = params.has('lon') ? Number(params.get('lon')) : null;
  return {
    body,
    mission: params.get('mission'),
    site: params.get('site'),
    earth: params.get('earth'),
    lat: Number.isFinite(lat) && lat >= -90 && lat <= 90 ? lat : null,
    lon: Number.isFinite(lon) && lon >= -180 && lon <= 180 ? lon : null,
    twin: params.get('view') === 'twin',
  };
}

function syncUrlState() {
  const params = new URLSearchParams();
  params.set('body', state.body);
  if (state.twin.active) params.set('view', 'twin');
  if (state.missionId && state.body !== 'earth') params.set('mission', state.missionId);
  const sel = state.selection;
  if (sel?.kind === 'site') params.set('site', sel.siteId);
  if (state.twin.active && state.twin.planetSiteId) params.set('site', state.twin.planetSiteId);
  if (sel?.kind === 'earth' && !sel.custom) params.set('earth', sel.profile.id);
  if (sel?.kind === 'twin' && sel.analogId && sel.analogId !== 'custom-earth-point') params.set('earth', sel.analogId);
  const custom = sel?.kind === 'earth' && sel.custom
    ? sel.profile
    : sel?.kind === 'twin' && sel.analogId === 'custom-earth-point'
      ? state.twin.custom
      : null;
  if (custom) {
    params.set('lat', Number(custom.lat).toFixed(3));
    params.set('lon', Number(custom.lon).toFixed(3));
  }
  if (sel?.kind === 'planet-point') {
    params.set('lat', Number(sel.lat).toFixed(3));
    params.set('lon', Number(sel.lon).toFixed(3));
  }
  try {
    history.replaceState(null, '', `${location.pathname}${location.search}#${params.toString()}`);
  } catch {
    // File URLs and sandboxed previews can reject history updates; the app remains functional.
  }
  return location.href;
}

function shareAnalysis() {
  const url = syncUrlState();
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url)
      .then(() => toast('Analysis link copied. It restores this body, mission and selection.', 'ok', 4000))
      .catch(() => toast(`Copy this analysis link: ${url}`, 'warn', 12000));
  } else {
    toast(`Copy this analysis link: ${url}`, 'info', 12000);
  }
}

function setLoading(text) {
  const box = $('#stage-loading');
  if (!text) {
    box.hidden = true;
    state.loading = null;
    return;
  }
  $('#stage-loading-text').textContent = text;
  box.hidden = false;
  state.loading = text;
}

function gradeChip(letter) {
  return `<span class="grade-chip grade-${letter || 'U'}">${letter || UNRATED}</span>`;
}

function evidenceChip(ev) {
  if (!ev) return '';
  const cls = ev.replace('published-model', 'published');
  return `<span class="evidence evidence-${cls}">${EVIDENCE_LABEL[ev] || ev}</span>`;
}

function sourceLinks(ids) {
  return (ids || [])
    .map((id) => getDataset(id))
    .filter(Boolean)
    .map(
      (d) => `<li><a href="${d.url}" target="_blank" rel="noopener">${esc(d.title)}</a>
        <span>${esc(d.agency)} · ${esc(d.resolution)}</span></li>`,
    )
    .join('');
}

function formatDimValue(id, value) {
  if (value === null || value === undefined) return '<span class="na">Data unavailable.</span>';
  if (id === 'thermalMean' || id === 'thermalAmp') return `${Math.round(value)} K`;
  if (id === 'slope') return `${round(value, 1)}°`;
  if (id === 'roughness') return `${Math.round(value)} m σ`;
  if (id === 'luminosity') return `${Math.round(value)} W/m²`;
  return humanize(value);
}

/* --------------------------------------------------------------- assessment */

function missionFor(body) {
  return body === 'moon' ? 'lunar_base' : body === 'mars' ? 'mars_robotic' : null;
}

function getAssessed() {
  const body = state.body;
  if (!BODY_SITES[body] || !state.missionId) return [];
  if (state.assessed && state.assessed.body === body && state.assessed.missionId === state.missionId && state.assessed.priorities === JSON.stringify(state.priorities)) {
    return state.assessed.rows;
  }
  const dem = state.dems[body];
  const rows = BODY_SITES[body].map((site) => {
    const terrain = dem ? dem.sample(site.lat, site.lon) : null;
    const result = computeSuitability(site, terrain, state.missionId, state.priorities);
    return { site, terrain, result, grade: result?.grade || null };
  });
  state.assessed = { body, missionId: state.missionId, priorities: JSON.stringify(state.priorities), rows };
  return rows;
}

function sortedAssessments() {
  return [...getAssessed()].sort((a, b) => {
    const ga = GRADE_ORDER[a.grade] ?? 5;
    const gb = GRADE_ORDER[b.grade] ?? 5;
    if (ga !== gb) return ga - gb;
    return (b.result?.score ?? -1) - (a.result?.score ?? -1);
  });
}

function selectedAssessment() {
  const id =
    state.selection?.kind === 'site'
      ? state.selection.siteId
      : state.twin.active
        ? state.twin.planetSiteId
        : null;
  if (!id) return null;
  return getAssessed().find((r) => r.site.id === id) || null;
}

/* -------------------------------------------------------------------- globe */

async function ensureGlobe() {
  if (state.body === 'earth') return;
  if (state.globe && state.globeBody === state.body) return;
  if (state.globe) {
    state.globe.destroy();
    state.globe = null;
  }
  const errors = $('#globe-errors');
  errors.hidden = true;
  setLoading('Initialising 3D globe…');
  try {
    const globe = new PlanetGlobe($('#globe-container'), {
      body: state.body,
      onSiteSelect: selectSite,
      onPick: onPlanetPick,
      onStatus: ({ type, ok, message }) => {
        if (!ok) {
          errors.hidden = false;
          errors.innerHTML = `<strong>Imagery unavailable.</strong> ${esc(message)}`;
        }
      },
    });
    await globe.init();
    state.globe = globe;
    state.globeBody = state.body;
    updateGlobeSites();
    applyPlanetLayer();
  } catch (err) {
    errors.hidden = false;
    errors.innerHTML = `<strong>3D globe unavailable.</strong> ${esc(err.message)} You can still analyse curated sites from the ranking list.`;
    toast(err.message, 'error', 8000);
  } finally {
    setLoading(null);
  }
}

function updateGlobeSites() {
  if (!state.globe) return;
  const rows = getAssessed();
  state.globe.selectedId = selectedAssessment()?.site.id || null;
  state.globe.setSites(
    rows.map((r) => ({
      id: r.site.id,
      name: r.site.name,
      lat: r.site.lat,
      lon: r.site.lon,
      grade: r.grade,
      elevationM: r.terrain?.elevationM ?? 0,
    })),
  );
}

function applyPlanetLayer() {
  if (!state.globe) return;
  state.globe.setBaseVisible(state.baseVisible);
  if (state.layer === 'sites') {
    state.globe.setTerrainOverlay(null);
    return;
  }
  const dem = state.dems[state.body];
  if (!dem) return;
  try {
    const raster = buildTerrainRaster(dem, state.layer, state.body);
    state.globe.setTerrainOverlay(raster);
  } catch (err) {
    toast(`Layer unavailable: ${err.message}`, 'error');
  }
}

/* ---------------------------------------------------------------- earth map */

async function ensureEarthMap() {
  if (state.earthMap) return;
  const errors = $('#earth-errors');
  errors.hidden = true;
  setLoading('Initialising Earth map…');
  try {
    const map = new EarthMap($('#earth-container'), {
      onSelect: (id) => selectEarthAnalog(id),
      onPick: onEarthPick,
      onMove: ({ lat, lon }) => {
        if (state.body === 'earth' || state.twin.active) setCoordReadout(lat, lon, 'Earth');
      },
    });
    await map.init();
    state.earthMap = map;
    map.setBasemap(state.basemap);
    map.setOverlay(state.earthOverlay);
    map.setLabelsVisible(state.labels);
    updateEarthMarkers();
  } catch (err) {
    errors.hidden = false;
    errors.innerHTML = `<strong>Earth map unavailable.</strong> ${esc(err.message)}`;
    toast(err.message, 'error', 8000);
  } finally {
    setLoading(null);
  }
}

function updateEarthMarkers() {
  if (!state.earthMap) return;
  const customProfile = state.twin.active
    ? (state.twin.custom?.id === 'custom-earth-point' ? state.twin.custom : null)
    : (state.selection?.kind === 'earth' && state.selection.custom ? state.selection.profile : null);
  const customCompare = state.twin.active ? state.twin.compare : null;
  const customKey = customProfile ? earthMatchKey(customProfile) : null;
  const customBest = customKey ? state.earthMatches[customKey]?.[0] : null;
  const customRating = customCompare?.earthId === customProfile?.id ? customCompare : customBest;
  let items;
  if (state.twin.active) {
    items = state.twin.rankings
      .map((r) => {
        const analog = EARTH_ANALOGS.find((a) => a.id === r.earthId);
        if (!analog) return null;
        return {
          id: analog.id,
          name: analog.name,
          country: analog.country,
          lat: analog.lat,
          lon: analog.lon,
          grade: r.grade,
          score: r.score,
          selected: state.twin.selectedAnalogId === analog.id,
          established: analog.established,
        };
      })
      .filter(Boolean);
  } else {
    items = EARTH_ANALOGS.map((a) => {
      const bestMatch = state.earthMatches[a.id]?.[0];
      return {
        id: a.id,
        name: a.name,
        country: a.country,
        lat: a.lat,
        lon: a.lon,
        grade: bestMatch?.grade ?? UNRATED,
        score: bestMatch?.score ?? null,
        selected: state.selection?.kind === 'earth' && state.selection.profile?.id === a.id,
      };
    });
  }
  if (customProfile) {
    items.push({
      id: customProfile.id,
      name: 'Clicked Earth point',
      country: 'user-selected coordinate',
      lat: customProfile.lat,
      lon: customProfile.lon,
      grade: customRating?.grade ?? UNRATED,
      score: customRating?.score ?? null,
      selected: true,
      established: false,
    });
  }
  state.earthMap.setMarkers(items, (id) => {
    if (id === customProfile?.id) {
      applyCustomEarthProfile(customProfile);
      return;
    }
    selectEarthAnalog(id);
  });
}

async function selectEarthAnalog(id) {
  const analog = EARTH_ANALOGS.find((a) => a.id === id);
  if (!analog) return;
  if (state.twin.active && !state.twin.rankings.some((row) => row.earthId === id)) {
    toast('The curated Twin ranking is limited to the top five. Choose one of those pins, or click anywhere on the Earth map to compare a custom coordinate.', 'warn');
    return;
  }
  const cached = state.earthPool.find((p) => p.id === id);
  if (cached) {
    state.selection = { kind: 'earth', profile: cached, custom: false };
    if (state.twin.active && selectedAssessment()) {
      setTwinComparison(cached);
      state.selection = { kind: 'twin', analogId: id };
    } else {
      queueEarthMatch(cached);
    }
    renderCandidates();
    renderInspector();
    updateEarthMarkers();
    openInspector();
    syncUrlState();
    state.earthMap?.flyTo(analog.lat, analog.lon, 4.5);
    return;
  }
  state.selection = { kind: 'earth-loading', lat: analog.lat, lon: analog.lon, name: analog.name };
  renderInspector();
  openInspector();
  state.earthMap?.flyTo(analog.lat, analog.lon, 4.5);
  try {
    const profile = await buildEarthProfile(analog);
    state.selection = { kind: 'earth', profile, custom: false };
    if (state.twin.active && selectedAssessment()) {
      setTwinComparison(profile);
      state.selection = { kind: 'twin', analogId: id };
    } else {
      queueEarthMatch(profile);
    }
  } catch (err) {
    state.selection = { kind: 'earth-error', name: analog.name, message: err.message };
  }
  renderCandidates();
  renderInspector();
  updateEarthMarkers();
  openInspector();
  syncUrlState();
}

function applyCustomEarthProfile(profile) {
  if (state.twin.active) {
    if (!selectedAssessment()) {
      toast('Select a Moon or Mars site before comparing an Earth coordinate.', 'warn');
      return;
    }
    setTwinComparison(profile);
    state.selection = { kind: 'twin', analogId: profile.id };
    renderCandidates();
    renderInspector();
    updateEarthMarkers();
    openInspector();
    syncUrlState();
    return;
  }
  state.selection = { kind: 'earth', profile, custom: true };
  queueEarthMatch(profile);
  renderInspector();
  updateEarthMarkers();
  openInspector();
  syncUrlState();
}

async function onEarthPick({ lat, lon }) {
  if (state.body === 'earth') setCoordReadout(lat, lon, 'Earth');
  const customLat = Number(lat.toFixed(3));
  const customLon = Number(lon.toFixed(3));
  state.selection = {
    kind: 'earth-loading',
    lat: customLat,
    lon: customLon,
    name: 'Clicked Earth point',
    twin: state.twin.active,
  };
  renderInspector();
  openInspector();
  try {
    const profile = await buildEarthProfile({
      id: 'custom-earth-point',
      name: 'Clicked Earth point',
      country: '',
      lat: customLat,
      lon: customLon,
      substrateGroup: null,
      volatileGroup: null,
      established: false,
      landform: 'User-selected coordinate',
    }, { detailed: true, includeContext: true });
    if (state.selection?.kind !== 'earth-loading' || state.selection.lat !== customLat || state.selection.lon !== customLon) return;
    applyCustomEarthProfile(profile);
  } catch (err) {
    if (state.selection?.kind !== 'earth-loading' || state.selection.lat !== customLat || state.selection.lon !== customLon) return;
    state.selection = { kind: 'earth-error', name: 'Clicked Earth point', message: err.message, twin: state.twin.active };
    renderInspector();
    updateEarthMarkers();
  }
}

/* --------------------------------------------------------------- selection */

function selectSite(id) {
  const body = state.body;
  const site = (BODY_SITES[body] || []).find((s) => s.id === id);
  if (!site) return;
  state.selection = { kind: 'site', siteId: id };
  if (state.twin.active) {
    state.twin.planetSiteId = id;
    state.twin.selectedAnalogId = null;
    state.twin.custom = null;
    computeTwinRankings();
    const top = state.twin.rankings[0];
    if (top) {
      state.twin.selectedAnalogId = top.earthId;
      state.selection = { kind: 'twin', analogId: top.earthId };
    }
    updateEarthMarkers();
  }
  setCoordReadout(site.lat, site.lon, BODIES[body].label);
  renderCandidates();
  renderInspector();
  updateGlobeSites();
  applyPlanetLayer();
  openInspector();
  syncUrlState();
  if (state.globe && !state.twin.active) state.globe.flyTo(site.lat, site.lon);
}

function onPlanetPick({ lat, lon }) {
  setCoordReadout(lat, lon, BODIES[state.body].label);
  const near = nearestSite(state.body, lat, lon);
  if (near && near.km < 220) {
    selectSite(near.site.id);
    if (state.twin.active) state.globe?.flyTo(near.site.lat, near.site.lon);
    return;
  }
  const dem = state.dems[state.body];
  const terrain = dem ? dem.sample(lat, lon) : null;
  state.selection = { kind: 'planet-point', body: state.body, lat, lon, terrain, nearest: near };
  if (state.twin.active) {
    state.twin.compare = null;
    state.twin.selectedAnalogId = null;
  }
  renderInspector();
  renderCandidates();
  updateGlobeSites();
  openInspector();
  syncUrlState();
}

function setCoordReadout(lat, lon, label) {
  $('#coord-readout').textContent = `${formatCoord(lat, lon)}${label ? ` · ${label}` : ''}`;
}

/* ---------------------------------------------------------------- twin mode */

function setTwinComparison(profile) {
  const planet = selectedAssessment();
  if (!planet) return;
  state.twin.selectedAnalogId = profile.id;
  state.twin.compare = rankAnalogs({ site: planet.site, terrain: planet.terrain, body: state.body }, [profile])[0] || null;
  state.twin.custom = profile.id === 'custom-earth-point' ? profile : null;
}

function computeTwinRankings() {
  const planet = selectedAssessment();
  if (!planet || state.earthPoolState !== 'ready') {
    state.twin.rankings = [];
    state.twin.allRankings = [];
    return;
  }
  const ranked = rankAnalogs(
    { site: planet.site, terrain: planet.terrain, body: state.body },
    state.earthPool.filter((p) => p.climate || p.terrain),
  );
  state.twin.measuredCount = ranked.length;
  state.twin.allRankings = ranked;
  state.twin.rankings = ranked.slice(0, 5);
}

async function activateTwin() {
  if (state.body === 'earth') {
    toast('Earth Twin Mode starts from a Moon or Mars site. Select a body above.', 'warn');
    return;
  }
  if (!state.selection || state.selection.kind !== 'site') {
    const fallback = state.body === 'moon' ? 'connecting-ridge' : 'jezero';
    selectSite(fallback);
  }
  state.twin.active = true;
  state.twin.planetSiteId = state.selection.siteId;
  state.twin.selectedAnalogId = null;
  state.twin.custom = null;
  app.dataset.view = 'twin';
  $('#twin-toggle').setAttribute('aria-pressed', 'true');
  $('#twin-toggle').classList.add('is-active');
  await ensureEarthMap();
  resizeMaps();
  renderAll();
  if (state.earthPoolState !== 'ready') {
    await ensureEarthPool();
  } else {
    computeTwinRankings();
    const top = state.twin.rankings[0];
    if (top) {
      state.twin.selectedAnalogId = top.earthId;
      state.selection = { kind: 'twin', analogId: top.earthId };
    }
    renderAll();
    state.earthMap?.flyTo(EARTH_ANALOGS.find((a) => a.id === state.twin.selectedAnalogId)?.lat || 10, EARTH_ANALOGS.find((a) => a.id === state.twin.selectedAnalogId)?.lon || 0, 2.2);
  }
  syncUrlState();
}

function deactivateTwin() {
  state.twin.active = false;
  state.twin.rankings = [];
  state.twin.allRankings = [];
  state.twin.measuredCount = 0;
  state.twin.selectedAnalogId = null;
  state.twin.compare = null;
  state.twin.custom = null;
  app.dataset.view = state.body;
  $('#twin-toggle').setAttribute('aria-pressed', 'false');
  $('#twin-toggle').classList.remove('is-active');
  if (state.body === 'earth') {
    state.selection = null;
  } else if (state.selection?.kind === 'twin') {
    state.selection = { kind: 'site', siteId: state.twin.planetSiteId || 'apollo-11' };
  }
  resizeMaps();
  renderAll();
  syncUrlState();
}

function ensureEarthPool() {
  if (state.earthPoolState === 'ready') return Promise.resolve(state.earthPool);
  if (state.earthPoolPromise) return state.earthPoolPromise;
  state.earthPoolState = 'loading';
  updateEarthStatus();
  renderCandidates();
  state.earthPoolPromise = buildPool(EARTH_ANALOGS, ({ done, total, name }) => {
    state.earthPoolProgress = { done, total, name };
    updateEarthStatus();
    if (state.twin.active) renderCandidates();
  })
    .then((pool) => {
      state.earthPool = pool;
      state.earthPoolState = 'ready';
      state.earthPoolPromise = null;
      updateEarthStatus();
      if (state.twin.active) {
        computeTwinRankings();
        const keepCustom = state.twin.custom && state.twin.selectedAnalogId === state.twin.custom.id;
        if (!keepCustom) {
          const top = state.twin.rankings[0];
          if (top) {
            state.twin.selectedAnalogId = top.earthId;
            state.selection = { kind: 'twin', analogId: top.earthId };
          }
        }
        updateEarthMarkers();
        renderAll();
        if (!keepCustom) {
          const sel = EARTH_ANALOGS.find((a) => a.id === state.twin.selectedAnalogId);
          if (sel) state.earthMap?.flyTo(sel.lat, sel.lon, 2.4);
        }
      } else if (state.body === 'earth') {
        rateEarthPool();
      }
      return pool;
    })
    .catch((err) => {
      state.earthPoolState = 'error';
      state.earthPoolPromise = null;
      updateEarthStatus();
      toast(`Earth measurements failed: ${err.message}`, 'error', 9000);
      renderAll();
      return [];
    });
  return state.earthPoolPromise;
}

/* ------------------------------------------------------------------ render */

function renderAll() {
  renderLayers();
  renderPriorities();
  renderCandidates();
  renderStageChrome();
  renderLegend();
  renderMissionStrip();
  renderInspector();
  updateGlobeSites();
  updateEarthMarkers();
  resizeMaps();
}

function renderMissionSelect() {
  const select = $('#mission-select');
  if (state.body === 'earth') {
    select.innerHTML = '<option>Earth analog lab</option>';
    select.disabled = true;
    return;
  }
  select.disabled = false;
  select.innerHTML = Object.values(MISSION_PROFILES)
    .filter((p) => p.body === state.body)
    .map((p) => `<option value="${p.id}" ${p.id === state.missionId ? 'selected' : ''}>${p.label}</option>`)
    .join('');
}

function renderLayers() {
  const body = state.body;
  $('#layers-kicker').textContent = body === 'earth' ? 'Terrestrial observation' : body === 'moon' ? 'Lunar surface' : 'Martian surface';
  const bodyEl = $('#layers-body');

  if (body === 'earth' || state.twin.active) {
    const overlay = EARTH_LAYERS[state.earthOverlay];
    bodyEl.innerHTML = `
      <div class="layer-group">
        <p class="layer-group-title">Basemap</p>
        <label class="layer-row"><input type="radio" name="basemap" value="blue-marble" ${state.basemap === 'blue-marble' ? 'checked' : ''}><span>NASA Blue Marble</span><em>GIBS</em></label>
        <label class="layer-row"><input type="radio" name="basemap" value="satellite" ${state.basemap === 'satellite' ? 'checked' : ''}><span>Satellite imagery</span><em>Esri</em></label>
        <label class="layer-row"><input type="radio" name="basemap" value="topography" ${state.basemap === 'topography' ? 'checked' : ''}><span>Topography</span><em>ASTER</em></label>
      </div>
      <div class="layer-group">
        <p class="layer-group-title">Earth overlays</p>
        <label class="layer-row"><input type="radio" name="earth-overlay" value="none" ${state.earthOverlay === 'none' ? 'checked' : ''}><span>None</span></label>
        <label class="layer-row"><input type="radio" name="earth-overlay" value="albedo" ${state.earthOverlay === 'albedo' ? 'checked' : ''}><span>Surface brightness</span><em>albedo</em></label>
        <label class="layer-row"><input type="radio" name="earth-overlay" value="lst" ${state.earthOverlay === 'lst' ? 'checked' : ''}><span>Land surface temperature</span><em>MODIS</em></label>
        <label class="layer-row"><input type="radio" name="earth-overlay" value="aod" ${state.earthOverlay === 'aod' ? 'checked' : ''}><span>Aerosol optical depth</span><em>MERRA-2</em></label>
      </div>
      <label class="layer-row"><input type="checkbox" id="labels-toggle" ${state.labels ? 'checked' : ''}><span>Place labels</span><em>Esri</em></label>
      <p class="fine">${overlay ? esc(overlay.note) : 'Overlays are display-only NASA GIBS products; numeric extraction is not performed from tile colours.'}</p>`;
    return;
  }

  const terrainButtons = ['elevation', 'slope', 'roughness']
    .map((id) => {
      const def = TERRAIN_LAYERS[id];
      return `<label class="layer-row"><input type="radio" name="planet-layer" value="${id}" ${state.layer === id ? 'checked' : ''}><span>${def.label}</span><em>${def.unit}</em></label>`;
    })
    .join('');
  bodyEl.innerHTML = `
    <div class="layer-group">
      <p class="layer-group-title">Assessment layer</p>
      <label class="layer-row"><input type="radio" name="planet-layer" value="sites" ${state.layer === 'sites' ? 'checked' : ''}><span>Assessed sites</span><em>grades</em></label>
      <p class="fine">Markers are curated site assessments. No interpolated heatmap is drawn between points.</p>
    </div>
    <div class="layer-group">
      <p class="layer-group-title">Measured terrain</p>
      ${terrainButtons}
      <p class="fine">0.25°/px from the bundled ${body === 'moon' ? 'LOLA' : 'MOLA'} DEM. Regional only — not landing-hazard scale.</p>
    </div>
    <label class="layer-row"><input type="checkbox" id="base-toggle" ${state.baseVisible ? 'checked' : ''}><span>NASA imagery basemap</span><em>${body === 'moon' ? 'LROC WAC' : 'Viking'}</em></label>`;
}

function renderPriorities() {
  const wrap = $('#priorities-body');
  if (state.body === 'earth' && !state.twin.active) {
    wrap.innerHTML = `<p class="fine">Mission priorities apply to Moon and Mars site suitability. Switch to a planetary body to adjust them.</p>`;
    $('#reset-priorities').hidden = true;
    return;
  }
  const profile = profileForBody(state.body, state.missionId);
  if (!profile) {
    wrap.innerHTML = '<p class="fine">No mission profile for this body.</p>';
    return;
  }
  $('#reset-priorities').hidden = false;
  const shares = weightShares(profile, state.priorities);
  const shareById = Object.fromEntries(shares.map((s) => [s.id, s.share]));
  wrap.innerHTML = `
    <p class="fine">${esc(profile.description)}</p>
    <div class="sliders">
      ${Object.entries(profile.weights)
        .map(([id]) => {
          const mult = state.priorities[id] ?? 1;
          return `<div class="slider-row">
            <div class="slider-head"><label for="prio-${id}">${esc(FACTORS[id].label)}</label><span class="slider-meta"><b>${pct(shareById[id] || 0)}</b> ×${mult.toFixed(1)}</span></div>
            <input id="prio-${id}" data-priority="${id}" type="range" min="0" max="2" step="0.1" value="${mult}" aria-label="${esc(FACTORS[id].label)} priority multiplier">
          </div>`;
        })
        .join('')}
    </div>
    <p class="fine">Weights renormalise automatically. Multiplying a priority by 0 removes it; all weights are shown as shares of the available total.</p>`;
}

function setCandidateCount(shown, total, label) {
  const el = $('#candidate-count');
  if (!el) return;
  el.textContent = state.search.trim() ? `${shown}/${total}` : `${total} ${label}`;
}

function noSearchResults(kind) {
  return `<div class="no-results"><strong>No matching ${esc(kind)}</strong><p>Try a site, region, country or material class.</p><button class="ghost-btn" type="button" data-clear-search>Clear filter</button></div>`;
}

function renderCandidates() {
  const title = $('#candidates-title');
  const kicker = $('#candidates-kicker');
  const bodyEl = candidatesBody;
  const searchInput = $('#candidate-search');
  if (searchInput && searchInput.value !== state.search) searchInput.value = state.search;
  const query = state.search.trim().toLowerCase();
  const matches = (...values) => !query || values.some((value) => String(value ?? '').toLowerCase().includes(query));

  if (state.twin.active) {
    title.textContent = 'Top 5 Earth analogs';
    kicker.textContent = state.earthPoolState === 'ready' ? `of ${state.twin.measuredCount} measured` : 'live measurements';
    if (state.earthPoolState === 'loading') {
      setCandidateCount(0, 0, 'live');
      const p = state.earthPoolProgress;
      bodyEl.innerHTML = `
        <div class="loading-block"><span class="spinner"></span>
          <p>Fetching NASA POWER climate normals and Copernicus DEM grids for ${EARTH_ANALOGS.length} candidates…</p>
          <div class="progress"><span style="width:${p ? (p.done / p.total) * 100 : 0}%"></span></div>
          <p class="fine">${p ? `${p.done}/${p.total} · ${esc(p.name)}` : 'Starting…'}</p>
        </div>`;
      return;
    }
    if (state.earthPoolState === 'error') {
      setCandidateCount(0, 0, 'offline');
      bodyEl.innerHTML = `<div class="empty-state"><strong>Earth measurements unavailable.</strong><p>The climate/elevation services could not be reached. Similarity cannot be computed without Earth data, and RADIUM will not substitute placeholder values.</p><button class="solid-btn" data-retry-pool type="button">Retry</button></div>`;
      return;
    }
    if (!state.twin.rankings.length) {
      setCandidateCount(0, 0, 'ranked');
      bodyEl.innerHTML = `<div class="empty-state"><p>Select a planetary site to rank analogs.</p></div>`;
      return;
    }
    const allRows = state.twin.rankings.map((row, index) => ({ row, rank: index + 1 }));
    const rows = allRows.filter(({ row }) => {
      const analog = EARTH_ANALOGS.find((a) => a.id === row.earthId);
      return matches(row.earthName, analog?.country, analog?.landform, row.strong?.[0]?.label);
    });
    setCandidateCount(rows.length, allRows.length, 'ranked');
    bodyEl.innerHTML = rows.length ? rows
      .map(({ row: r, rank }) => {
        const analog = EARTH_ANALOGS.find((a) => a.id === r.earthId);
        const top = r.strong[0];
        return `<button type="button" class="candidate-row ${r.earthId === state.twin.selectedAnalogId ? 'is-selected' : ''}" data-analog="${r.earthId}">
          <span class="rank">${String(rank).padStart(2, '0')}</span>
          <span class="cand-main"><strong>${esc(r.earthName)}</strong><em>${esc(analog?.country || '')}${analog && !analog.established ? ' · less-studied candidate' : ''}</em></span>
          <span class="cand-strength">${Math.round(r.score)}/100 · ${top ? `${esc(top.label)} ${pct(top.similarity)}` : 'limited overlap'}</span>
          ${gradeChip(r.grade)}
        </button>`;
      })
      .join('') : noSearchResults('Earth analogs');
    return;
  }

  if (state.body === 'earth') {
    title.textContent = 'Earth similarity estimates';
    kicker.textContent =
      state.earthPoolRatingState === 'loading'
        ? 'rating Earth sites…'
        : state.earthPoolState === 'loading'
          ? 'live climate loading…'
          : 'best of 31 planetary sites';
    const allRows = EARTH_ANALOGS.map((analog, index) => ({ analog, rank: index + 1 }));
    const rows = allRows.filter(({ analog }) => matches(analog.name, analog.country, analog.substrateGroup, analog.landform));
    setCandidateCount(rows.length, allRows.length, 'sites');
    bodyEl.innerHTML = rows.length ? rows.map(
      ({ analog: a, rank }) => {
        const best = state.earthMatches[a.id]?.[0];
        const strength = best
          ? `${Math.round(best.score)}/100 · mimics ${best.planetSite.name}`
          : state.earthPoolState === 'loading' || state.earthPoolRatingState === 'loading'
            ? 'Measuring…'
            : state.earthMatchErrors[a.id]
              ? 'Match unavailable'
              : 'Open to rate';
        return `<button type="button" class="candidate-row ${state.selection?.kind === 'earth' && state.selection.profile?.id === a.id ? 'is-selected' : ''}" data-analog="${a.id}">
          <span class="rank">${String(rank).padStart(2, '0')}</span>
          <span class="cand-main"><strong>${esc(a.name)}</strong><em>${esc(a.country)} · ${humanize(a.substrateGroup)}</em></span>
          <span class="cand-strength">${esc(strength)}</span>
          ${gradeChip(best?.grade ?? UNRATED)}
        </button>`;
      },
    ).join('') : noSearchResults('Earth sites');
    return;
  }

  title.textContent = 'Mission suitability';
  const allRows = sortedAssessments().map((row, index) => ({ row, rank: index + 1 }));
  kicker.textContent = `${MISSION_PROFILES[state.missionId]?.short || ''} · ${allRows.length} sites`;
  const rows = allRows.filter(({ row }) => matches(row.site.name, row.site.region, row.result?.strengths?.[0]?.label, row.site.summary));
  setCandidateCount(rows.length, allRows.length, 'sites');
  bodyEl.innerHTML = rows.length ? rows.map(({ row: r, rank }) => {
    const strength = r.result?.strengths?.[0];
    return `<button type="button" class="candidate-row ${r.site.id === state.selection?.siteId ? 'is-selected' : ''}" data-site="${r.site.id}">
      <span class="rank">${String(rank).padStart(2, '0')}</span>
      <span class="cand-main"><strong>${esc(r.site.name)}</strong><em>${esc(r.site.region)}</em></span>
      <span class="cand-strength">${strength ? `${esc(strength.label)} ${Math.round(strength.score)}` : 'Coverage limited'}</span>
      ${gradeChip(r.grade)}
    </button>`;
  }).join('') : noSearchResults('planetary sites');
}

function renderStageChrome() {
  const bodyMeta = BODIES[state.body];
  const twin = state.twin.active;
  $('#globe-tag').textContent = twin ? `${bodyMeta.label} · selected site` : `${bodyMeta.label} · 3D globe`;
  $('#earth-tag').textContent = 'Earth · 2D map · live measurements';
  const title = $('#stage-title');
  const sub = $('#stage-sub');
  if (twin) {
    title.textContent = `${bodyMeta.label} ↔ Earth`;
    sub.textContent = 'Earth Twin Mode · top five analogs, or click anywhere on Earth to compare';
  } else if (state.body === 'earth') {
    title.textContent = 'Earth';
    sub.textContent = 'NASA GIBS layers · each site is scored against its closest Moon or Mars match';
  } else {
    title.textContent = `${bodyMeta.label} · ${MISSION_PROFILES[state.missionId]?.label || ''}`;
    sub.textContent = 'Click a grade pin or anywhere on the surface for measurements';
  }
  const hint = $('#map-hint');
  hint.innerHTML =
    state.body === 'earth' || twin
      ? '<span>Drag to pan</span><span>Scroll to zoom</span><span>Click a pin or the map</span>'
      : '<span>Drag to rotate</span><span>Scroll to zoom</span><span>Click to analyse</span>';
  $('#attribution').textContent = twin
    ? 'Moon/Mars imagery: NASA LRO LROC, MGS Viking (Solar System Treks) · Earth: NASA GIBS · Climate: NASA POWER · DEM: LOLA, MOLA, Copernicus'
    : state.body === 'earth'
      ? 'Earth: NASA Blue Marble / ASTER GDEM / MODIS / MERRA-2 via GIBS · Labels © Esri · Climate: NASA POWER'
      : `Imagery: ${bodyMeta.mapCredit} · DEM: ${state.body === 'moon' ? 'LRO LOLA' : 'MGS MOLA'} 4 ppd · Temperatures: published Diviner/TES climatology`;
  $('#stage-note').innerHTML =
    state.layer !== 'sites' && state.body !== 'earth' && !twin
      ? `<strong>${esc(TERRAIN_LAYERS[state.layer].label)}</strong> · ${esc(TERRAIN_LAYERS[state.layer].method)}`
      : '';
}

function renderLegend() {
  const el = $('#legend');
  const earthActive = state.body === 'earth' || state.twin.active;

  if (earthActive && state.earthOverlay !== 'none') {
    const def = EARTH_LAYERS[state.earthOverlay];
    el.innerHTML = `
      <div class="legend-head"><span>${esc(def.title)}</span><em>${esc(def.unit)}</em></div>
      <div class="legend-image-wrap">${def.legendUrl ? `<img src="${def.legendUrl}" alt="Legend for ${esc(def.title)}" loading="lazy" onerror="this.classList.add('is-missing');this.nextElementSibling.hidden=false"><div class="fallback-ramp" hidden style="background:${def.fallbackGradient}"></div>` : `<div class="fallback-ramp" style="background:${def.fallbackGradient}"></div>`}</div>
      <div class="legend-ticks">${def.fallbackTicks.map((t, i) => `<span style="left:${(i / Math.max(1, def.fallbackTicks.length - 1)) * 100}%">${esc(t)}</span>`).join('')}</div>
      <p class="legend-note">${esc(def.note)}</p>`;
    return;
  }

  if (earthActive && state.basemap === 'topography') {
    const def = EARTH_BASEMAPS.topography;
    el.innerHTML = `
      <div class="legend-head"><span>${esc(def.title)}</span><em>${esc(def.unit)}</em></div>
      <div class="fallback-ramp" style="background:${def.fallbackGradient}"></div>
      <div class="legend-ticks">${def.fallbackTicks.map((t, i) => `<span style="left:${(i / Math.max(1, def.fallbackTicks.length - 1)) * 100}%">${esc(t)}</span>`).join('')}</div>
      <p class="legend-note">${esc(def.note)}</p>`;
    return;
  }

  if (!earthActive && state.layer !== 'sites') {
    const dem = state.dems[state.body];
    if (!dem) {
      el.innerHTML = '<p class="legend-note">DEM not loaded.</p>';
      return;
    }
    const raster = buildTerrainRaster(dem, state.layer, state.body);
    const legend = raster.legend;
    el.innerHTML = `
      <div class="legend-head"><span>${esc(legend.title)}</span><em>${esc(legend.unit)}</em></div>
      <div class="ramp" style="background:${legend.gradient}"></div>
      <div class="legend-ticks">${legend.ticks.map((t) => `<span style="left:${t.pos * 100}%">${esc(t.label)}</span>`).join('')}</div>
      <p class="legend-note">${esc(legend.note)}</p>
      <p class="legend-source">${esc(legend.sourceLabel)}</p>`;
    return;
  }

  el.innerHTML = `
    <div class="legend-head"><span>${earthActive ? 'Earth similarity estimates' : 'Site suitability'}</span><em>${earthActive ? '0–100' : 'letters'}</em></div>
    <div class="legend-grades">${['A', 'B', 'C', 'D', 'F'].map((g) => `${gradeChip(g)}<span>${gradeMeta(g).label}</span>`).join('')}</div>
    <p class="legend-note">${earthActive ? 'Each pin is scored against the Moon or Mars site it most closely resembles, using every available comparable measurement. Twin Mode ranks the top five Earth analogs for a selected planetary site and also compares any clicked Earth coordinate.' : 'Letter grades from the weighted mission assessment. Hover a pin for its name; click for evidence.'}</p>`;
}

function resizeMaps() {
  requestAnimationFrame(() => {
    state.globe?.resize();
    state.earthMap?.resize();
  });
}

/* --------------------------------------------------------------- inspector */

function inspectorShell(content) {
  return `<div class="inspector-scroll">${content}</div>`;
}

function renderInspector() {
  if (!inspector) return;
  if (state.selection?.kind === 'site') {
    inspector.innerHTML = inspectorShell(renderSiteInspector());
  } else if (state.selection?.kind === 'planet-point') {
    inspector.innerHTML = inspectorShell(renderPlanetPointInspector());
  } else if (state.selection?.kind === 'earth-loading') {
    inspector.innerHTML = inspectorShell(`
      <div class="inspector-head"><p class="eyebrow">${state.selection.twin ? 'Earth Twin Mode · clicked coordinate' : 'Earth measurements'}</p><h2>${esc(state.selection.name || 'Custom point')}</h2>
      <p class="coord-line">${formatCoord(state.selection.lat, state.selection.lon)}</p></div>
      <div class="loading-block"><span class="spinner"></span><p>Fetching NASA POWER climate normals and Copernicus DEM samples for this coordinate…</p></div>`);
  } else if (state.selection?.kind === 'earth-error') {
    inspector.innerHTML = inspectorShell(`
      <div class="inspector-head"><p class="eyebrow">Earth measurements</p><h2>${esc(state.selection.name)}</h2></div>
      <div class="empty-state"><strong>Data unavailable.</strong><p>${esc(state.selection.message)}</p><p>RADIUM does not fill missing measurements with estimates presented as observations.</p></div>`);
  } else if (state.selection?.kind === 'earth') {
    inspector.innerHTML = inspectorShell(renderEarthInspector());
  } else if (state.selection?.kind === 'twin') {
    inspector.innerHTML = inspectorShell(renderTwinInspector());
  } else if (state.body === 'earth') {
    inspector.innerHTML = inspectorShell(renderEarthIntro());
  } else {
    inspector.innerHTML = inspectorShell(renderEmptyInspector());
  }
  scheduleThumb();
}

function contextFigure(caption) {
  return `<figure class="context-figure">
    <canvas id="ctx-thumb" width="384" height="256" aria-label="Context satellite imagery around the selected coordinates"></canvas>
    <figcaption id="ctx-caption">${esc(caption || 'Loading context imagery…')}</figcaption>
  </figure>`;
}

let thumbToken = 0;
function scheduleThumb() {
  const canvas = document.getElementById('ctx-thumb');
  if (!canvas) return;
  const token = ++thumbToken;
  const sel = state.selection;
  if (!sel) return;
  let body;
  let lat;
  let lon;
  if (sel.kind === 'site' || sel.kind === 'twin') {
    const row = sel.kind === 'site' ? selectedAssessment() : selectedAssessment();
    if (!row) return;
    body = row.site.body;
    lat = row.site.lat;
    lon = row.site.lon;
  } else if (sel.kind === 'planet-point') {
    body = sel.body;
    lat = sel.lat;
    lon = sel.lon;
  } else if (sel.kind === 'earth') {
    body = 'earth';
    lat = sel.profile.lat;
    lon = sel.profile.lon;
  } else {
    return;
  }
  drawContextThumb(canvas, { body, lat, lon }).then((res) => {
    if (token !== thumbToken) return;
    const cap = document.getElementById('ctx-caption');
    if (!cap) return;
    cap.innerHTML = res.ok
      ? `${esc(res.credit)} · crosshair marks the selected coordinate`
      : `Context imagery unavailable (${esc(res.reason)}). No substitute photograph is shown.`;
  });

  const earthCanvas = document.getElementById('ctx-thumb-earth');
  if (earthCanvas) {
    const profile = state.earthPool.find((p) => p.id === state.twin.selectedAnalogId) || state.twin.custom;
    if (profile) {
      drawContextThumb(earthCanvas, { body: 'earth', lat: profile.lat, lon: profile.lon }).then((res) => {
        if (token !== thumbToken) return;
        const cap = document.getElementById('ctx-caption-earth');
        if (!cap) return;
        cap.innerHTML = res.ok ? `${esc(res.credit)} · crosshair marks the Earth analog` : 'Earth imagery unavailable.';
      });
    }
  }
}

/** One grade-coloured 0–100 bar used by mission factors and similarity dimensions. */
function systemBar({ labelHtml, grade, score, number, value, meta, detail = '', missing = false }) {
  const width = score === null || score === undefined ? 0 : Math.max(0, Math.min(100, score));
  return `<div class="system-bar grade-${grade && grade !== UNRATED ? grade : 'U'}${missing ? ' is-missing' : ''}" title="${esc(detail)}">
    <div class="bar-head">
      <span class="bar-label">${labelHtml}</span>
      <span class="bar-number">${number}${grade && grade !== UNRATED ? `<span class="grade-chip grade-${grade}">${grade}</span>` : ''}</span>
    </div>
    <div class="bar-track"><span class="bar-fill" style="width:${width.toFixed(1)}%"></span></div>
    <div class="bar-foot"><span>${value}</span><span>${meta}</span></div>
  </div>`;
}

function renderFactorBars(factors) {
  return `<div class="system-bars">${factors
    .map((f) => systemBar({
      labelHtml: `${esc(f.label)}${evidenceChip(f.evidence)}`,
      grade: f.available ? letterGrade(f.score) : null,
      score: f.available ? f.score : null,
      number: f.available ? Math.round(f.score) : '—',
      value: f.available
        ? `${esc(typeof f.raw === 'number' ? round(f.raw, f.unit === '°' ? 1 : 1) : humanize(f.raw))} <small>${esc(f.unit || '')}</small>`
        : '<span class="na">Data unavailable.</span>',
      meta: f.available ? `${pct(f.effectiveWeight)} of mission weight` : 'Not weighted',
      detail: f.detail,
      missing: !f.available,
    }))
    .join('')}</div>`;
}

function renderDecisionBrief(result) {
  if (!result) return '';
  const strength = result.strengths?.[0];
  const limiting = result.weakest?.[0];
  if (!strength && !limiting) return '';
  return `<div class="decision-strip" aria-label="Decision-support summary">
    ${strength ? `<div class="decision-card">
      <span class="decision-label">Primary strength</span>
      <strong title="${esc(strength.label)}: ${esc(strength.detail)} — ${Math.round(strength.score)}/100">${esc(strength.label)}</strong>
      <em>${Math.round(strength.score)}/100 · ${pct(strength.effectiveWeight)} of weight</em>
    </div>` : ''}
    ${limiting ? `<div class="decision-card is-watch">
      <span class="decision-label">Limiting factor</span>
      <strong title="${esc(limiting.label)}: ${esc(limiting.detail)} — ${Math.round(limiting.score)}/100">${esc(limiting.label)}</strong>
      <em>${Math.round(limiting.score)}/100 · ${pct(limiting.effectiveWeight)} of weight</em>
    </div>` : ''}
  </div>`;
}

function renderDiscoveryBlock(candidates) {
  if (!candidates.length) return '';
  return `<section class="panel-section">
    <div class="section-head"><h3>Less-studied in the top five</h3><span class="fine">data-driven</span></div>
    <div class="discovery-list">
      ${candidates
        .map((c, i) => `<button type="button" class="discovery-row ${c.earthId === state.selection?.profile?.id || c.earthId === state.twin.selectedAnalogId ? 'is-selected' : ''}" data-action="open-analog" data-analog="${c.earthId}">
          <span class="rank">${String(i + 1).padStart(2, '0')}</span>
          <span class="discovery-main"><strong>${esc(c.earth.name)}</strong><em>${esc(c.earth.country)} · ${esc(c.why)}</em></span>
          <span class="discovery-score">${Math.round(c.score)}${gradeChip(c.grade)}</span>
        </button>`)
        .join('')}
    </div>
    <p class="fine">Only less-studied candidates that earned a place in the top five are shown. This is a statistical shortlist, not a newly discovered field site or confirmed mission analog. Established analog sites are excluded here on purpose.</p>
  </section>`;
}

function renderSpaceComparison(matches, profile) {
  const rows = (matches || []).slice(0, 5);
  if (rows.length < 2) return '';
  return `<section class="panel-section">
    <div class="section-head"><h3>Top 5 space analogs</h3><span class="fine">Moon &amp; Mars · best first</span></div>
    <p class="fine">Rated against <strong>${esc(profile.name)}</strong>. Columns are planetary sites, not Earth analogs; the Earth measurement is repeated inside each cell for comparison.</p>
    <div class="table-scroll"><table class="top-five-table space-table">
      <thead><tr><th>Metric</th>${rows.map((r, i) => `<th><span>#${i + 1} · ${esc(BODIES[r.planetBody]?.label || r.planetBody)}</span>${esc(r.planetSite.name)}</th>`).join('')}</tr></thead>
      <tbody>
        <tr><th>Similarity score</th>${rows.map((r) => `<td><span class="top-five-score">${Math.round(r.score)}</span> ${gradeChip(r.grade)}<div class="top-five-mini"><span style="width:${Math.round(r.score)}%"></span></div></td>`).join('')}</tr>
        <tr><th>Coverage</th>${rows.map((r) => `<td>${pct(r.coverage)}</td>`).join('')}</tr>
        ${SIMILARITY_DIMENSIONS.map((def) => `<tr><th>${esc(def.label)}</th>${rows.map((r) => {
          const d = r.dimensions.find((x) => x.id === def.id);
          if (!d?.available) return '<td><span class="na">Data unavailable.</span></td>';
          const width = Math.max(0, Math.min(100, d.similarity * 100));
          return `<td>${formatDimValue(d.id, d.planetValue)}<span>${pct(d.similarity)} match · Earth ${formatDimValue(d.id, d.earthValue)} ${gradeChip(d.grade)}</span><div class="top-five-mini"><span style="width:${width.toFixed(1)}%"></span></div></td>`;
        }).join('')}</tr>`).join('')}
        <tr><th>Site context</th>${rows.map((r) => `<td>${esc(BODIES[r.planetBody]?.label || r.planetBody)}<span>${esc(r.planetSite.region || '')}</span></td>`).join('')}</tr>
        <tr><th>Strongest overlap</th>${rows.map((r) => `<td>${r.strong[0] ? `${esc(r.strong[0].label)}<span>${pct(r.strong[0].similarity)}</span>` : '<span class="na">None above threshold.</span>'}</td>`).join('')}</tr>
        <tr><th>Weakest overlap</th>${rows.map((r) => `<td>${r.weak[0] ? `${esc(r.weak[0].label)}<span>${pct(r.weak[0].similarity)}</span>` : '<span class="na">None below threshold.</span>'}</td>`).join('')}</tr>
      </tbody>
    </table></div>
    <p class="fine">These are the five closest Moon/Mars sites for this Earth location, ranked across all 31 curated planetary sites. Every dimension cell includes its own 0–100 match grade; no Earth-to-Earth analog ranking is used here.</p>
  </section>`;
}

function renderTopFiveComparison() {
  const rows = state.twin.rankings.slice(0, 5);
  if (rows.length < 2) return '';
  const planet = selectedAssessment();
  if (!planet) return '';
  const profiles = new Map(state.earthPool.map((p) => [p.id, p]));
  const contextCell = (value, suffix = '', digits = 0) => Number.isFinite(value) ? `${round(value, digits)}${suffix}` : '<span class="na">Data unavailable.</span>';
  return `<section class="panel-section">
    <div class="section-head"><h3>Top 5 compare &amp; contrast</h3><span class="fine">only these five compared</span></div>
    <div class="table-scroll"><table class="top-five-table">
      <thead><tr><th>Metric</th>${rows.map((r, i) => `<th><span>#${i + 1}</span>${esc(r.earthName)}</th>`).join('')}</tr></thead>
      <tbody>
        <tr><th>Similarity score</th>${rows.map((r) => `<td><span class="top-five-score">${Math.round(r.score)}</span> ${gradeChip(r.grade)}<div class="top-five-mini"><span style="width:${Math.round(r.score)}%"></span></div></td>`).join('')}</tr>
        <tr><th>Coverage</th>${rows.map((r) => `<td>${pct(r.coverage)}</td>`).join('')}</tr>
        ${SIMILARITY_DIMENSIONS.map((def) => `<tr><th>${esc(def.label)}</th>${rows.map((r) => {
          const d = r.dimensions.find((x) => x.id === def.id);
          return `<td>${d?.available ? `${formatDimValue(d.id, d.earthValue)}<span>${pct(d.similarity)} match</span>` : '<span class="na">Data unavailable.</span>'}</td>`;
        }).join('')}</tr>`).join('')}
        <tr><th>Earth albedo</th>${rows.map((r) => `<td>${contextCell(profiles.get(r.earthId)?.climate?.albedo !== null && profiles.get(r.earthId)?.climate?.albedo !== undefined ? profiles.get(r.earthId).climate.albedo * 100 : null, '%', 1)}</td>`).join('')}</tr>
        <tr><th>Aridity index</th>${rows.map((r) => `<td>${contextCell(profiles.get(r.earthId)?.climate?.aridityIndex, '', 2)}</td>`).join('')}</tr>
        <tr><th>Elevation</th>${rows.map((r) => `<td>${contextCell(profiles.get(r.earthId)?.terrain?.elevationM, ' m')}</td>`).join('')}</tr>
        <tr><th>Strongest overlap</th>${rows.map((r) => `<td>${r.strong[0] ? `${esc(r.strong[0].label)}<span>${pct(r.strong[0].similarity)}</span>` : '<span class="na">None above threshold.</span>'}</td>`).join('')}</tr>
        <tr><th>Weakest overlap</th>${rows.map((r) => `<td>${r.weak[0] ? `${esc(r.weak[0].label)}<span>${pct(r.weak[0].similarity)}</span>` : '<span class="na">None below threshold.</span>'}</td>`).join('')}</tr>
      </tbody>
    </table></div>
    <p class="fine">Against <strong>${esc(planet.site.name)}</strong>. The matrix uses every comparable measurement held for both sides; albedo, aridity and elevation are Earth context and are not added to the similarity score. No sixth candidate is included.</p>
  </section>`;
}

function renderSiteInspector() {
  const row = selectedAssessment();
  if (!row) return '<p>No site selected.</p>';
  const { site, terrain, result } = row;
  const grade = result?.grade;
  const meta = gradeMeta(grade);
  const solar = effectiveSolar(site);
  const profile = profileForBody(state.body, state.missionId);
  const factors = result?.factors || [];
  const availableCount = factors.filter((f) => f.available).length;
  const irradiance = meanSurfaceIrradiance(site);

  return `
    <div class="inspector-head">
      <p class="eyebrow">${esc(BODIES[state.body].label)} · ${esc(site.region)}</p>
      <h2>${esc(site.name)}</h2>
      <p class="coord-line">${formatCoord(site.lat, site.lon)} <button class="mini-btn" data-action="copy" data-lat="${site.lat}" data-lon="${site.lon}" type="button">copy</button></p>
    </div>
    ${contextFigure()}
    <div class="grade-hero grade-${grade || 'U'}">
      <div class="grade-orb">${grade || UNRATED}</div>
      <div class="grade-copy">
        <p class="grade-label">${meta.label} suitability</p>
        <p class="grade-sub">${esc(profile?.label || '')} · ${availableCount}/${factors.length} factors with data</p>
        <div class="chip-row">
          <span class="pill">Coverage ${pct(result?.coverage ?? 0)}</span>
          <span class="pill">Confidence ${confidenceLabel(result?.confidence)}</span>
        </div>
      </div>
    </div>
    ${result?.violations?.length ? `<div class="alert alert-fail"><strong>Hard screen violated.</strong> ${esc(result.violations[0].label)} Measured value ${round(result.violations[0].value, 1)}${result.violations[0].factor === 'slope' ? '°' : ''}.</div>` : ''}
    ${result?.ratingNote ? `<p class="fine">${esc(result.ratingNote)}</p>` : ''}
    ${state.lastRecalc ? `<div class="recalc-note">${esc(state.lastRecalc)}</div>` : ''}
    ${renderDecisionBrief(result)}
    <div class="action-row">
      <button type="button" class="solid-btn" data-action="twin">${state.twin.active ? 'Recompute Earth analogs' : 'Find Earth analogs'}</button>
      <button type="button" class="ghost-btn" data-action="fly">Center map</button>
      <button type="button" class="ghost-btn" data-action="share">Copy analysis link</button>
    </div>
    <p class="fine compare-armed"><strong>Earth comparison:</strong> open Earth to see every site scored against its closest Moon or Mars match, or use Earth Twin Mode for a direct head-to-head with ${esc(site.name)}.</p>
    <p class="summary">${esc(site.summary)}</p>

    <section class="panel-section">
      <div class="section-head"><h3>System factor bars</h3><span class="fine">0–100 · every mission factor</span></div>
      ${renderFactorBars(factors)}
      <p class="fine">${esc(result?.caveat || '')}</p>
    </section>

    <section class="panel-section">
      <div class="section-head"><h3>Terrain measurements</h3><span class="fine">${esc(terrain?.datasetLabel || 'DEM unavailable')}</span></div>
      ${terrain ? `<dl class="metric-grid">
        <div><dt>Elevation</dt><dd>${Math.round(terrain.elevationM)} <small>m</small></dd><span>${state.body === 'mars' ? `≈ ${round(marsPressureKPa(terrain.elevationM), 2)} kPa mean pressure (model)` : 'relative to 1737.4 km datum'}</span></div>
        <div><dt>Regional slope</dt><dd>${round(terrain.slopeDeg, 1)} <small>°</small></dd><span>Horn 3×3</span></div>
        <div><dt>Roughness</dt><dd>${round(terrain.roughnessM, 0)} <small>m σ</small></dd><span>${Math.round(terrain.windowKm)} km window</span></div>
        <div><dt>DEM scale</dt><dd>${terrain.resolutionKm} <small>km/px</small></dd><span>Regional, not local</span></div>
      </dl>` : '<p class="na">DEM coverage unavailable at this coordinate.</p>'}
    </section>

    <section class="panel-section">
      <div class="section-head"><h3>Environment & resources</h3></div>
      <dl class="metric-list">
        <div><dt>Mean surface temperature</dt><dd>${site.tempMeanK ? `${Math.round(site.tempMeanK.value)} ± ${Math.round(site.tempMeanK.uncertainty)} K` : 'Data unavailable.'}</dd>${evidenceChip(site.tempMeanK?.evidence)}<p>${esc(site.tempMeanK?.note || '')}</p></div>
        <div><dt>Diurnal amplitude</dt><dd>${site.tempAmpK ? `${Math.round(site.tempAmpK.value)} ± ${Math.round(site.tempAmpK.uncertainty)} K` : 'Data unavailable.'}</dd>${evidenceChip(site.tempAmpK?.evidence)}</div>
        <div><dt>Solar energy</dt><dd>${pct(solar.value, 1)} of solar constant</dd>${evidenceChip(solar.evidence)}<p>${esc(solar.note)}</p>
        ${solar.publishedIllumination ? `<p class="pub-illum">Published illumination: <b>${pct(solar.publishedIllumination.value)}</b> ± ${pct(solar.publishedIllumination.uncertainty || 0)} of the year sunlit. ${esc(solar.publishedIllumination.note || '')}</p>` : ''}</div>
        <div><dt>Luminosity</dt><dd>${irradiance ? `${Math.round(irradiance.value)} <small>W/m²</small>` : 'Data unavailable.'}</dd>${irradiance ? evidenceChip(irradiance.evidence) : ''}<p>${esc(irradiance?.note || 'No orbital irradiance available for this body.')}</p></div>
        <div><dt>Ice / volatile evidence</dt><dd>${site.ice ? `${humanize(site.ice.class)} · index ${Math.round(site.ice.score)}/100` : 'Data unavailable.'}</dd>${evidenceChip(site.ice?.evidence)}<p>${esc(site.ice?.note || '')}</p></div>
        ${site.earthVisibility ? `<div><dt>Earth visibility</dt><dd>${pct(site.earthVisibility.value)} geometric</dd>${evidenceChip(site.earthVisibility.evidence)}<p>${esc(site.earthVisibility.note)}</p></div>` : ''}
        ${site.dustRisk ? `<div><dt>Dust exposure</dt><dd>${humanize(site.dustRisk.class)}</dd>${evidenceChip('assessment')}<p>${esc(site.dustRisk.basis)}</p></div>` : ''}
      </dl>
    </section>

    <section class="panel-section">
      <div class="section-head"><h3>Evidence & limitations</h3></div>
      ${site.coordinateNote ? `<p class="fine"><strong>Coordinate note.</strong> ${esc(site.coordinateNote)}</p>` : ''}
      ${site.hazards?.length ? `<p class="fine"><strong>Operational hazards.</strong> ${site.hazards.map(esc).join(' · ')}</p>` : ''}
      ${result?.missing?.length ? `<div class="missing-block"><p><strong>Data unavailable for:</strong></p><ul>${result.missing.map((m) => `<li>${esc(m.label)} — ${esc(m.reason)}</li>`).join('')}</ul><p class="fine">These factors are excluded from the score; remaining weights are renormalised and coverage is reduced.</p></div>` : '<p class="fine">All mission factors have data for this site.</p>'}
      <p class="caveat">${MISSION_CAVEAT}</p>
    </section>

    <details class="calc-details">
      <summary>Show weighted calculation</summary>
      <div class="calc-body">
        <p class="formula">S = Σ (wᵢ · sᵢ) / Σ wᵢ</p>
        <p>Weighted score: <b>${result?.score ?? '—'}</b>/100 · coverage ${pct(result?.coverage ?? 0)} · confidence ${round(result?.confidence ?? 0, 2)}</p>
        <ul>${factors.filter((f) => f.available).sort((a, b) => b.contribution - a.contribution).map((f) => `<li>${esc(f.label)}: ${round(f.score, 0)} × ${pct(f.effectiveWeight)} = ${round(f.contribution, 1)}</li>`).join('')}</ul>
      </div>
    </details>

    <section class="panel-section">
      <div class="section-head"><h3>Sources</h3></div>
      <ul class="source-list">${sourceLinks(site.sources)}</ul>
    </section>`;
}

function renderPlanetPointInspector() {
  const sel = state.selection;
  const terrain = sel.terrain;
  const near = sel.nearest;
  return `
    <div class="inspector-head">
      <p class="eyebrow">${esc(BODIES[sel.body].label)} · selected coordinate</p>
      <h2>Terrain-only inspection</h2>
      <p class="coord-line">${formatCoord(sel.lat, sel.lon)}</p>
    </div>
    ${contextFigure()}
    <div class="alert alert-info"><strong>No graded site assessment here.</strong> RADIUM's temperature, ice and illumination records are curated at named sites, not global rasters. Only DEM-derived terrain is measured at an arbitrary coordinate, so no letter grade is issued.</div>
    ${terrain ? `<dl class="metric-grid">
      <div><dt>Elevation</dt><dd>${Math.round(terrain.elevationM)} <small>m</small></dd><span>${esc(terrain.datasetLabel)}</span></div>
      <div><dt>Regional slope</dt><dd>${round(terrain.slopeDeg, 1)} <small>°</small></dd><span>Horn 3×3</span></div>
      <div><dt>Roughness</dt><dd>${round(terrain.roughnessM, 0)} <small>m σ</small></dd><span>${Math.round(terrain.windowKm)} km window</span></div>
      <div><dt>Resolution</dt><dd>${terrain.resolutionKm} <small>km/px</small></dd><span>Regional scale</span></div>
    </dl>` : '<p class="na">Data unavailable at this coordinate.</p>'}
    ${sel.body === 'mars' && terrain ? `<p class="fine">Mean atmospheric pressure ≈ <b>${round(marsPressureKPa(terrain.elevationM), 2)} kPa</b> from a barometric approximation (scale height 11.1 km), not a measured pressure.</p>` : ''}
    ${near ? `<div class="nearest-block"><p><strong>Nearest curated site:</strong> ${esc(near.site.name)} · ${Math.round(near.km)} km away</p><button type="button" class="solid-btn" data-action="nearest" data-site="${near.site.id}">Assess ${esc(near.site.name)}</button></div>` : ''}
    <div class="action-row"><button type="button" class="ghost-btn" data-action="share">Copy analysis link</button></div>
    <p class="caveat">Arbitrary-coordinate measurements are limited to the 0.25°/px DEM. Landing-hazard analysis needs metre-scale data that RADIUM does not bundle.</p>`;
}

function renderEarthIntro() {
  return `
    <div class="inspector-head">
      <p class="eyebrow">Earth · terrestrial analogs</p>
      <h2>What does each Earth site resemble?</h2>
      <p class="lede">RADIUM rates all ${EARTH_ANALOGS.length} curated Earth candidates against every Moon and Mars site. Every map click also gets an experimental score from live climate, multi-scale terrain, soil and volcanic-context data.</p>
    </div>
    <div class="alert alert-info"><strong>Closest planetary match.</strong><p>Every Earth pin and clicked coordinate is scored against the Moon or Mars site it most closely resembles. For a direct side-by-side with a chosen planetary site, use Earth Twin Mode.</p></div>
    <div class="steps">
      <div><span>1</span><p>Earth sites are measured with live NASA POWER climate and Copernicus DEM terrain.</p></div>
      <div><span>2</span><p>The closest curated Moon or Mars site sets the overall match grade.</p></div>
      <div><span>3</span><p>Open any candidate for its eight-factor profile, factor bars and the explicit gaps RADIUM does not rate.</p></div>
    </div>
    <p class="fine">Earth grades are analog-similarity grades, not mission-suitability grades. Every pin carries a 0–100 estimate from its closest curated Moon or Mars match, using all available comparable measurements.</p>
    <div class="action-row"><button type="button" class="solid-btn" data-action="go-moon">Choose a lunar site</button><button type="button" class="ghost-btn" data-action="go-mars">Choose a Mars site</button></div>
    <p class="caveat">${MISSION_CAVEAT}</p>`;
}

function renderMimicBlock(matches) {
  if (!matches.length) return '';
  return `<section class="panel-section">
    <div class="section-head"><h3>Closest planetary matches</h3><span class="fine">best first</span></div>
    <div class="mimic-list">
      ${matches
        .slice(0, 3)
        .map(
          (m, i) => `<div class="mimic-row ${i === 0 ? 'is-best' : ''}">
            <span class="rank">${String(i + 1).padStart(2, '0')}</span>
            <span class="mimic-main"><strong>${esc(m.planetSite.name)}</strong><em>${esc(BODIES[m.planetBody]?.label || m.planetBody)} · ${esc(gradeMeta(m.grade).label)} analog match</em></span>
            ${gradeChip(m.grade)}
          </div>`,
        )
        .join('')}
    </div>
    <p class="fine">The best match sets the overall grade and the eight-factor profile. Ranked across ${matches.length} curated planetary sites using the comparable dimensions.</p>
  </section>`;
}

function renderEarthFactorSection(compare) {
  const factors = earthFactorGrades(compare);
  return `<section class="panel-section">
    <div class="section-head"><h3>Eight-factor analog profile</h3><span class="fine">letters, gaps shown</span></div>
    <p class="fine">Compared with <strong>${esc(compare.planetSite?.name || 'the selected planetary site')}</strong>. Factor grades describe resemblance, not standalone Earth suitability.</p>
    <div class="earth-factor-list">
      ${factors
        .map(
          (f) => `<article class="earth-factor-row ${f.available ? '' : 'is-missing'}">
            <div class="earth-factor-grade">${f.available ? gradeChip(f.grade) : `<span class="na">${UNRATED}</span>`}</div>
            <div class="earth-factor-copy">
              <div class="earth-factor-title"><strong>${esc(f.label)}</strong>${f.available && !f.partial ? '' : `<span class="factor-status">${f.available ? 'partial' : 'not assessed'}</span>`}</div>
              <p>${esc(f.available ? f.note : f.unratedReason)}</p>
              ${f.available ? `<div class="earth-factor-bar"><span style="width:${(f.similarity * 100).toFixed(1)}%"></span></div><span class="dim-weight">${Math.round(f.similarity * 100)}/100 similarity · ${pct(f.coverage)} of match weight</span>` : '<span class="dim-weight">No bar issued: data unavailable</span>'}
            </div>
          </article>`,
        )
        .join('')}
    </div>
    <p class="fine"><strong>Not invented:</strong> dust/wind/erosion, biology/biosignatures and subsurface factors remain unrated because RADIUM has no comparable measurements for both sides. The operations row is terrain-only.</p>
  </section>`;
}

function renderBrightnessFactors(c) {
  const cls = brightnessClass(c.albedo);
  return `<section class="panel-section">
    <div class="section-head"><h3>Brightness factors</h3><span class="fine">surface reflectivity</span></div>
    <dl class="metric-list">
      <div><dt>Annual surface albedo</dt><dd>${c.albedo !== null && c.albedo !== undefined ? pct(c.albedo, 1) : 'Data unavailable.'}</dd>${c.albedo !== null && c.albedo !== undefined ? evidenceChip('modeled') : ''}<p>Fraction of incident shortwave radiation reflected by the surface, from NASA POWER/MERRA-2. It is a broadband climate albedo, not a visible-light photograph or a brightness temperature.</p></div>
      <div><dt>Brightness class</dt><dd>${cls ? esc(cls.label) : 'Data unavailable.'}</dd><p>${cls ? `${esc(cls.note)} RADIUM display class; not a mission-suitability grade.` : 'No albedo value is available, so RADIUM does not assign a brightness class.'}</p></div>
      <div><dt>Incident solar resource</dt><dd>${c.solarFraction !== null && c.solarFraction !== undefined ? `${pct(c.solarFraction, 1)} of solar constant` : 'Data unavailable.'}</dd><p>Annual mean downwelling shortwave radiation. This is illumination, not surface brightness.</p></div>
    </dl>
  </section>`;
}

function statusRow(label, status) {
  if (!status) return '';
  return `<div><dt>${esc(label)}</dt><dd class="${status.ok ? 'status-ok' : 'status-warn'}">${status.ok ? 'Available' : 'Unavailable'}</dd><p>${esc(status.ok ? [status.source, status.detail].filter(Boolean).join(' · ') : status.error)}</p></div>`;
}

function renderPointDataStatus(profile) {
  if (!profile.experimental || !profile.dataStatus) return '';
  const s = profile.dataStatus;
  return `<section class="panel-section">
    <div class="section-head"><h3>Point data coverage</h3><span class="fine">experimental</span></div>
    <dl class="metric-list">
      ${statusRow('Climate normals', s.climate)}
      ${statusRow('Elevation / terrain', s.terrain)}
      ${statusRow('SoilGrids regolith proxy', s.soil)}
      ${statusRow('Smithsonian volcano context', s.volcano)}
    </dl>
    <p class="fine">The score uses only comparable dimensions that returned data. Soil texture and volcano proximity are informational context and are not folded into the numeric score.</p>
  </section>`;
}

function renderTerrainScaleRows(profile) {
  const rows = [
    ['Fine · 1 km grid', profile.terrainFine],
    ['Regional · 10 km grid', profile.terrain],
    ['Broad · 50 km grid', profile.terrainBroad],
  ].filter(([, terrain]) => terrain);
  if (rows.length < 2) return '';
  return `<dl class="metric-list terrain-scales">${rows.map(([label, terrain]) => `<div><dt>${label}</dt><dd>${terrain.slopeDeg}° · ${terrain.roughnessM} m σ</dd><p>Elevation ${terrain.elevationM} m · ${terrain.windowKm} km window</p></div>`).join('')}</dl>`;
}

function renderSoilContext(profile) {
  const s = profile.soil;
  if (!s) return '';
  const value = (n, suffix = '') => Number.isFinite(n) ? `${n}${suffix}` : 'Data unavailable.';
  return `<section class="panel-section">
    <div class="section-head"><h3>Regolith &amp; soil proxy</h3><span class="fine">SoilGrids 2.0 · ${esc(s.depth)}</span></div>
    <dl class="metric-grid">
      <div><dt>Texture class</dt><dd>${s.textureClass ? esc(s.textureClass) : 'Data unavailable.'}</dd><span>USDA-style class</span></div>
      <div><dt>Sand</dt><dd>${value(s.sandPct, '%')}</dd><span>Fine-earth fraction</span></div>
      <div><dt>Clay</dt><dd>${value(s.clayPct, '%')}</dd><span>Fine-earth fraction</span></div>
      <div><dt>Silt</dt><dd>${value(s.siltPct, '%')}</dd><span>Fine-earth fraction</span></div>
      <div><dt>Coarse fragments</dt><dd>${value(s.coarsePct, '%')}</dd><span>Volume fraction</span></div>
      <div><dt>Bulk density</dt><dd>${value(s.bulkDensity, ' kg/dm³')}</dd><span>Topsoil mean</span></div>
      <div><dt>Soil pH</dt><dd>${value(s.ph)}</dd><span>0–30 cm mean</span></div>
      <div><dt>Resolution</dt><dd>${esc(s.resolution)}</dd><span>Global soil grid</span></div>
    </dl>
    <p class="fine">${esc(s.note)}</p>
  </section>`;
}

function renderVolcanoContext(profile) {
  const v = profile.volcano;
  if (!v) return '';
  return `<section class="panel-section">
    <div class="section-head"><h3>Volcanic context</h3><span class="fine">Smithsonian GVP</span></div>
    <p><strong>${esc(v.name)}</strong> · ${Math.round(v.distanceKm)} km away · ${esc(v.type || 'volcanic center')}</p>
    <p class="fine">${esc(v.country || '')}${v.region ? ` · ${esc(v.region)}` : ''} · Last eruption: ${esc(v.eruption)}</p>
    <p class="fine">${esc(v.note)}</p>
    ${v.url || v.u ? `<a class="text-link" href="${esc(v.url || v.u)}" target="_blank" rel="noopener">Open GVP volcano record ↗</a>` : ''}
  </section>`;
}

function renderEarthInspector() {
  const profile = state.selection.profile;
  const c = profile.climate;
  const t = profile.terrain;
  const key = earthMatchKey(profile);
  const matches = state.earthMatches[key] || [];
  const best = matches[0] || null;
  const pending = state.earthMatchPromises.has(key);
  const matchError = state.earthMatchErrors[key];
  const hero = best;
  const experimental = Boolean(profile.experimental || profile.id === 'custom-earth-point');
  const availableDims = hero?.dimensions?.filter((d) => d.available).length ?? 0;
  const totalDims = hero?.dimensions?.length ?? 7;
  const heroLabel = experimental ? 'Experimental analog score' : 'Overall analog grade';
  const earthSources = ['nasa_power', 'era5', 'copernicus_dem', ...(experimental ? ['open_elevation', 'aws_terrain_tiles', 'soilgrids', 'gvp'] : []), 'gibs_blue_marble'];
  return `
    <div class="inspector-head">
      <p class="eyebrow">Earth · ${esc(profile.country || 'custom coordinate')}</p>
      <h2>${esc(profile.name)}</h2>
      <p class="coord-line">${formatCoord(profile.lat, profile.lon)} <button class="mini-btn" data-action="copy" data-lat="${profile.lat}" data-lon="${profile.lon}" type="button">copy</button></p>
    </div>
    ${contextFigure()}
    ${profile.dataIssue ? `<div class="alert alert-warn"><strong>Partial data.</strong> ${esc(profile.dataIssue)}</div>` : ''}
    ${renderPointDataStatus(profile)}
    ${hero ? `<div class="grade-hero grade-${hero.grade}">
      <div class="grade-orb">${hero.grade}</div>
      <div class="grade-copy"><p class="grade-label">${heroLabel}</p>
      <p class="grade-sub">Mimics <strong>${esc(best.planetSite.name)}</strong> · ${esc(BODIES[best.planetBody]?.label || best.planetBody)}${experimental ? ' · clicked coordinate' : ''}</p>
      <div class="chip-row"><span class="pill">Score ${Math.round(hero.score)}/100</span><span class="pill">Coverage ${pct(hero.coverage)}</span><span class="pill">Confidence ${confidenceLabel(hero.confidence)}</span>${experimental ? '<span class="pill pill-experimental">Experimental</span>' : ''}</div></div>
    </div>${experimental ? `<div class="alert alert-info"><strong>Experimental score.</strong> Computed from ${availableDims}/${totalDims} comparable dimensions (${pct(hero.coverage)} coverage). Soil texture and volcano proximity are shown below but are not added to the score. Missing dimensions are never inferred.</div>` : ''}` : pending ? `<div class="alert alert-info"><strong>Rating this Earth site…</strong> Loading both planetary DEMs and comparing against every curated Moon and Mars site. The live measurements below are already available.</div>` : matchError ? `<div class="alert alert-warn"><strong>Planetary match unavailable.</strong> ${esc(matchError)}</div>` : `<div class="alert alert-info"><strong>No comparable planetary match.</strong> The available measurements do not overlap enough with a curated planetary site to issue a grade.</div>`}
    <div class="action-row"><button type="button" class="ghost-btn" data-action="share">Copy analysis link</button></div>
    ${renderSpaceComparison(matches, profile)}
    ${c ? `<dl class="metric-list">
      <div><dt>Mean air temperature</dt><dd>${c.tempMeanK} K <small>(${c.tempMeanC} °C)</small></dd>${evidenceChip('derived')}<p>${esc(c.tempType)}</p></div>
      <div><dt>Mean diurnal range</dt><dd>${c.diurnalAmpK ?? 'Data unavailable.'} K</dd><p>Daily max−min of 2 m air temperature, averaged over ${c.period}.</p></div>
      <div><dt>Annual precipitation</dt><dd>${c.precipMm ?? 'Data unavailable.'} mm</dd></div>
      <div><dt>Reference evapotranspiration</dt><dd>${c.et0Mm ?? 'Data unavailable.'} mm</dd></div>
      <div><dt>Aridity index</dt><dd>${c.aridityIndex ?? 'Data unavailable.'} <small>P/PET₀</small></dd><p>Lower values indicate more arid conditions; above 1, precipitation exceeds estimated demand. ${esc(c.et0Method || 'Reference ET₀')}.</p></div>
      <div><dt>Solar resource</dt><dd>${c.solarFraction !== null ? pct(c.solarFraction, 1) : 'Data unavailable.'} of solar constant</dd><p>Annual mean surface shortwave radiation divided by the 24-hour solar constant — the same physical quantity used for planetary sites.</p></div>
      <div><dt>Luminosity</dt><dd>${Number.isFinite(c.solarFraction) ? `${Math.round(c.solarFraction * 1361)} <small>W/m²</small>` : 'Data unavailable.'}</dd><p>Absolute mean surface shortwave irradiance from POWER, calculated as annual solar fraction × 1361 W/m². Modelled/reanalysis, not a local pyranometer.</p></div>
    </dl>` : `<div class="alert alert-warn"><strong>Climate data unavailable.</strong> Climate normals could not be retrieved for this point. Thermal and solar similarity cannot be computed.</div>`}
    ${c ? renderBrightnessFactors(c) : ''}
    ${t ? `<section class="panel-section"><div class="section-head"><h3>Terrain</h3><span class="fine">${esc(t.datasetLabel)}</span></div>
      <dl class="metric-grid">
        <div><dt>Elevation</dt><dd>${t.elevationM} <small>m</small></dd><span>DEM sample</span></div>
        <div><dt>Slope</dt><dd>${t.slopeDeg} <small>°</small></dd><span>Horn 3×3</span></div>
        <div><dt>Roughness</dt><dd>${t.roughnessM} <small>m σ</small></dd><span>${t.windowKm} km window</span></div>
        <div><dt>Sampling</dt><dd>${t.resolutionKm} <small>km</small></dd><span>9-point grid</span></div>
      </dl>
      ${renderTerrainScaleRows(profile)}
    </section>` : '<p class="na">Elevation grid unavailable for this point.</p>'}
    ${renderSoilContext(profile)}
    ${renderVolcanoContext(profile)}
    ${hero ? renderComparisonBlock(hero) : ''}
    ${renderMimicBlock(matches)}
    ${hero ? renderEarthFactorSection(hero) : ''}
    ${profile.geologyBasis ? `<section class="panel-section"><div class="section-head"><h3>Geology</h3></div><p>${esc(profile.geologyBasis)}</p><p class="fine"><strong>Analog status.</strong> ${profile.established ? 'Established planetary analog in published research.' : 'Less-studied candidate: this match is data-driven, not an established field analog.'}</p>${profile.protection ? `<p class="fine"><strong>Access.</strong> ${esc(profile.protection)}</p>` : ''}</section>` : ''}
    <section class="panel-section"><div class="section-head"><h3>Sources</h3></div>
      <ul class="source-list">${sourceLinks(earthSources)}</ul>
      ${c ? `<p class="fine">${esc(c.source)} · ${esc(c.period)}</p>` : ''}</section>`;
}

function renderTwinInspector() {
  if (!state.twin.active) return renderSiteInspector();
  const planet = selectedAssessment();
  if (!planet) return `<div class="empty-state"><p>Select a planetary site to begin.</p></div>`;
  if (state.earthPoolState === 'loading' && !state.twin.custom) {
    return `<div class="inspector-head"><p class="eyebrow">Earth Twin Mode</p><h2>Measuring Earth candidates…</h2></div>
      <div class="loading-block"><span class="spinner"></span><p>Fetching NASA POWER climate normals and Copernicus DEM terrain for ${EARTH_ANALOGS.length} sites. This happens once and is cached. You can also click anywhere on the Earth map to compare that coordinate.</p></div>`;
  }
  const analogId = state.twin.selectedAnalogId;
  if (!analogId) return `<div class="empty-state"><p>No analog has been selected yet.</p></div>`;
  const profile = state.earthPool.find((p) => p.id === analogId) || state.twin.custom;
  const compare = state.twin.compare && state.twin.compare.earthId === analogId ? state.twin.compare : profile ? comparePair({ site: planet.site, terrain: planet.terrain, body: state.body }, profile) : null;
  if (!compare || !profile || compare.score === null) return `<div class="empty-state"><p>Earth measurements for this candidate are unavailable, so no similarity grade can be issued.</p></div>`;
  const isCustom = profile.id === 'custom-earth-point';
  const discoveries = discoverNewAnalogs(state.twin.rankings, state.earthPool, 3);
  const earthSources = isCustom
    ? ['nasa_power', 'era5', 'copernicus_dem', 'open_elevation', 'aws_terrain_tiles', 'soilgrids', 'gvp', 'gibs_blue_marble']
    : ['nasa_power', 'era5', 'copernicus_dem', 'gibs_blue_marble'];

  return `
    <div class="inspector-head">
      <p class="eyebrow">Earth Twin Mode · ${esc(BODIES[state.body].label)} ↔ Earth</p>
      <h2>${esc(planet.site.name)} <span class="arrow">↔</span> ${esc(compare.earthName)}</h2>
      <p class="coord-line">${formatCoord(planet.site.lat, planet.site.lon)} → ${formatCoord(profile.lat, profile.lon)}</p>
    </div>
    <div class="pair-figures">
      <figure class="context-figure"><canvas id="ctx-thumb" width="192" height="128" aria-label="Planetary context imagery"></canvas><figcaption id="ctx-caption">Planet context</figcaption></figure>
      <figure class="context-figure"><canvas id="ctx-thumb-earth" width="192" height="128" aria-label="Earth context imagery"></canvas><figcaption id="ctx-caption-earth">Earth context</figcaption></figure>
    </div>
    <div class="grade-hero grade-${compare.grade}">
      <div class="grade-orb">${compare.grade}</div>
      <div class="grade-copy">
        <p class="grade-label">${isCustom ? 'Experimental Earth analog score' : `${gradeMeta(compare.grade).label} Earth analog`}</p>
        <p class="grade-sub">${isCustom ? 'Clicked Earth coordinate · experimental, not a curated candidate' : `${esc(profile.country || 'Earth')} · ${profile.established ? 'established analog' : 'less-studied data-driven candidate'}`}</p>
        <div class="chip-row"><span class="pill">Score ${Math.round(compare.score)}/100</span><span class="pill">Coverage ${pct(compare.coverage)}</span><span class="pill">Confidence ${confidenceLabel(compare.confidence)}</span>${isCustom ? '<span class="pill pill-experimental">Experimental</span>' : ''}</div>
      </div>
    </div>
    <p class="fine">Similarity is not equivalence. The grade measures how closely available characteristics align — not whether this site reproduces planetary conditions.</p>
    ${renderPointDataStatus(profile)}
    ${renderTopFiveComparison()}
    ${renderDiscoveryBlock(discoveries)}
    ${compare.applications.length ? `<section class="panel-section"><div class="section-head"><h3>Scientific applications</h3></div><ul class="app-list">${compare.applications.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></section>` : ''}
    ${renderComparisonBlock(compare)}
    <section class="panel-section"><div class="section-head"><h3>Planet-side evidence</h3></div>
      <p class="fine">${esc(planet.site.summary)}</p>
      <ul class="source-list">${sourceLinks(planet.site.sources)}</ul></section>
    <section class="panel-section"><div class="section-head"><h3>Earth-side sources</h3></div><ul class="source-list">${sourceLinks(earthSources)}</ul>${profile.climate ? `<p class="fine">${esc(profile.climate.source)} · ${esc(profile.climate.period)}</p>` : ''}</section>
    <div class="action-row"><button type="button" class="ghost-btn" data-action="share">Copy analysis link</button><button type="button" class="ghost-btn" data-action="exit-twin">Exit Earth Twin Mode</button></div>`;
}

function renderComparisonBlock(compare) {
  const sectionDefs = [
    { id: 'thermal', label: 'Thermal environment', ids: ['thermalMean', 'thermalAmp'] },
    { id: 'terrain', label: 'Terrain & operations', ids: ['slope', 'roughness'] },
    { id: 'surface', label: 'Surface materials & volatiles', ids: ['substrate', 'volatile'] },
    { id: 'energy', label: 'Energy environment', ids: ['luminosity'] },
  ];
  const sections = sectionDefs.map((section) => {
    const dims = section.ids.map((id) => compare.dimensions.find((d) => d.id === id)).filter(Boolean);
    const available = dims.filter((d) => d.available);
    const weight = available.reduce((sum, d) => sum + (d.effectiveWeight || 0), 0);
    const score = weight > 0 ? (available.reduce((sum, d) => sum + d.similarity * d.effectiveWeight, 0) / weight) * 100 : null;
    return { ...section, dims, score, grade: score === null ? null : letterGrade(score) };
  });
  return `
    <section class="panel-section">
      <div class="section-head"><h3>Section ratings &amp; factor bars</h3><span class="fine">grades + gaps shown</span></div>
      <div class="compare-sections">
        ${sections.map((section) => `<div class="compare-section">
          <div class="compare-section-head">
            <strong>${esc(section.label)}</strong>
            ${section.score === null ? '<span class="na">Not assessed</span>' : `<span class="compare-section-score">${Math.round(section.score)}/100 ${gradeChip(section.grade)}</span>`}
          </div>
          ${section.score === null ? '' : `<div class="compare-section-track"><span style="width:${Math.max(0, Math.min(100, section.score)).toFixed(1)}%"></span></div>`}
          <div class="system-bars">
            ${section.dims.map((d) => systemBar({
              labelHtml: esc(d.label),
              grade: d.grade,
              score: d.available ? d.similarity * 100 : null,
              number: d.available ? Math.round(d.similarity * 100) : '—',
              value: `${formatDimValue(d.id, d.planetValue)} <span class="arrow">→</span> ${formatDimValue(d.id, d.earthValue)}`,
              meta: d.available ? `${pct(d.effectiveWeight)} of match weight` : 'Dropped — no comparable data',
              detail: d.note,
              missing: !d.available,
            })).join('')}
          </div>
        </div>`).join('')}
      </div>
      <div class="match-lists">
        <div><h4>Strong matches</h4>${compare.strong.length ? `<ul>${compare.strong.map((d) => `<li><b>${esc(d.label)}</b> · ${pct(d.similarity)} · ${d.grade}</li>`).join('')}</ul>` : '<p class="na">No dimension reaches the strong-match threshold.</p>'}</div>
        <div><h4>Weak matches</h4>${compare.weak.length ? `<ul>${compare.weak.map((d) => `<li><b>${esc(d.label)}</b> · ${pct(d.similarity)} · ${d.grade}</li>`).join('')}</ul>` : '<p class="na">No dimension falls below the weak-match threshold.</p>'}</div>
      </div>
    </section>
    <section class="panel-section">
      <div class="section-head"><h3>Where the analogy breaks down</h3></div>
      <ul class="break-list">${compare.incomparable.map((d) => `<li><b>${esc(d.label)}</b> — planet: ${esc(d.planet)}; Earth: ${esc(d.earth)}.<p>${esc(d.why)}</p></li>`).join('')}</ul>
    </section>
    <section class="panel-section">
      <div class="section-head"><h3>Limitations</h3></div>
      <ul class="fine-list">${compare.caveats.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
      <details class="calc-details"><summary>Show numeric similarity</summary><div class="calc-body"><p>Internal score: <b>${compare.score ?? '—'}</b>/100 · coverage ${pct(compare.coverage)} · confidence ${round(compare.confidence, 2)}</p></div></details>
    </section>`;
}

function renderEmptyInspector() {
  return `
    <div class="inspector-head">
      <p class="eyebrow">${esc(BODIES[state.body].label)}</p>
      <h2>Select a location</h2>
      <p class="lede">Click a lettered pin for a full site assessment, or click anywhere on the ${state.body === 'moon' ? 'lunar' : 'Martian'} surface for DEM-derived terrain measurements.</p>
    </div>
    ${contextFigure('Context imagery appears after a selection.')}
    <div class="grade-scale">${['A', 'B', 'C', 'D', 'F'].map((g) => `<div>${gradeChip(g)}<span>${gradeMeta(g).label}</span></div>`).join('')}</div>
    <p class="fine">Grades come from the weighted mission model, not from this legend. A letter without data coverage is shown as ${UNRATED}, never invented.</p>
    <div class="action-row"><button type="button" class="solid-btn" data-action="twin">Open Earth Twin Mode</button></div>
    <p class="caveat">${MISSION_CAVEAT}</p>`;
}

/* -------------------------------------------------------------------- events */

function bind() {
  const railTabs = [...document.querySelectorAll('.rail-tab')];
  railTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const section = tab.dataset.rail;
      railTabs.forEach((button) => {
        const active = button === tab;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', String(active));
      });
      document.querySelectorAll('.rail-view').forEach((view) => {
        view.classList.toggle('is-active', view.dataset.railView === section);
      });
    });
  });

  document.querySelectorAll('.planet-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchBody(btn.dataset.body));
  });

  $('#mission-select').addEventListener('change', (e) => {
    state.missionId = e.target.value;
    state.priorities = {};
    state.assessed = null;
    state.lastRecalc = null;
    renderAll();
    syncUrlState();
  });

  analysisToggle?.addEventListener('click', () => {
    const open = !inspectorRail?.classList.contains('is-open');
    setInspectorOpen(open);
  });
  $('#inspector-close')?.addEventListener('click', closeInspector);
  railScrim?.addEventListener('click', closeInspector);

  const search = $('#candidate-search');
  search?.addEventListener('input', (e) => {
    state.search = e.target.value;
    renderCandidates();
  });
  search?.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    state.search = '';
    search.value = '';
    renderCandidates();
  });

  $('#twin-toggle').addEventListener('click', () => {
    if (state.twin.active) deactivateTwin();
    else activateTwin();
  });

  $('#btn-methodology').addEventListener('click', () => openModal('methodology', 'Methodology'));
  $('#btn-sources').addEventListener('click', () => openModal('sources', 'Data sources'));
  $('#btn-scope').addEventListener('click', () => openModal('scope', 'Scope'));

  $('#reset-priorities').addEventListener('click', () => {
    state.priorities = {};
    state.assessed = null;
    state.lastRecalc = 'Priorities reset to the mission-profile defaults.';
    renderAll();
  });

  $('#layers-body').addEventListener('change', (e) => {
    const t = e.target;
    if (t.name === 'planet-layer') {
      state.layer = t.value;
      applyPlanetLayer();
      renderLegend();
      renderStageChrome();
      updateGlobeSites();
    } else if (t.name === 'basemap') {
      state.basemap = t.value;
      state.earthMap?.setBasemap(state.basemap);
      renderLegend();
    } else if (t.name === 'earth-overlay') {
      state.earthOverlay = t.value;
      state.earthMap?.setOverlay(state.earthOverlay);
      renderLegend();
      renderStageChrome();
    } else if (t.id === 'labels-toggle') {
      state.labels = t.checked;
      state.earthMap?.setLabelsVisible(state.labels);
    } else if (t.id === 'base-toggle') {
      state.baseVisible = t.checked;
      applyPlanetLayer();
    }
  });

  $('#layers-body').addEventListener('input', (e) => {
    if (e.target.id !== 'labels-toggle') return;
  });

  $('#priorities-body').addEventListener('input', (e) => {
    const id = e.target.dataset.priority;
    if (!id) return;
    const prevTop = sortedAssessments().slice(0, 3);
    const profile = profileForBody(state.body, state.missionId);
    const prevShares = weightShares(profile, state.priorities);
    state.priorities[id] = Number(e.target.value);
    state.assessed = null;
    const nextTop = sortedAssessments();
    const nextShares = weightShares(profile, state.priorities);
    state.lastRecalc = explainRecalc(profile, id, e.target.value, prevTop, nextTop, prevShares, nextShares);
    clearTimeout(state.sliderTimer);
    state.sliderTimer = setTimeout(() => {
      renderCandidates();
      renderInspector();
      updateGlobeSites();
    }, 90);
    // Update every share label in place; re-rendering the slider inputs would
    // interrupt an active drag.
    nextShares.forEach((s) => {
      const row = document.querySelector(`[data-priority="${s.id}"]`)?.closest('.slider-row');
      if (row) row.querySelector('.slider-meta').innerHTML = `<b>${pct(s.share)}</b> ×${Number(state.priorities[s.id] ?? 1).toFixed(1)}`;
    });
  });

  candidatesBody.addEventListener('click', (e) => {
    const clear = e.target.closest('[data-clear-search]');
    if (clear) {
      state.search = '';
      const search = $('#candidate-search');
      if (search) search.value = '';
      renderCandidates();
      search?.focus();
      return;
    }
    const retry = e.target.closest('[data-retry-pool]');
    if (retry) {
      state.earthPoolState = 'idle';
      state.earthPoolPromise = null;
      ensureEarthPool();
      return;
    }
    const siteBtn = e.target.closest('[data-site]');
    if (siteBtn) {
      selectSite(siteBtn.dataset.site);
      return;
    }
    const analogBtn = e.target.closest('[data-analog]');
    if (analogBtn) {
      selectEarthAnalog(analogBtn.dataset.analog);
    }
  });

  inspector.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'copy') {
      const text = formatCoord(Number(btn.dataset.lat), Number(btn.dataset.lon));
      navigator.clipboard?.writeText(text).then(() => toast(`Copied ${text}`, 'ok', 2500)).catch(() => {});
    } else if (action === 'share') {
      shareAnalysis();
    } else if (action === 'fly') {
      const row = selectedAssessment();
      if (row) state.globe?.flyTo(row.site.lat, row.site.lon);
      if (state.body === 'earth' && state.selection?.kind === 'earth') {
        state.earthMap?.flyTo(state.selection.profile.lat, state.selection.profile.lon, 5);
      }
    } else if (action === 'twin') {
      if (state.twin.active) {
        computeTwinRankings();
        const top = state.twin.rankings[0];
        if (top) {
          state.twin.selectedAnalogId = top.earthId;
          state.selection = { kind: 'twin', analogId: top.earthId };
        }
        renderAll();
      } else {
        activateTwin();
      }
    } else if (action === 'exit-twin') {
      deactivateTwin();
    } else if (action === 'open-analog') {
      selectEarthAnalog(btn.dataset.analog);
    } else if (action === 'nearest') {
      selectSite(btn.dataset.site);
      state.globe?.flyTo(BODY_SITES[state.body].find((s) => s.id === btn.dataset.site).lat, BODY_SITES[state.body].find((s) => s.id === btn.dataset.site).lon);
    } else if (action === 'go-moon') {
      switchBody('moon');
    } else if (action === 'go-mars') {
      switchBody('mars');
    }
  });

  window.addEventListener('resize', () => {
    resizeMaps();
    if (window.innerWidth > 1180) setInspectorOpen(false);
  });
  window.addEventListener('error', (e) => {
    if (e.message) console.error('[RADIUM]', e.message);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeInspector();
      return;
    }
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
    if (e.key === '/' && !typing && !document.body.classList.contains('modal-open')) {
      e.preventDefault();
      $('#candidate-search')?.focus();
    }
  });
}

function explainRecalc(profile, id, value, prevTop, nextTop, prevShares, nextShares) {
  const label = FACTORS[id].label;
  const mult = Number(value);
  const share = nextShares.find((s) => s.id === id);
  const prevShare = prevShares.find((s) => s.id === id);
  const oldTop = prevTop[0];
  const newTop = nextTop[0];
  const shareText = `${pct(prevShare?.share || 0)} → ${pct(share?.share || 0)}`;
  if (newTop && oldTop && newTop.site.id !== oldTop.site.id) {
    return `${label} priority ×${mult.toFixed(1)} (${shareText} of mission weight). ${newTop.site.name} is now #1; ${oldTop.site.name} moves to #${nextTop.findIndex((r) => r.site.id === oldTop.site.id) + 1}.`;
  }
  if (!newTop) return `${label} priority ×${mult.toFixed(1)} (${shareText}). No site has sufficient coverage for a grade.`;
  return `${label} priority ×${mult.toFixed(1)} (${shareText} of mission weight). ${newTop.site.name} remains #1 with a weighted score of ${Math.round(newTop.result?.score ?? 0)}.`;
}

async function switchBody(body) {
  if (body === state.body && state.globe) {
    if (body === 'earth') await ensureEarthMap();
    return;
  }
  const prevBody = state.body;
  state.body = body;
  state.layer = 'sites';
  state.selection = null;
  state.search = '';
  setInspectorOpen(false);
  state.twin.active = false;
  state.twin.rankings = [];
  state.twin.allRankings = [];
  state.twin.compare = null;
  state.twin.selectedAnalogId = null;
  state.twin.custom = null;
  $('#twin-toggle').setAttribute('aria-pressed', 'false');
  $('#twin-toggle').classList.remove('is-active');
  app.dataset.view = body;
  document.querySelectorAll('.planet-tab').forEach((b) => {
    const on = b.dataset.body === body;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-selected', String(on));
  });
  if (body === 'earth') {
    state.missionId = null;
    state.assessed = null;
    state.globe?.destroy();
    state.globe = null;
    state.globeBody = null;
    setCoordReadout(0, 0, '');
    $('#coord-readout').textContent = '—';
    setDemStatus('Earth · Copernicus');
    renderMissionSelect();
    await ensureEarthMap();
    resizeMaps();
    renderAll();
    syncUrlState();
    ensureEarthPool().then(() => {
      if (state.body === 'earth' && !state.twin.active) rateEarthPool();
    });
    return;
  }
  state.missionId = missionFor(body);
  state.priorities = {};
  state.assessed = null;
  state.lastRecalc = null;
  renderMissionSelect();
  setDemStatus(`${BODIES[body].label} loading…`);
  try {
    if (!state.dems[body]) state.dems[body] = await loadDem(body);
    setDemStatus(`${BODIES[body].label} · 0.25°/px`);
  } catch (err) {
    setDemStatus(`${BODIES[body].label} unavailable`, false);
    toast(`Could not load ${body} DEM: ${err.message}`, 'error', 8000);
  }
  await ensureGlobe();
  renderAll();
  const defaultSite = body === 'moon' ? 'connecting-ridge' : 'jezero';
  selectSite(defaultSite);
  state.globe?.flyTo(BODY_SITES[body].find((s) => s.id === defaultSite).lat, BODY_SITES[body].find((s) => s.id === defaultSite).lon);
  syncUrlState();
}

async function boot() {
  bind();
  startClock();
  const initial = readUrlState();

  if (initial.body && initial.body !== 'moon') {
    await switchBody(initial.body);
    if (initial.mission && MISSION_PROFILES[initial.mission]?.body === state.body) {
      state.missionId = initial.mission;
      state.priorities = {};
      state.assessed = null;
      state.lastRecalc = null;
      renderMissionSelect();
      renderAll();
    }
    if (state.body === 'earth') {
      if (initial.earth && EARTH_ANALOGS.some((a) => a.id === initial.earth)) {
        await selectEarthAnalog(initial.earth);
      } else if (initial.lat !== null && initial.lon !== null) {
        await onEarthPick({ lat: initial.lat, lon: initial.lon });
      }
    } else if (initial.site && (BODY_SITES[state.body] || []).some((s) => s.id === initial.site)) {
      selectSite(initial.site);
    } else if (initial.lat !== null && initial.lon !== null) {
      onPlanetPick({ lat: initial.lat, lon: initial.lon });
    }
    if (initial.twin && state.body !== 'earth') {
      await activateTwin();
      if (initial.earth && EARTH_ANALOGS.some((a) => a.id === initial.earth)) await selectEarthAnalog(initial.earth);
      else if (initial.lat !== null && initial.lon !== null) await onEarthPick({ lat: initial.lat, lon: initial.lon });
    }
    updateEarthStatus();
    syncUrlState();
    return;
  }

  if (initial.mission && MISSION_PROFILES[initial.mission]?.body === 'moon') state.missionId = initial.mission;
  renderMissionSelect();
  setDemStatus('Lunar loading…');
  try {
    state.dems.moon = await loadDem('moon');
    setDemStatus('Lunar · 0.25°/px');
  } catch (err) {
    setDemStatus('Lunar unavailable', false);
    toast(`Lunar DEM unavailable: ${err.message}`, 'error', 9000);
  }
  app.dataset.view = 'moon';
  renderAll();
  await ensureGlobe();
  const moonSite = initial.site && MOON_SITES.some((s) => s.id === initial.site) ? initial.site : 'connecting-ridge';
  selectSite(moonSite);
  if (initial.lat !== null && initial.lon !== null && !initial.site) onPlanetPick({ lat: initial.lat, lon: initial.lon });
  if (initial.twin) {
    await activateTwin();
    if (initial.earth && EARTH_ANALOGS.some((a) => a.id === initial.earth)) await selectEarthAnalog(initial.earth);
    else if (initial.lat !== null && initial.lon !== null) await onEarthPick({ lat: initial.lat, lon: initial.lon });
  }
  updateEarthStatus();
  syncUrlState();
  // Keep Earth data lazy: it is only fetched when Earth Mode or Twin Mode is opened.
}

boot();
