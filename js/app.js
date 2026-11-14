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
import { comparePair, rankAnalogs, rankPlanetMatches, earthFactorGrades, SIMILARITY_DIMENSIONS } from './science/similarity.js';
import { effectiveSolar, marsPressureKPa } from './science/solar.js';
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
  twin: { active: false, planetSiteId: null, rankings: [], measuredCount: 0, selectedAnalogId: null, compare: null, custom: null },
  lastRecalc: null,
  loading: null,
};

const $ = (sel) => document.querySelector(sel);
const app = $('#app');
const inspector = $('#inspector');
const candidatesBody = $('#candidates-body');
const toastRegion = $('#toast-region');

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

function setDemStatus(text, ok = true) {
  const el = $('#dem-status');
  el.textContent = text;
  el.classList.toggle('pill-warn', !ok);
}

function updateEarthStatus() {
  const el = $('#earth-status');
  if (state.earthPoolState === 'loading' && state.earthPoolProgress) {
    el.textContent = `Earth climate ${state.earthPoolProgress.done}/${state.earthPoolProgress.total}`;
  } else if (state.earthPoolState === 'ready') {
    el.textContent = `Earth pool · ${state.earthPool.length} sites`;
  } else if (state.earthPoolState === 'error') {
    el.textContent = 'Earth climate unavailable';
  } else {
    el.textContent = 'Earth data idle';
  }
  el.classList.toggle('pill-warn', state.earthPoolState === 'error');
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
  if (id === 'solar') return `${pct(value, 1)} of solar constant`;
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
  if (state.twin.active) {
    const items = state.twin.rankings
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
          selected: state.twin.selectedAnalogId === analog.id,
          established: analog.established,
        };
      })
      .filter(Boolean);
    state.earthMap.setMarkers(items, (id) => selectEarthAnalog(id));
  } else {
    state.earthMap.setMarkers(
      EARTH_ANALOGS.map((a) => ({
        id: a.id,
        name: a.name,
        country: a.country,
        lat: a.lat,
        lon: a.lon,
        grade: state.earthMatches[a.id]?.[0]?.grade ?? UNRATED,
        selected: state.selection?.kind === 'earth' && state.selection.profile?.id === a.id,
      })),
      (id) => selectEarthAnalog(id),
    );
  }
}

async function selectEarthAnalog(id) {
  const analog = EARTH_ANALOGS.find((a) => a.id === id);
  if (!analog) return;
  const cached = state.earthPool.find((p) => p.id === id);
  if (cached) {
    state.selection = { kind: 'earth', profile: cached, custom: false };
    if (state.twin.active && selectedAssessment()) {
      setTwinComparison(cached);
      state.selection = { kind: 'twin', analogId: id };
    } else {
      queueEarthMatch(cached);
    }
    renderInspector();
    updateEarthMarkers();
    state.earthMap?.flyTo(analog.lat, analog.lon, 4.5);
    return;
  }
  state.selection = { kind: 'earth-loading', lat: analog.lat, lon: analog.lon, name: analog.name };
  renderInspector();
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
  renderInspector();
  updateEarthMarkers();
}

async function onEarthPick({ lat, lon }) {
  if (state.body === 'earth') setCoordReadout(lat, lon, 'Earth');
  state.selection = { kind: 'earth-loading', lat, lon, name: 'Custom Earth point' };
  renderInspector();
  try {
    const profile = await buildEarthProfile({
      id: 'custom-earth-point',
      name: 'Custom Earth point',
      country: '',
      lat: Number(lat.toFixed(3)),
      lon: Number(lon.toFixed(3)),
      substrateGroup: null,
      volatileGroup: null,
      established: false,
      landform: 'User-selected coordinate',
    });
    state.selection = { kind: 'earth', profile, custom: true };
    if (state.twin.active && selectedAssessment()) {
      const planet = selectedAssessment();
      state.twin.compare = comparePair({ site: planet.site, terrain: planet.terrain, body: state.body }, profile);
      state.twin.custom = profile;
    } else {
      queueEarthMatch(profile);
    }
  } catch (err) {
    state.selection = { kind: 'earth-error', name: 'Custom Earth point', message: err.message };
  }
  renderInspector();
  updateEarthMarkers();
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
}

