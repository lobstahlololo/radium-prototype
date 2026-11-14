/**
 * Planetary site suitability — separate from Earth analog similarity.
 *
 * Method: weighted multicriteria model over mission-specific factors.
 *   score = Σ (wᵢ · sᵢ) / Σ wᵢ   over factors with available data
 * Weights come from a mission profile and are multiplied by user priorities,
 * then renormalised over available factors (documented missing-data policy).
 * Hard constraints are RADIUM-defined operational screens, not NASA standards.
 */

import { clamp01, letterGrade, piecewise, round } from './grade.js';
import { effectiveSolar, marsPressureKPa, meanSurfaceIrradiance } from './solar.js';

export const FACTORS = {
  ice: { label: 'Water & ice resources', unit: 'ice evidence index', higherBetter: true, description: 'Mapped ice evidence or hydration at regional scale; stronger evidence scores higher.' },
  solar: { label: 'Solar energy', unit: 'fraction of solar constant', higherBetter: true, description: 'Modelled annual mean surface insolation as a fraction of the solar constant. Polar illumination-time percentages are shown separately because they are not an energy quantity.' },
  luminosity: { label: 'Luminosity — mean irradiance', unit: 'W/m²', higherBetter: true, description: 'Absolute modelled annual mean surface irradiance. The Moon and Mars receive different stellar flux at their orbits, so the same relative solar fraction does not deliver the same power.' },
  thermalCycle: { label: 'Thermal cycling', unit: 'K diurnal range', higherBetter: false, description: 'Mean monthly diurnal temperature range as an engineering proxy for thermal fatigue and survival-heater demand.' },
  trafficability: { label: 'Surface trafficability', unit: 'RADIUM assessment', higherBetter: true, description: 'RADIUM-defined assessment of likely bearing and traction from the broad substrate class. It is not measured regolith mechanics or a rover mobility certificate.' },
  slope: { label: 'Terrain safety — slope', unit: '°', higherBetter: false, description: 'Regional slope from the 0.25°/px DEM. Landing and construction need much finer terrain data.' },
  roughness: { label: 'Terrain roughness', unit: 'm relief (σ)', higherBetter: false, description: 'Standard deviation of elevation in a ~30 km window; a mobility and construction indicator.' },
  temp: { label: 'Thermal conditions', unit: 'K mean', higherBetter: true, description: 'Regional mean surface temperature; operational comfort, not a measured time series at the point.' },
  comms: { label: 'Earth communication', unit: 'Earth visibility fraction', higherBetter: true, description: 'Geometric Earth visibility for the Moon; terrain and relay geometry not resolved.' },
  dust: { label: 'Dust exposure', unit: 'categorical risk', higherBetter: false, description: 'Coarse regional dust-storm exposure assessment from published climatology, not a measured opacity record.' },
  elevation: { label: 'Landing altitude / atmosphere', unit: 'm', higherBetter: false, description: 'Lower elevation gives more atmosphere for entry, descent and parachute performance. A proxy, not a certified EDL constraint.' },
  geology: { label: 'Geological relevance', unit: 'RADIUM assessment', higherBetter: true, description: 'RADIUM editorial assessment of geological diversity/resource relevance from published mission science.' },
  science: { label: 'Exploration value', unit: 'RADIUM assessment', higherBetter: true, description: 'RADIUM editorial assessment of published scientific significance for exploration.' },
};

export const MISSION_PROFILES = {
  lunar_base: {
    id: 'lunar_base',
    body: 'moon',
    label: 'Lunar Permanent Base',
    short: 'Lunar base',
    description: 'Long-duration surface presence: prioritises ice access, power, stable terrain and Earth communications.',
    weights: { ice: 0.2, solar: 0.13, luminosity: 0.05, slope: 0.12, roughness: 0.08, temp: 0.09, thermalCycle: 0.06, comms: 0.1, geology: 0.07, science: 0.06, trafficability: 0.04 },
    constraints: [{ factor: 'slope', max: 25, label: 'Slope above 25° fails the base-construction screen (RADIUM-defined).' }],
  },
  mars_robotic: {
    id: 'mars_robotic',
    body: 'mars',
    label: 'Mars Robotic Landing',
    short: 'Robotic landing',
    description: 'Safe landing and surface operations for a robotic mission: slope, roughness and altitude dominate.',
    weights: { slope: 0.18, roughness: 0.13, elevation: 0.1, ice: 0.1, solar: 0.08, luminosity: 0.04, thermalCycle: 0.06, science: 0.14, dust: 0.08, trafficability: 0.05, geology: 0.04 },
    constraints: [{ factor: 'slope', max: 15, label: 'Slope above 15° fails the robotic landing screen (RADIUM-defined; real EDL limits are vehicle-specific).' }],
  },
  mars_human: {
    id: 'mars_human',
    body: 'mars',
    label: 'Mars Human Exploration',
    short: 'Human exploration',
    description: 'Crewed surface exploration: balances resources, terrain, thermal and dust exposure with science value.',
    weights: { ice: 0.18, solar: 0.1, luminosity: 0.04, slope: 0.1, roughness: 0.07, temp: 0.08, thermalCycle: 0.07, dust: 0.08, science: 0.12, geology: 0.05, elevation: 0.06, trafficability: 0.05 },
    constraints: [{ factor: 'slope', max: 20, label: 'Slope above 20° fails the crewed-operations screen (RADIUM-defined).' }],
  },
};

