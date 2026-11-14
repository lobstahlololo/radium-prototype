/**
 * Static long-form content: methodology, dataset registry and scope notes.
 * Values here are generated from the same constants the engines use, so the
 * documentation cannot silently drift from the implementation.
 */

import { DATASETS, DATASET_ORDER } from '../data/datasets.js';
import { GRADE_BANDS } from '../science/grade.js';
import { MISSION_PROFILES, FACTORS } from '../science/suitability.js';
import { SIMILARITY_DIMENSIONS, SUBSTRATE_AFFINITY, VOLATILE_AFFINITY } from '../science/similarity.js';
import { MISSION_CAVEAT } from '../data/constants.js';
import { CLIMATE_SOURCE_LABEL } from '../data/earth-climate.js';

const pct = (n) => `${Math.round(n * 100)}%`;

function missionTable() {
  return Object.values(MISSION_PROFILES)
    .map((p) => {
      const weights = Object.entries(p.weights)
        .map(([id, w]) => `<li><span>${FACTORS[id].label}</span><b>${pct(w)}</b></li>`)
        .join('');
      const constraints = p.constraints.map((c) => `<li>${c.label}</li>`).join('');
      return `<article class="method-card">
        <h4>${p.label}</h4>
        <p>${p.description}</p>
        <ul class="weight-list">${weights}</ul>
        <p class="fine"><strong>Hard screen:</strong></p><ul class="fine-list">${constraints}</ul>
      </article>`;
    })
    .join('');
}

function gradeTable() {
  return GRADE_BANDS.map(
    (b) => `<tr><td><span class="grade-chip grade-${b.letter}">${b.letter}</span></td><td>${b.label}</td><td>${b.min}–${b === GRADE_BANDS[0] ? 100 : GRADE_BANDS[GRADE_BANDS.indexOf(b) - 1].min - 0.1}</td><td>${b.blurb}</td></tr>`,
  ).join('');
}

function dimensionTable() {
  return SIMILARITY_DIMENSIONS.map(
    (d) => `<tr><td>${d.label}</td><td>${pct(d.weight)}</td><td>${d.unit || 'categorical'}</td><td>${d.note}</td></tr>`,
  ).join('');
}

function datasetCards() {
  return DATASET_ORDER.map((id) => {
    const d = DATASETS[id];
    const vars = d.variables.map((v) => `<li><span>${v.label}</span><code>${v.unit}</code></li>`).join('');
    return `<article class="source-card">
      <div class="source-head">
        <h4>${d.title}</h4>
        <span class="source-agency">${d.agency}</span>
      </div>
      <p>${d.purpose}</p>
      <dl class="source-meta">
        <div><dt>Mission</dt><dd>${d.mission}</dd></div>
        <div><dt>Resolution</dt><dd>${d.resolution}</dd></div>
        <div><dt>Coverage</dt><dd>${d.coverage}</dd></div>
        <div><dt>Temporal</dt><dd>${d.temporal}</dd></div>
        <div><dt>Access</dt><dd>${d.access}</dd></div>
        <div><dt>Coordinate reference</dt><dd>${d.crs}</dd></div>
        <div><dt>Licensing</dt><dd>${d.license}</dd></div>
        <div><dt>Processing in RADIUM</dt><dd>${d.processing}</dd></div>
      </dl>
      <p class="fine"><strong>Variables:</strong></p><ul class="var-list">${vars}</ul>
      <p class="limit"><strong>Known limitations.</strong> ${d.limitations}</p>
      <a class="text-link" href="${d.url}" target="_blank" rel="noopener">Open source record ↗</a>
    </article>`;
  }).join('');
}

function affinityTables() {
  const substrate = Object.keys(SUBSTRATE_AFFINITY)
    .map((a) => `<tr><th>${a}</th>${Object.keys(SUBSTRATE_AFFINITY).map((b) => `<td>${SUBSTRATE_AFFINITY[a][b] ?? (SUBSTRATE_AFFINITY[b]?.[a] ?? 0.15)}</td>`).join('')}</tr>`)
    .join('');
  const cols = Object.keys(SUBSTRATE_AFFINITY).map((k) => `<th>${k}</th>`).join('');
  const volatiles = Object.entries(VOLATILE_AFFINITY)
    .map(([a, row]) => `<tr><th>${a}</th>${Object.keys(VOLATILE_AFFINITY).map((b) => `<td>${row[b] ?? VOLATILE_AFFINITY[b]?.[a] ?? 0.15}</td>`).join('')}</tr>`)
    .join('');
  return `<div class="table-scroll"><table class="matrix"><thead><tr><th></th>${cols}</tr></thead><tbody>${substrate}</tbody></table></div>
    <div class="table-scroll"><table class="matrix"><thead><tr><th></th>${Object.keys(VOLATILE_AFFINITY).map((k) => `<th>${k}</th>`).join('')}</tr></thead><tbody>${volatiles}</tbody></table></div>`;
}