function setCoordReadout(lat, lon, label) {
  $('#coord-readout').textContent = `${formatCoord(lat, lon)}${label ? ` · ${label}` : ''}`;
}

/* ---------------------------------------------------------------- twin mode */

function setTwinComparison(profile) {
  const planet = selectedAssessment();
  if (!planet) return;
  state.twin.compare = rankAnalogs({ site: planet.site, terrain: planet.terrain, body: state.body }, [profile])[0] || null;
  state.twin.custom = null;
}

function computeTwinRankings() {
  const planet = selectedAssessment();
  if (!planet || state.earthPoolState !== 'ready') {
    state.twin.rankings = [];
    return;
  }
  const ranked = rankAnalogs(
    { site: planet.site, terrain: planet.terrain, body: state.body },
    state.earthPool.filter((p) => p.climate || p.terrain),
  );
  state.twin.measuredCount = ranked.length;
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
}

function deactivateTwin() {
  state.twin.active = false;
  state.twin.rankings = [];
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
        const top = state.twin.rankings[0];
        if (top) {
          state.twin.selectedAnalogId = top.earthId;
          state.selection = { kind: 'twin', analogId: top.earthId };
        }
        updateEarthMarkers();
        renderAll();
        const sel = EARTH_ANALOGS.find((a) => a.id === state.twin.selectedAnalogId);
        if (sel) state.earthMap?.flyTo(sel.lat, sel.lon, 2.4);
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

function renderCandidates() {
  const title = $('#candidates-title');
  const kicker = $('#candidates-kicker');
  const bodyEl = candidatesBody;

  if (state.twin.active) {
    title.textContent = 'Top 5 Earth analogs';
    kicker.textContent = state.earthPoolState === 'ready' ? `of ${state.twin.measuredCount} measured` : 'live measurements';
    if (state.earthPoolState === 'loading') {
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
      bodyEl.innerHTML = `<div class="empty-state"><strong>Earth measurements unavailable.</strong><p>The climate/elevation services could not be reached. Similarity cannot be computed without Earth data, and RADIUM will not substitute placeholder values.</p><button class="solid-btn" data-retry-pool type="button">Retry</button></div>`;
      return;
    }
    if (!state.twin.rankings.length) {
      bodyEl.innerHTML = `<div class="empty-state"><p>Select a planetary site to rank analogs.</p></div>`;
      return;
    }
    bodyEl.innerHTML = state.twin.rankings
      .map((r, i) => {
        const analog = EARTH_ANALOGS.find((a) => a.id === r.earthId);
        const top = r.strong[0];
        return `<button type="button" class="candidate-row ${r.earthId === state.twin.selectedAnalogId ? 'is-selected' : ''}" data-analog="${r.earthId}">
          <span class="rank">${String(i + 1).padStart(2, '0')}</span>
          <span class="cand-main"><strong>${esc(r.earthName)}</strong><em>${esc(analog?.country || '')}${analog && !analog.established ? ' · less-studied candidate' : ''}</em></span>
          <span class="cand-strength">${top ? `${esc(top.label)} ${pct(top.similarity)}` : 'Limited overlap'}</span>
          ${gradeChip(r.grade)}
        </button>`;
      })
      .join('');
    return;
  }

  if (state.body === 'earth') {
    title.textContent = 'Earth analog grades';
    kicker.textContent =
      state.earthPoolRatingState === 'loading'
        ? 'rating Earth sites…'
        : state.earthPoolState === 'loading'
          ? 'live climate loading…'
          : 'overall + 8 factors';
    bodyEl.innerHTML = EARTH_ANALOGS.map(
      (a, i) => {
        const best = state.earthMatches[a.id]?.[0];
        const strength = best
          ? `Mimics ${best.planetSite.name}`
          : state.earthPoolState === 'loading' || state.earthPoolRatingState === 'loading'
            ? 'Measuring…'
            : state.earthMatchErrors[a.id]
              ? 'Match unavailable'
              : 'Open to rate';
        return `<button type="button" class="candidate-row ${state.selection?.kind === 'earth' && state.selection.profile?.id === a.id ? 'is-selected' : ''}" data-analog="${a.id}">
          <span class="rank">${String(i + 1).padStart(2, '0')}</span>
          <span class="cand-main"><strong>${esc(a.name)}</strong><em>${esc(a.country)} · ${humanize(a.substrateGroup)}</em></span>
          <span class="cand-strength">${esc(strength)}</span>
          ${gradeChip(best?.grade ?? UNRATED)}
        </button>`;
      },
    ).join('');
    return;
  }

  title.textContent = 'Mission suitability';
  kicker.textContent = `${MISSION_PROFILES[state.missionId]?.short || ''} · ${getAssessed().length} sites`;
  bodyEl.innerHTML = sortedAssessments()
    .map((r, i) => {
      const strength = r.result?.strengths?.[0];
      return `<button type="button" class="candidate-row ${r.site.id === state.selection?.siteId ? 'is-selected' : ''}" data-site="${r.site.id}">
        <span class="rank">${String(i + 1).padStart(2, '0')}</span>
        <span class="cand-main"><strong>${esc(r.site.name)}</strong><em>${esc(r.site.region)}</em></span>
        <span class="cand-strength">${strength ? `${esc(strength.label)} ${Math.round(strength.score)}` : 'Coverage limited'}</span>
        ${gradeChip(r.grade)}
      </button>`;
    })
    .join('');
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
    sub.textContent = 'Earth Twin Mode · top five terrestrial analogs for the selected planetary site';
  } else if (state.body === 'earth') {
    title.textContent = 'Earth';
    sub.textContent = 'NASA GIBS layers · overall analog grade and eight-factor profile from live climate and DEM data';
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
    <div class="legend-head"><span>${earthActive ? 'Earth analog pins' : 'Site suitability'}</span><em>letters</em></div>
    <div class="legend-grades">${['A', 'B', 'C', 'D', 'F'].map((g) => `${gradeChip(g)}<span>${gradeMeta(g).label}</span>`).join('')}</div>
    <p class="legend-note">${earthActive ? 'Pin letters are Earth analog grades. Twin Mode shows the top five matches; Earth view shows each site’s best planetary match.' : 'Letter grades from the weighted mission assessment. Hover a pin for its name; click for evidence.'}</p>`;
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
      <div class="inspector-head"><p class="eyebrow">Earth measurements</p><h2>${esc(state.selection.name || 'Custom point')}</h2>
      <p class="coord-line">${formatCoord(state.selection.lat, state.selection.lon)}</p></div>
      <div class="loading-block"><span class="spinner"></span><p>Fetching NASA POWER climate normals and Copernicus DEM samples…</p></div>`);
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
    <div class="action-row">
      <button type="button" class="solid-btn" data-action="twin">${state.twin.active ? 'Recompute Earth analogs' : 'Find Earth analogs'}</button>
      <button type="button" class="ghost-btn" data-action="fly">Center map</button>
    </div>
    <p class="summary">${esc(site.summary)}</p>

    <section class="panel-section">
      <div class="section-head"><h3>Mission factors</h3><span class="fine">letters, not just numbers</span></div>
      <div class="table-scroll"><table class="factor-table">
        <thead><tr><th>Factor</th><th>Grade</th><th>Value</th><th>Weight</th></tr></thead>
        <tbody>
          ${factors
            .map(
              (f) => `<tr class="${f.available ? '' : 'row-missing'}">
                <td><span class="factor-name">${esc(f.label)}</span>${evidenceChip(f.evidence)}</td>
                <td>${f.available ? gradeChip(letterGrade(f.score)) : `<span class="na">${UNRATED}</span>`}</td>
                <td class="num">${f.available ? `${esc(typeof f.raw === 'number' ? round(f.raw, f.unit === '°' ? 1 : 2) : humanize(f.raw))} <small>${esc(f.unit || '')}</small>` : `<span class="na" title="${esc(f.detail)}">Data unavailable.</span>`}</td>
                <td class="num">${f.available ? pct(f.effectiveWeight) : '—'}</td>
              </tr>`,
            )
            .join('')}
        </tbody>
      </table></div>
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
    <p class="caveat">Arbitrary-coordinate measurements are limited to the 0.25°/px DEM. Landing-hazard analysis needs metre-scale data that RADIUM does not bundle.</p>`;
}

function renderEarthIntro() {
  return `
    <div class="inspector-head">
      <p class="eyebrow">Earth · terrestrial analogs</p>
      <h2>What does each Earth site resemble?</h2>
      <p class="lede">RADIUM rates all ${EARTH_ANALOGS.length} curated Earth candidates against every Moon and Mars site. Each gets an overall analog grade, the closest planetary match, and an eight-factor profile.</p>
    </div>
    <div class="steps">
      <div><span>1</span><p>Earth sites are measured with live NASA POWER climate and Copernicus DEM terrain.</p></div>
      <div><span>2</span><p>The closest curated Moon or Mars site sets the overall match grade.</p></div>
      <div><span>3</span><p>Open any candidate for its eight-factor profile and the gaps RADIUM does not rate.</p></div>
    </div>
    <p class="fine">Earth grades are analog-similarity grades, not mission-suitability grades. Select a Moon or Mars site and use Earth Twin Mode to see that site's top five terrestrial analogs.</p>
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
              ${f.available ? `<span class="dim-weight">${pct(f.coverage)} of match weight</span>` : ''}
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

function renderEarthInspector() {
  const profile = state.selection.profile;
  const c = profile.climate;
  const t = profile.terrain;
  const key = earthMatchKey(profile);
  const matches = state.earthMatches[key] || [];
  const best = matches[0] || null;
  const pending = state.earthMatchPromises.has(key);
  const matchError = state.earthMatchErrors[key];
  return `
    <div class="inspector-head">
      <p class="eyebrow">Earth · ${esc(profile.country || 'custom coordinate')}</p>
      <h2>${esc(profile.name)}</h2>
      <p class="coord-line">${formatCoord(profile.lat, profile.lon)} <button class="mini-btn" data-action="copy" data-lat="${profile.lat}" data-lon="${profile.lon}" type="button">copy</button></p>
    </div>
    ${contextFigure()}
    ${profile.dataIssue ? `<div class="alert alert-warn"><strong>Partial data.</strong> ${esc(profile.dataIssue)}</div>` : ''}
    ${best ? `<div class="grade-hero grade-${best.grade}">
      <div class="grade-orb">${best.grade}</div>
      <div class="grade-copy"><p class="grade-label">Overall analog grade</p>
      <p class="grade-sub">Mimics <strong>${esc(best.planetSite.name)}</strong> · ${esc(BODIES[best.planetBody]?.label || best.planetBody)}</p>
      <div class="chip-row"><span class="pill">Coverage ${pct(best.coverage)}</span><span class="pill">Confidence ${confidenceLabel(best.confidence)}</span></div></div>
    </div>` : pending ? `<div class="alert alert-info"><strong>Rating this Earth site…</strong> Loading both planetary DEMs and comparing against every curated Moon and Mars site. The live measurements below are already available.</div>` : matchError ? `<div class="alert alert-warn"><strong>Planetary match unavailable.</strong> ${esc(matchError)}</div>` : `<div class="alert alert-info"><strong>No comparable planetary match.</strong> The available measurements do not overlap enough with a curated planetary site to issue a grade.</div>`}
    ${c ? `<dl class="metric-list">
      <div><dt>Mean air temperature</dt><dd>${c.tempMeanK} K <small>(${c.tempMeanC} °C)</small></dd>${evidenceChip('derived')}<p>${esc(c.tempType)}</p></div>
      <div><dt>Mean diurnal range</dt><dd>${c.diurnalAmpK ?? 'Data unavailable.'} K</dd><p>Daily max−min of 2 m air temperature, averaged over ${c.period}.</p></div>
      <div><dt>Annual precipitation</dt><dd>${c.precipMm ?? 'Data unavailable.'} mm</dd></div>
      <div><dt>Reference evapotranspiration</dt><dd>${c.et0Mm ?? 'Data unavailable.'} mm</dd></div>
      <div><dt>Aridity index</dt><dd>${c.aridityIndex ?? 'Data unavailable.'} <small>P/PET₀</small></dd><p>Lower values indicate more arid conditions; above 1, precipitation exceeds estimated demand. ${esc(c.et0Method || 'Reference ET₀')}.</p></div>
      <div><dt>Solar resource</dt><dd>${c.solarFraction !== null ? pct(c.solarFraction, 1) : 'Data unavailable.'} of solar constant</dd><p>Annual mean surface shortwave radiation divided by the 24-hour solar constant — the same physical quantity used for planetary sites.</p></div>
    </dl>` : `<div class="alert alert-warn"><strong>Climate data unavailable.</strong> Climate normals could not be retrieved for this point. Thermal and solar similarity cannot be computed.</div>`}
    ${c ? renderBrightnessFactors(c) : ''}
    ${t ? `<section class="panel-section"><div class="section-head"><h3>Terrain</h3><span class="fine">${esc(t.datasetLabel)}</span></div>
      <dl class="metric-grid">
        <div><dt>Elevation</dt><dd>${t.elevationM} <small>m</small></dd><span>DEM sample</span></div>
        <div><dt>Slope</dt><dd>${t.slopeDeg} <small>°</small></dd><span>Horn 3×3</span></div>
        <div><dt>Roughness</dt><dd>${t.roughnessM} <small>m σ</small></dd><span>${t.windowKm} km window</span></div>
        <div><dt>Sampling</dt><dd>${t.resolutionKm} <small>km</small></dd><span>9-point grid</span></div>
      </dl></section>` : '<p class="na">Elevation grid unavailable for this point.</p>'}
    ${renderMimicBlock(matches)}
    ${best ? renderEarthFactorSection(best) : ''}
    ${profile.geologyBasis ? `<section class="panel-section"><div class="section-head"><h3>Geology</h3></div><p>${esc(profile.geologyBasis)}</p><p class="fine"><strong>Analog status.</strong> ${profile.established ? 'Established planetary analog in published research.' : 'Less-studied candidate: this match is data-driven, not an established field analog.'}</p>${profile.protection ? `<p class="fine"><strong>Access.</strong> ${esc(profile.protection)}</p>` : ''}</section>` : ''}
    <section class="panel-section"><div class="section-head"><h3>Sources</h3></div>
      <ul class="source-list">${sourceLinks(['nasa_power', 'era5', 'copernicus_dem', 'gibs_blue_marble'])}</ul>
      ${c ? `<p class="fine">${esc(c.source)} · ${esc(c.period)}</p>` : ''}</section>`;
}

function renderTwinInspector() {
  if (!state.twin.active) return renderSiteInspector();
  const planet = selectedAssessment();
  if (!planet) return `<div class="empty-state"><p>Select a planetary site to begin.</p></div>`;
  if (state.earthPoolState === 'loading') {
    return `<div class="inspector-head"><p class="eyebrow">Earth Twin Mode</p><h2>Measuring Earth candidates…</h2></div>
      <div class="loading-block"><span class="spinner"></span><p>Fetching NASA POWER climate normals and Copernicus DEM terrain for ${EARTH_ANALOGS.length} sites. This happens once and is cached.</p></div>`;
  }
  const analogId = state.twin.selectedAnalogId;
  if (!analogId) return `<div class="empty-state"><p>No analog has been selected yet.</p></div>`;
  const profile = state.earthPool.find((p) => p.id === analogId) || state.twin.custom;
  const compare = state.twin.compare && state.twin.compare.earthId === analogId ? state.twin.compare : profile ? comparePair({ site: planet.site, terrain: planet.terrain, body: state.body }, profile) : null;
  if (!compare || !profile) return `<div class="empty-state"><p>Earth measurements for this candidate are unavailable, so no similarity grade can be issued.</p></div>`;

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
        <p class="grade-label">${gradeMeta(compare.grade).label} Earth analog</p>
        <p class="grade-sub">${esc(profile.country || 'Earth')} · ${profile.established ? 'established analog' : 'less-studied data-driven candidate'}</p>
        <div class="chip-row"><span class="pill">Coverage ${pct(compare.coverage)}</span><span class="pill">Confidence ${confidenceLabel(compare.confidence)}</span></div>
      </div>
    </div>
    <p class="fine">Similarity is not equivalence. The grade measures how closely available characteristics align — not whether this site reproduces planetary conditions.</p>
    ${compare.applications.length ? `<section class="panel-section"><div class="section-head"><h3>Scientific applications</h3></div><ul class="app-list">${compare.applications.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></section>` : ''}
    ${renderComparisonBlock(compare)}
    <section class="panel-section"><div class="section-head"><h3>Planet-side evidence</h3></div>
      <p class="fine">${esc(planet.site.summary)}</p>
      <ul class="source-list">${sourceLinks(planet.site.sources)}</ul></section>
    <section class="panel-section"><div class="section-head"><h3>Earth-side sources</h3></div><ul class="source-list">${sourceLinks(['nasa_power', 'era5', 'copernicus_dem', 'gibs_blue_marble'])}</ul>${profile.climate ? `<p class="fine">${esc(profile.climate.source)} · ${esc(profile.climate.period)}</p>` : ''}</section>
    <div class="action-row"><button type="button" class="ghost-btn" data-action="exit-twin">Exit Earth Twin Mode</button></div>`;
}

function renderComparisonBlock(compare) {
  return `
    <section class="panel-section">
      <div class="section-head"><h3>Dimension comparison</h3><span class="fine">letter-graded</span></div>
      <div class="table-scroll"><table class="compare-table">
        <thead><tr><th>Dimension</th><th>${esc(BODIES[state.body]?.label || 'Planet')}</th><th>Earth</th><th>Match</th></tr></thead>
        <tbody>
          ${compare.dimensions
            .map(
              (d) => `<tr class="${d.available ? '' : 'row-missing'}">
                <td>${esc(d.label)}<span class="dim-weight">${d.available ? pct(d.effectiveWeight) : 'dropped'}</span></td>
                <td>${formatDimValue(d.id, d.planetValue)}</td>
                <td>${formatDimValue(d.id, d.earthValue)}</td>
                <td>${d.available ? gradeChip(d.grade) : `<span class="na">${UNRATED}</span>`}</td>
              </tr>`,
            )
            .join('')}
        </tbody>
      </table></div>
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
    } else if (action === 'nearest') {
      selectSite(btn.dataset.site);
      state.globe?.flyTo(BODY_SITES[state.body].find((s) => s.id === btn.dataset.site).lat, BODY_SITES[state.body].find((s) => s.id === btn.dataset.site).lon);
    } else if (action === 'go-moon') {
      switchBody('moon');
    } else if (action === 'go-mars') {
      switchBody('mars');
    }
  });

  window.addEventListener('resize', resizeMaps);
  window.addEventListener('error', (e) => {
    if (e.message) console.error('[RADIUM]', e.message);
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
  state.twin.active = false;
  state.twin.rankings = [];
  state.twin.compare = null;
  state.twin.selectedAnalogId = null;
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
    setDemStatus('Earth terrain · Copernicus');
    renderMissionSelect();
    await ensureEarthMap();
    resizeMaps();
    renderAll();
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
  setDemStatus(`${BODIES[body].label} DEM loading…`);
  try {
    if (!state.dems[body]) state.dems[body] = await loadDem(body);
    setDemStatus(`${BODIES[body].label} DEM · 0.25°/px`);
  } catch (err) {
    setDemStatus(`${BODIES[body].label} DEM unavailable`, false);
    toast(`Could not load ${body} DEM: ${err.message}`, 'error', 8000);
  }
  await ensureGlobe();
  renderAll();
  const defaultSite = body === 'moon' ? 'connecting-ridge' : 'jezero';
  selectSite(defaultSite);
  state.globe?.flyTo(BODY_SITES[body].find((s) => s.id === defaultSite).lat, BODY_SITES[body].find((s) => s.id === defaultSite).lon);
}

async function boot() {
  bind();
  renderMissionSelect();
  setDemStatus('Lunar DEM loading…');
  try {
    state.dems.moon = await loadDem('moon');
    setDemStatus('Lunar DEM · 0.25°/px');
  } catch (err) {
    setDemStatus('Lunar DEM unavailable', false);
    toast(`Lunar DEM unavailable: ${err.message}`, 'error', 9000);
  }
  app.dataset.view = 'moon';
  renderAll();
  await ensureGlobe();
  selectSite('connecting-ridge');
  updateEarthStatus();
  // Keep Earth data lazy: it is only fetched when Earth Twin Mode is opened.
}

boot();