export function profileForBody(body, missionId) {
  const p = MISSION_PROFILES[missionId];
  if (p && p.body === body) return p;
  return Object.values(MISSION_PROFILES).find((x) => x.body === body) || null;
}

export function prioritiesFor(profile) {
  return Object.keys(profile.weights).map((id) => ({ id, ...FACTORS[id], weight: profile.weights[id] }));
}

function evidenceQuality(ev) {
  return { observed: 1, derived: 0.92, 'published-model': 0.8, modeled: 0.68, inferred: 0.5, assessment: 0.55 }[ev] ?? 0.6;
}

/** Evaluates one factor, returning a 0-100 sub-score or availability=false. */
export function evaluateFactor(id, site, terrain, body) {
  const unavailable = (why) => ({ available: false, score: null, evidence: null, detail: why, raw: null, unit: FACTORS[id]?.unit || '' });

  switch (id) {
    case 'ice': {
      if (!site.ice) return unavailable('No mapped ice or hydration evidence in the selected source.');
      return {
        available: true,
        score: site.ice.score,
        evidence: site.ice.evidence || 'inferred',
        raw: site.ice.score,
        unit: 'index 0–100',
        detail: `${site.ice.class.replace(/_/g, ' ')} — ${site.ice.note}`,
      };
    }
    case 'solar': {
      const solar = effectiveSolar(site);
      const score = piecewise(solar.value, [[0, 0], [0.05, 12], [0.15, 35], [0.25, 60], [0.35, 80], [0.5, 95], [0.7, 100]]);
      const extra = solar.publishedIllumination
        ? ` Published illumination model: ${Math.round(solar.publishedIllumination.value * 100)}% of the year sunlit (a time fraction, not energy).`
        : '';
      return { available: true, score, evidence: solar.evidence, raw: solar.value, unit: 'fraction of solar constant', detail: `${solar.note}${extra}` };
    }
    case 'luminosity': {
      const irradiance = meanSurfaceIrradiance(site);
      if (!irradiance) return unavailable('No orbital irradiance or latitude available for this site.');
      const score = piecewise(irradiance.value, [[0, 0], [50, 8], [100, 22], [150, 42], [250, 62], [400, 85], [600, 96], [900, 100]]);
      return { available: true, score, evidence: irradiance.evidence, raw: irradiance.value, unit: 'W/m²', detail: irradiance.note };
    }
    case 'thermalCycle': {
      if (!site.tempAmpK) return unavailable('No diurnal temperature range available for this site.');
      const amp = Number(site.tempAmpK.value);
      const score = piecewise(amp, [[0, 100], [10, 92], [25, 75], [50, 50], [80, 25], [120, 8], [200, 0]]);
      return { available: true, score, evidence: site.tempAmpK.evidence || 'modeled', raw: amp, unit: 'K', detail: `Mean diurnal range ${Math.round(amp)} K: lower cycling is easier on seals, electronics and structures. ${site.tempAmpK.note || ''}` };
    }
    case 'trafficability': {
      const map = {
        basalt: [82, 'Hard basaltic rock and regolith: generally predictable bearing, with loose surface material still vehicle-dependent.'],
        highland: [74, 'Fractured highland rock and regolith: variable bearing, but broadly competent for traverses.'],
        impact: [70, 'Impact breccia, ejecta and melt: mixed bearing and localized rubble.'],
        sulfate: [48, 'Sulfate-rich layered material: often soft or friable, with uncertain bearing.'],
        clay: [38, 'Clay-bearing ground: potential mudstone/soft sediment and low bearing after disturbance.'],
        salt: [55, 'Salt crust and evaporite: hard crusts can overlie weak or void-rich material.'],
        ice: [22, 'Ice-rich ground: strength is strongly temperature- and ice-content-dependent.'],
        permafrost: [42, 'Ice-cemented permafrost: variable bearing and thaw sensitivity.'],
        tephra: [32, 'Loose tephra and ash: low bearing and high wheel-slip potential.'],
        sand: [40, 'Sand and desert pavement: trafficable in places, but loose sand can trap wheels.'],
        silica: [60, 'Silica-rich volcanic material: competent in places, with abrasive dust.'],
        carbonate: [68, 'Carbonate bedrock and sediments: generally competent, with karst or fracture uncertainty.'],
        granite: [86, 'Crystalline granite: high expected bearing where exposed and unfractured.'],
        andesite: [72, 'Andesitic volcanic rock: competent lava and breccia with local loose cover.'],
        ultramafic: [78, 'Dense ultramafic rock: high expected bearing where exposed and unfractured.'],
      }[site.substrateGroup];
      if (!map) return unavailable('No substrate class available for a trafficability assessment.');
      return { available: true, score: map[0], evidence: 'assessment', raw: site.substrateGroup, unit: 'substrate class', detail: `${map[1]} RADIUM-defined screening assessment; not measured regolith mechanics.` };
    }
    case 'slope': {
      if (!terrain || terrain.slopeDeg === null) return unavailable('DEM coverage unavailable at this location.');
      const score = piecewise(terrain.slopeDeg, [[0, 100], [2, 95], [5, 80], [8, 60], [12, 35], [20, 10], [30, 0]]);
      return { available: true, score, evidence: 'derived', raw: terrain.slopeDeg, unit: '°', detail: `Regional slope from ${terrain.datasetLabel}.` };
    }
    case 'roughness': {
      if (!terrain || terrain.roughnessM === null) return unavailable('DEM coverage unavailable at this location.');
      const score = piecewise(terrain.roughnessM, [[0, 100], [3, 90], [8, 75], [20, 55], [50, 30], [100, 12], [200, 0]]);
      return { available: true, score, evidence: 'derived', raw: terrain.roughnessM, unit: 'm σ', detail: `Elevation standard deviation over ${terrain.windowKm} km.` };
    }
    case 'temp': {
      if (!site.tempMeanK) return unavailable('No regional surface-temperature climatology available for this site.');
      const score = piecewise(site.tempMeanK.value, [[120, 12], [160, 38], [200, 68], [230, 88], [250, 96], [270, 100], [300, 90], [340, 60], [400, 25]]);
      return { available: true, score, evidence: site.tempMeanK.evidence || 'modeled', raw: site.tempMeanK.value, unit: 'K', detail: site.tempMeanK.note };
    }
    case 'comms': {
      if (body !== 'moon' || !site.earthVisibility) return unavailable('Direct-to-Earth geometry is not site-differentiating for this body in RADIUM v1.');
      const score = clamp01(site.earthVisibility.value) * 100;
      return { available: true, score, evidence: site.earthVisibility.evidence || 'derived', raw: site.earthVisibility.value, unit: 'fraction', detail: site.earthVisibility.note };
    }
    case 'dust': {
      if (!site.dustRisk) return unavailable('No regional dust assessment available.');
      const map = { low: 85, moderate: 55, high: 25 };
      return {
        available: true,
        score: map[site.dustRisk.class] ?? null,
        evidence: 'assessment',
        raw: site.dustRisk.class,
        unit: 'risk class',
        detail: site.dustRisk.basis,
      };
    }
    case 'elevation': {
      if (!terrain || terrain.elevationM === null) return unavailable('DEM coverage unavailable at this location.');
      const score = piecewise(terrain.elevationM, [[-8000, 100], [-4000, 92], [-2000, 78], [0, 58], [4000, 28], [8000, 10], [12000, 0]]);
      return {
        available: true,
        score,
        evidence: 'derived',
        raw: terrain.elevationM,
        unit: 'm',
        detail: `Elevation ${Math.round(terrain.elevationM)} m; implied mean pressure ≈ ${round(marsPressureKPa(terrain.elevationM), 2)} kPa (barometric approximation).`,
      };
    }
    case 'geology': {
      if (!site.geologyValue) return unavailable('No geological relevance assessment available.');
      return { available: true, score: site.geologyValue.score, evidence: 'assessment', raw: site.geologyValue.score, unit: 'index 0–100', detail: site.geologyValue.rationale };
    }
    case 'science': {
      if (!site.scienceValue) return unavailable('No exploration-value assessment available.');
      return { available: true, score: site.scienceValue.score, evidence: 'assessment', raw: site.scienceValue.score, unit: 'index 0–100', detail: site.scienceValue.rationale };
    }
    default:
      return unavailable('Unknown factor.');
  }
}