export const MODAL_CONTENT = {
  methodology: () => `
    <div class="modal-body prose">
      <p class="eyebrow">Scientific method</p>
      <h2>Two questions. Two algorithms. No merged grade.</h2>
      <p>RADIUM deliberately separates <strong>planetary site suitability</strong> (“is this a good place for this mission?”) from <strong>Earth analog similarity</strong> (“which terrestrial environment shares measurable characteristics with this place?”). Both are shown as letters, but they answer different questions and are never combined into one score.</p>

      <h3>1 · Site suitability</h3>
      <p>For each site and mission profile, factors are normalised to 0–100 and combined:</p>
      <pre class="formula">S = Σ (wᵢ · sᵢ) / Σ wᵢ</pre>
      <p>Weights are the mission-profile defaults multiplied by your priority sliders, then renormalised over <em>available</em> factors. If a factor has no data, its weight is removed and the rest are renormalised; the interface reports the resulting coverage and never silently assumes a value. Grades are capped at <strong>F</strong> when a documented hard screen is violated, even if the weighted score is higher.</p>
      <div class="method-grid">${missionTable()}</div>
      <p class="fine">Hard screens are RADIUM-defined exploratory checks. Real landing and construction limits are vehicle- and architecture-specific and must be analysed with much higher-resolution data.</p>

      <h3>2 · Grade bands</h3>
      <div class="table-scroll"><table class="grade-table"><thead><tr><th>Grade</th><th>Meaning</th><th>Score</th><th>Interpretation</th></tr></thead><tbody>${gradeTable()}</tbody></table></div>

      <h3>3 · Earth analog similarity</h3>
      <pre class="formula">A = Σ (vᵢ · dᵢ) / Σ vᵢ</pre>
      <p>Each dimension is compared with a documented scale or a categorical affinity. Missing dimensions are dropped and weights renormalised. Confidence = coverage × mean evidence quality. The grade describes closeness of measured characteristics, not physical equivalence.</p>
      <div class="table-scroll"><table><thead><tr><th>Dimension</th><th>Weight</th><th>Unit</th><th>Comparison and caveat</th></tr></thead><tbody>${dimensionTable()}</tbody></table></div>
      <p>The Moon/Mars view reports the <strong>top five</strong> Earth analogs. The inverse view matches each Earth site against all 31 curated planetary sites; that best match sets its overall analog grade and its eight-factor profile. Selecting a Moon/Mars site also arms a head-to-head target: click any Earth pin to compare every available dimension directly with that site. All mission factors and similarity dimensions are shown as grade-coloured bars; missing data is a dashed “Data unavailable” bar. A shortlist identifies less-studied candidates from the statistical ranking, not newly discovered field sites. Dust, biology and subsurface factors have no comparable datasets and are explicitly shown as unassessed rather than inferred. The operations row is terrain-only; gravity, pressure, radiation and infrastructure are excluded.</p>
      <p><strong>Clicked-point experimental score.</strong> Any Earth coordinate can be measured without being in the curated pool. The point dossier combines NASA POWER/ERA5 climate, multi-scale Copernicus terrain (1 km, 10 km and 50 km 3×3 grids), SoilGrids 0–30 cm topsoil context and the nearest Smithsonian Holocene volcano. The numeric score still uses only the seven comparable similarity dimensions. Soil texture and volcano proximity are displayed as context and are never folded into the score. If the primary elevation service fails, Open-Elevation/SRTM is used and labelled. Coverage, source availability and missing dimensions are shown explicitly; the interface calls this an <em>experimental</em> score rather than a curated analog grade.</p>

      <h3>4 · Categorical affinity</h3>
      <p>Material and volatile classes use fixed affinities rather than pretending that, for example, salt and basalt are numerically close. Symmetric matrices are shown in full.</p>
      ${affinityTables()}

      <h3>5 · What is explicitly not compared</h3>
      <p>Gravity, atmospheric pressure and composition, radiation environment, magnetic field and dust-regime physics are <strong>excluded from the similarity score</strong>. Earth cannot reproduce lunar or Martian gravity or vacuum. These are listed on every comparison instead of being hidden inside a number.</p>

      <h3>6 · Data and uncertainty</h3>
      <ul>
        <li>Planetary elevation, slope and roughness are computed live from 0.25°/px LOLA and MOLA DEMs (~7.6 km and ~14.8 km per pixel at the equator). They are regional, not landing-hazard, measurements.</li>
        <li>Planetary temperature, illumination and ice indices are labelled <em>observed</em>, <em>published model</em>, <em>modelled estimate</em>, <em>inferred</em> or <em>assessment</em>. Every value carries a note and uncertainty where applicable.</li>
        <li>Earth climate is ${CLIMATE_SOURCE_LABEL}, fetched live; 2 m air temperature is an Earth-side thermal proxy and is flagged as such. Annual surface albedo is the POWER/MERRA-2 broadband reflectance, used only for the brightness profile. Aridity uses a documented Hargreaves ET₀ estimate where the source lacks reference ET. POWER surface/root-zone wetness and AOD are shown as context. Earth terrain is sampled from Copernicus DEM GLO-90 at 1 km, 10 km and 50 km scales for clicked points; Open-Elevation/SRTM is the labelled fallback. SoilGrids topsoil and Smithsonian GVP nearest-volcano data are context only.</li>
        <li>Nothing is filled in when a service or dataset is unavailable: the interface states “Data unavailable.” and reduces coverage/confidence.</li>
      </ul>

      <h3>7 · Scope and honesty</h3>
      <p>RADIUM v1 implements a scientifically grounded vertical slice: 16 lunar sites, 15 Mars sites, 34 terrestrial candidates, live Earth measurements, top-five Earth Twin rankings, reverse Earth-to-planet matching, eight-factor Earth profiles, all-factor grade bars, luminosity/thermal-cycling/trafficability factors, per-site brightness/albedo factors, direct planetary-to-Earth comparisons, a less-studied candidate shortlist, explainable grades and a functioning Earth Twin Mode. The Earth map includes NASA Blue Marble, ASTER GDEM topography, MODIS land-surface temperature and albedo, and MERRA-2 monthly aerosol layers. It is not a global survey of every possible analog, nor a landing-certification tool. See “Data sources” for provenance and limitations of each product.</p>
      <p class="caveat">${MISSION_CAVEAT}</p>
    </div>`,

  sources: () => `
    <div class="modal-body prose">
      <p class="eyebrow">Provenance</p>
      <h2>Data sources, resolution and limitations</h2>
      <p>Each measurement shown in RADIUM traces to a record below. Planetary DEMs are bundled for reproducible point queries; imagery and Earth measurements are fetched live from agency services. Links open the original archives.</p>
      <div class="source-grid">${datasetCards()}</div>
      <h3>Attribution</h3>
      <p>NASA imagery and PDS data are public domain; attribution to the mission and instrument is retained on the map and in site panels. NASA POWER and ERA5/Copernicus data remain subject to their providers' terms. Esri reference labels are used with attribution on the map. RADIUM is an independent Space Apps project and is not an official NASA product.</p>
    </div>`,

  scope: () => `
    <div class="modal-body prose">
      <p class="eyebrow">About this build</p>
      <h2>What is implemented, and what is not</h2>
      <p><strong>Implemented:</strong> interactive 3D lunar and Martian globes with NASA Trek imagery; a 2D Earth map with NASA GIBS temperature and aerosol overlays; real LOLA/MOLA DEM sampling for elevation, slope and roughness; mission profiles with adjustable priorities and live re-ranking; explainable A–F suitability grades; Earth Twin Mode with dimension-level similarity, strong/weak matches, applications and explicit physical mismatches; experimental point scores for arbitrary Earth coordinates with multi-scale terrain, SoilGrids and Smithsonian GVP context; dataset provenance and limitations.</p>
      <p><strong>Not implemented:</strong> global per-pixel temperature or ice maps; certified landing-hazard analysis at metre scale; gravity/atmosphere/radiation simulation; autonomous discovery of arbitrary new analog sites outside the curated candidate pool; a database-backed multi-user backend. These are stated as limitations rather than simulated.</p>
      <p>All site coordinates, grades and matches are generated by the code in this repository at runtime. No grade is hardcoded in the interface.</p>
    </div>`,
};

let activeModal = null;

export function openModal(kind, title) {
  closeModal();
  const root = document.getElementById('modal-root');
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="${title}">
      <header class="modal-head">
        <div><span class="brand-mark small">◈</span><span>${title}</span></div>
        <button class="icon-btn" data-close aria-label="Close dialog">✕</button>
      </header>
      <div class="modal-scroll">${(MODAL_CONTENT[kind] || MODAL_CONTENT.scope)()}</div>
    </div>`;
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.closest('[data-close]')) closeModal();
  });
  root.appendChild(overlay);
  activeModal = overlay;
  document.body.classList.add('modal-open');
  overlay.querySelector('[data-close]')?.focus();
  document.addEventListener('keydown', escClose);
}

function escClose(e) {
  if (e.key === 'Escape') closeModal();
}

export function closeModal() {
  if (!activeModal) return;
  activeModal.remove();
  activeModal = null;
  document.body.classList.remove('modal-open');
  document.removeEventListener('keydown', escClose);
}