/**
 * @param {object} site planetary site record
 * @param {object|null} terrain DEM sample
 * @param {string} missionId
 * @param {object} multipliers priority multiplier per factor id (default 1)
 */
export function computeSuitability(site, terrain, missionId, multipliers = {}) {
  const profile = MISSION_PROFILES[missionId];
  if (!profile) return null;

  const factors = [];
  let weightSum = 0;
  let availableWeight = 0;
  let quality = 0;

  for (const [id, baseWeight] of Object.entries(profile.weights)) {
    const mult = Number.isFinite(multipliers?.[id]) ? multipliers[id] : 1;
    const weight = baseWeight * Math.max(0, mult);
    weightSum += weight;
    const res = evaluateFactor(id, site, terrain, profile.body);
    const entry = {
      id,
      label: FACTORS[id].label,
      unit: res.unit,
      baseWeight,
      multiplier: mult,
      weight,
      effectiveWeight: 0,
      score: res.score,
      raw: res.raw,
      evidence: res.evidence,
      detail: res.detail,
      available: res.available,
      contribution: 0,
    };
    if (res.available && res.score !== null) {
      availableWeight += weight;
      quality += weight * evidenceQuality(res.evidence);
    }
    factors.push(entry);
  }

  const coverage = weightSum > 0 ? availableWeight / weightSum : 0;
  let score = 0;
  for (const f of factors) {
    if (f.available && f.score !== null) {
      f.effectiveWeight = f.weight / (availableWeight || 1);
      f.contribution = f.effectiveWeight * f.score;
      score += f.contribution;
    }
  }
  score = availableWeight > 0 ? score : null;

  const confidence = coverage > 0 ? coverage * (quality / availableWeight) : 0;

  // Hard constraints (RADIUM screens, documented; vehicle-specific in reality).
  const violations = [];
  for (const c of profile.constraints) {
    const f = factors.find((x) => x.id === c.factor);
    if (f && f.available && typeof f.raw === 'number' && f.raw > c.max) {
      violations.push({ factor: c.factor, label: c.label, value: f.raw, max: c.max });
    }
  }

  let grade = letterGrade(score);
  let ratingNote = '';
  if (score === null || coverage < 0.5) {
    grade = null;
    ratingNote = 'Insufficient data coverage for a graded assessment (less than 50% of mission weight has data).';
  } else if (violations.length > 0) {
    grade = 'F';
    ratingNote = 'A documented mission screen is violated, so the grade is capped at F even though the weighted score is shown.';
  }

  const rankedFactors = [...factors].filter((f) => f.available).sort((a, b) => b.contribution - a.contribution);
  const strengths = rankedFactors.slice(0, 2);
  const weakest = [...rankedFactors].reverse().slice(0, 2);

  return {
    missionId,
    missionLabel: profile.label,
    score: score === null ? null : round(score, 2),
    grade,
    ratingNote,
    coverage: round(coverage, 3),
    confidence: round(confidence, 3),
    factors,
    strengths,
    weakest,
    violations,
    missing: factors.filter((f) => !f.available).map((f) => ({ id: f.id, label: f.label, reason: f.detail })),
    summary: buildSummary(profile, score, grade, strengths, weakest, coverage, violations),
    caveat:
      'RADIUM-defined weighted assessment. Weights are mission-profile defaults adjusted by your priorities, normalised over available factors. Not an official NASA suitability standard.',
  };
}

function buildSummary(profile, score, grade, strengths, weakest, coverage, violations) {
  if (score === null) return 'Not enough site data to compute a graded suitability assessment.';
  const s = strengths.map((f) => f.label.toLowerCase()).slice(0, 2).join(' and ');
  const w = weakest.map((f) => f.label.toLowerCase()).slice(0, 2).join(' and ');
  let text = `${profile.label}: ${grade ?? 'unrated'} (weighted score ${round(score, 0)}/100, ${Math.round(coverage * 100)}% of mission weight has data). Strongest contributions: ${s}. Limiting factors: ${w}.`;
  if (violations.length) text += ` Constraint violated: ${violations[0].label}`;
  return text;
}

export function compareSuitability(a, b) {
  if (!a || !b) return 0;
  return (b.score ?? -1) - (a.score ?? -1);
}

export function weightShares(profile, multipliers = {}) {
  const total = Object.entries(profile.weights).reduce((acc, [id, w]) => acc + w * (Number.isFinite(multipliers[id]) ? multipliers[id] : 1), 0);
  return Object.entries(profile.weights).map(([id, w]) => ({
    id,
    label: FACTORS[id].label,
    share: total > 0 ? (w * (Number.isFinite(multipliers[id]) ? multipliers[id] : 1)) / total : 0,
  }));
}
