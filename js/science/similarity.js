/**
 * Earth Twin Mode — cross-planetary similarity engine.
 *
 * This is deliberately separate from planetary site suitability: suitability
 * asks "is this a good place for a mission?", similarity asks "which Earth
 * environment shares measurable characteristics with this planetary place?".
 * A high-similarity analog can be a poor mission site and vice versa.
 *
 * All dimensions are normalised against documented physical scales. Dimensions
 * that cannot be meaningfully compared (gravity, pressure, radiation, dust
 * regime, magnetic field) are excluded and listed explicitly in the interface.
 */

import { clamp01, letterGrade, round } from './grade.js';
import { meanSurfaceIrradiance, SOLAR_IRRADIANCE_WM2 } from './solar.js';

/**
 * Substrate affinity, by broad surface-material group. 1 = same material class
 * and comparable formation process; 0 = no meaningful material analogy.
 * Symmetric; undocumented pairs default to 0.15.
 */
export const SUBSTRATE_AFFINITY = {
  basalt: { basalt: 1.0, tephra: 0.9, ultramafic: 0.85, andesite: 0.78, impact: 0.7, highland: 0.55, silica: 0.45, sand: 0.35, clay: 0.3, carbonate: 0.25, sulfate: 0.2, salt: 0.15, ice: 0.1 },
  highland: { highland: 1.0, impact: 0.75, granite: 0.6, basalt: 0.55, sand: 0.4, tephra: 0.3, salt: 0.25, clay: 0.3, sulfate: 0.2, carbonate: 0.4, ice: 0.1, silica: 0.4 },
  impact: { impact: 1.0, highland: 0.75, basalt: 0.7, sand: 0.4, salt: 0.2, clay: 0.3, sulfate: 0.25, ice: 0.15, granite: 0.55, carbonate: 0.35 },
  sulfate: { sulfate: 1.0, clay: 0.6, salt: 0.45, basalt: 0.2, sand: 0.3, carbonate: 0.35, ice: 0.1, highland: 0.2, tephra: 0.15, granite: 0.1, silica: 0.15 },
  clay: { clay: 1.0, sulfate: 0.6, sand: 0.5, carbonate: 0.45, basalt: 0.3, highland: 0.3, salt: 0.25, ice: 0.12, impact: 0.3, tephra: 0.25 },
  salt: { salt: 1.0, sulfate: 0.45, sand: 0.3, clay: 0.25, basalt: 0.15, ice: 0.25, carbonate: 0.3, highland: 0.25 },
  ice: { ice: 1.0, permafrost: 0.9, tephra: 0.1, basalt: 0.1, highland: 0.1, salt: 0.25, sand: 0.1, clay: 0.12, sulfate: 0.1 },
  permafrost: { permafrost: 1.0, ice: 0.9, sand: 0.2, clay: 0.25, basalt: 0.15, highland: 0.15, salt: 0.2 },
  tephra: { tephra: 1.0, basalt: 0.9, andesite: 0.7, sand: 0.45, silica: 0.5, highland: 0.3, clay: 0.25, impact: 0.35, salt: 0.1, sulfate: 0.15 },
  sand: { sand: 1.0, clay: 0.5, tephra: 0.45, impact: 0.4, basalt: 0.35, highland: 0.4, salt: 0.3, sulfate: 0.3, granite: 0.3, carbonate: 0.2 },
  silica: { silica: 1.0, tephra: 0.5, basalt: 0.45, highland: 0.4, granite: 0.6, clay: 0.2, sulfate: 0.15 },
  carbonate: { carbonate: 1.0, clay: 0.45, highland: 0.4, sulfate: 0.35, salt: 0.3, basalt: 0.25, sand: 0.2 },
  granite: { granite: 1.0, highland: 0.6, silica: 0.6, impact: 0.55, basalt: 0.3, sand: 0.3, clay: 0.2 },
  andesite: { andesite: 1.0, basalt: 0.78, tephra: 0.7, silica: 0.4, highland: 0.35 },
  ultramafic: { ultramafic: 1.0, basalt: 0.85, highland: 0.35, impact: 0.4, clay: 0.2, salt: 0.1 },
};

/** Volatile-setting affinity. This is a categorical process analogy, not a water-quantity comparison. */
export const VOLATILE_AFFINITY = {
  none: { none: 1.0, ephemeral_water: 0.35, hydrated_minerals: 0.3, salt_hydrate: 0.25, ground_ice: 0.1, surface_ice: 0.05 },
  ephemeral_water: { ephemeral_water: 1.0, none: 0.35, salt_hydrate: 0.5, hydrated_minerals: 0.45, ground_ice: 0.2, surface_ice: 0.15 },
  hydrated_minerals: { hydrated_minerals: 1.0, salt_hydrate: 0.6, ephemeral_water: 0.45, none: 0.3, clay: 0.5, ground_ice: 0.25, surface_ice: 0.2 },
  salt_hydrate: { salt_hydrate: 1.0, hydrated_minerals: 0.6, ephemeral_water: 0.5, none: 0.25, ground_ice: 0.3, surface_ice: 0.2 },
  ground_ice: { ground_ice: 1.0, surface_ice: 0.85, none: 0.1, ephemeral_water: 0.2, hydrated_minerals: 0.25, salt_hydrate: 0.3 },
  surface_ice: { surface_ice: 1.0, ground_ice: 0.85, none: 0.05, ephemeral_water: 0.15, hydrated_minerals: 0.2, salt_hydrate: 0.2 },
};

/**
 * Similarity dimensions. `scale` is the value difference that maps to a
 * similarity of zero for linear dimensions. `weight` values sum to 1 and are
 * renormalised over available dimensions at score time.
 */
export const SIMILARITY_DIMENSIONS = [
  {
    id: 'thermalMean',
    label: 'Mean surface temperature',
    unit: 'K',
    weight: 0.14,
    scale: 120,
    evidence: 'medium',
    note: 'Earth uses NASA POWER/ERA5 2 m air temperature as a thermal-environment proxy; Moon/Mars use published surface brightness-temperature climatology. Cross-medium comparison, flagged in caveats.',
  },
  {
    id: 'thermalAmp',
    label: 'Diurnal thermal amplitude',
    unit: 'K',
    weight: 0.14,
    scale: 200,
    evidence: 'medium',
    note: 'A lunar day/night swing of ~280 K has no terrestrial equivalent; this dimension usually exposes the largest physical mismatch.',
  },
  {
    id: 'slope',
    label: 'Terrain slope',
    unit: '°',
    weight: 0.16,
    scale: 12,
    evidence: 'high',
    note: 'Planetary slopes derive from 0.25°/px global DEMs (~7.6 km); Earth slopes from a ~5 km elevation grid. Regional, not outcrop scale.',
  },
  {
    id: 'roughness',
    label: 'Terrain roughness (relief over ~30 km)',
    unit: 'm',
    weight: 0.14,
    scale: null,
    evidence: 'high',
    note: 'Standard deviation of elevation in a ~30 km window, computed consistently on both sides from gridded elevation.',
  },
  {
    id: 'substrate',
    label: 'Surface material / geological substrate',
    unit: '',
    weight: 0.18,
    scale: null,
    evidence: 'medium',
    note: 'Categorical affinity between mapped surface-material classes. Similar appearance does not guarantee similar mineralogy.',
  },
  {
    id: 'volatile',
    label: 'Volatile setting',
    unit: '',
    weight: 0.12,
    scale: null,
    evidence: 'medium',
    note: 'Categorical comparison of how water/ice occurs (none, ground ice, exposed ice, hydrated minerals, ephemeral water, salt hydrate).',
  },
  {
    id: 'luminosity',
    label: 'Luminosity / mean surface irradiance',
    unit: 'W/m²',
    weight: 0.12,
    scale: 300,
    evidence: 'medium',
    note: 'Absolute annual mean surface irradiance. This captures both orbital flux (Mars receives less sunlight than the Moon) and latitude/atmospheric transmission. Earth uses POWER annual shortwave; planetary values are modelled. Polar illumination-time percentages are reported separately and are not compared as energy.',
  },
];

function affinity(matrix, a, b) {
  if (!a || !b) return null;
  if (matrix[a] && typeof matrix[a][b] === 'number') return matrix[a][b];
  if (matrix[b] && typeof matrix[b][a] === 'number') return matrix[b][a];
  return 0.15;
}

/** Extracts the comparable dimensions from a planetary site + DEM terrain sample. */
export function planetDimensions(site, terrain) {
  return {
    thermalMean: site?.tempMeanK?.value ?? null,
    thermalAmp: site?.tempAmpK?.value ?? null,
    slope: terrain?.slopeDeg ?? null,
    roughness: terrain?.roughnessM ?? null,
    substrate: site?.substrateGroup ?? null,
    volatile: site?.volatileGroup ?? null,
    luminosity: meanSurfaceIrradiance(site)?.value ?? null,
  };
}

/** Extracts the comparable dimensions from an Earth candidate (POWER/ERA5 + elevation grid). */
export function earthDimensions(earth) {
  return {
    thermalMean: earth?.climate?.tempMeanK ?? null,
    thermalAmp: earth?.climate?.diurnalAmpK ?? null,
    slope: earth?.terrain?.slopeDeg ?? null,
    roughness: earth?.terrain?.roughnessM ?? null,
    substrate: earth?.substrateGroup ?? null,
    volatile: earth?.volatileGroup ?? null,
    luminosity: Number.isFinite(earth?.climate?.solarFraction) ? Number((earth.climate.solarFraction * SOLAR_IRRADIANCE_WM2.earth).toFixed(1)) : null,
  };
}

export function dimensionSimilarity(id, planetValue, earthValue) {
  if (planetValue === null || planetValue === undefined || earthValue === null || earthValue === undefined) {
    return null;
  }
  if (id === 'substrate') return affinity(SUBSTRATE_AFFINITY, planetValue, earthValue);
  if (id === 'volatile') return affinity(VOLATILE_AFFINITY, planetValue, earthValue);
  if (id === 'roughness') {
    const a = Math.log((Number(planetValue) + 5) / 5);
    const b = Math.log((Number(earthValue) + 5) / 5);
    return clamp01(1 - Math.min(1, Math.abs(a - b) / 2.2));
  }
  const dim = SIMILARITY_DIMENSIONS.find((d) => d.id === id);
  if (!dim || !dim.scale) return null;
  const diff = Math.abs(Number(planetValue) - Number(earthValue));
  return clamp01(1 - Math.min(1, diff / dim.scale));
}

const APPLICATIONS = [
  { test: (e) => e.substrateGroup === 'basalt' && e.terrain, text: 'Basaltic terrain for rover mobility, wheel-regolith interaction and traverse planning.' },
  { test: (e) => e.substrateGroup === 'basalt' && e.volatileGroup === 'none', text: 'Dry basaltic regolith for dust mitigation and mechanical-soil experiments.' },
  { test: (e) => e.substrateGroup === 'tephra', text: 'Volcanic ash/tephra trafficability and sensor calibration over loose pyroclastic material.' },
  { test: (e) => e.substrateGroup === 'sulfate', text: 'Acidic sulfate terrains for astrobiology instrument and sample-handling tests.' },
  { test: (e) => e.substrateGroup === 'clay', text: 'Hydrated clay-bearing sediments for drilling, sample preservation and spectroscopic calibration.' },
  { test: (e) => e.substrateGroup === 'salt', text: 'Evaporite and salt-hydrate chemistry, brine behaviour and salt-cemented surface studies.' },
  { test: (e) => e.substrateGroup === 'impact', text: 'Impact cratering, ejecta distribution and crater-rim traverse analogues.' },
  { test: (e) => e.substrateGroup === 'ice' || e.volatileGroup === 'surface_ice', text: 'Ice drilling, cryogenic sampling and cold-surface operations.' },
  { test: (e) => e.volatileGroup === 'ground_ice', text: 'Permafrost/ground-ice engineering, thermal drilling and buried-ice detection tests.' },
  { test: (e) => e.substrateGroup === 'highland', text: 'Anorthositic highland geology and reflectance/spectral calibration.' },
  { test: (e) => e.substrateGroup === 'silica', text: 'Silica-rich volcanic surfaces for thermal-inertia and mineral-mapping studies.' },
  { test: (e) => e.climate?.solarFraction > 0.55, text: 'High-insolation site for solar-power array and thermal-control testing.' },
];

function applicationsFor(earth) {
  const out = APPLICATIONS.filter((a) => {
    try {
      return a.test(earth);
    } catch {
      return false;
    }
  }).map((a) => a.text);
  return [...new Set(out)].slice(0, 4);
}

function evidenceQuality(dim, planetSite, earth) {
  if (dim.id === 'substrate' || dim.id === 'volatile') return 0.7;
  if (dim.id === 'thermalMean' || dim.id === 'thermalAmp') return 0.6;
  if (dim.id === 'solar') return 0.75;
  if (dim.id === 'slope' || dim.id === 'roughness') return earth?.terrain?.resolutionKm ? 0.85 : 0.7;
  return 0.7;
}

function incomparableFor(body) {
  const g = { moon: '1.62 m/s²', mars: '3.71 m/s²' }[body] || '—';
  const p = { moon: 'effectively vacuum (<10⁻¹⁰ Pa)', mars: '~0.6 kPa mean (seasonal, elevation-dependent)' }[body] || '—';
  return [
    { id: 'gravity', label: 'Surface gravity', planet: g, earth: '9.81 m/s²', why: 'No terrestrial site reproduces lunar or Martian gravity. Soil bearing, rover traction and human biomechanics will differ regardless of surface similarity.' },
    { id: 'pressure', label: 'Atmospheric pressure', planet: p, earth: '~101.3 kPa', why: 'Pressure-dependent processes (dust lifting, heat transfer, parachute descent, fluid stability) cannot be replicated on Earth at ambient conditions.' },
    { id: 'radiation', label: 'Radiation environment', planet: body === 'moon' ? 'No global magnetic field or atmosphere; GCR + solar particle events reach the surface' : 'Thin atmosphere, no global dynamo; surface dose dominated by GCR and SEPs', earth: 'Atmosphere and magnetosphere provide substantial shielding', why: 'Radiation shielding and dosimetry tests require environmental chambers or high-altitude/space analogs, not the landscape alone.' },
    { id: 'atmosphere', label: 'Atmospheric composition and dust regime', planet: body === 'mars' ? 'CO₂-dominated, global dust storms, dust devils' : 'No atmosphere; electrostatic dust transport dominates', earth: 'N₂/O₂ atmosphere; dust behaviour controlled by terrestrial wind and moisture', why: 'Dust suspension, settling and optical effects are process analogues at best; the physical regimes differ.' },
  ];
}

/**
 * Compares one planetary site with one Earth candidate.
 * @param {{site: object, terrain: object, body: string}} planet
 * @param {object} earth candidate with {substrateGroup, volatileGroup, climate, terrain}
 */
export function comparePair(planet, earth) {
  const pDims = planetDimensions(planet.site, planet.terrain);
  const eDims = earthDimensions(earth);
  const dims = [];
  let availWeight = 0;
  let qualityWeighted = 0;

  for (const def of SIMILARITY_DIMENSIONS) {
    const sim = dimensionSimilarity(def.id, pDims[def.id], eDims[def.id]);
    const available = sim !== null;
    if (available) {
      availWeight += def.weight;
      qualityWeighted += def.weight * evidenceQuality(def, planet.site, earth);
    }
    dims.push({
      id: def.id,
      label: def.label,
      unit: def.unit,
      weight: def.weight,
      effectiveWeight: available ? null : 0,
      planetValue: pDims[def.id],
      earthValue: eDims[def.id],
      similarity: sim,
      grade: sim === null ? null : letterGrade(sim * 100),
      available,
      note: def.note,
    });
  }

  // Missing-data policy: drop unavailable dimensions and renormalise the rest.
  let score = 0;
  for (const d of dims) {
    if (d.available) {
      d.effectiveWeight = d.weight / (availWeight || 1);
      score += d.effectiveWeight * d.similarity * 100;
    }
  }
  score = availWeight > 0 ? score : null;

  const coverage = availWeight;
  const meanQuality = availWeight > 0 ? qualityWeighted / availWeight : 0;
  const confidence = Number.isFinite(score) ? coverage * meanQuality : 0;

  const ranked = dims.filter((d) => d.available).sort((a, b) => b.similarity - a.similarity);
  const strong = ranked.filter((d) => d.similarity >= 0.7).slice(0, 3);
  const weak = [...ranked].reverse().filter((d) => d.similarity <= 0.45).slice(0, 3);

  return {
    earthId: earth.id,
    earthName: earth.name,
    score: score === null ? null : round(score, 2),
    grade: letterGrade(score),
    coverage: round(coverage, 2),
    confidence: round(confidence, 2),
    dimensions: dims,
    strong,
    weak,
    applications: applicationsFor(earth),
    incomparable: incomparableFor(planet.body),
    caveats: [
      'Similarity is not equivalence: a letter grade describes how closely measured characteristics align, not whether the site reproduces planetary conditions.',
      'Planetary temperature, illumination and volatile values are regional estimates or published models, not measurements at the exact clicked point.',
      'Earth terrain metrics use a ~5 km elevation grid; planetary metrics use ~7.6 km DEM cells. Both are regional-scale comparisons.',
      ...(earth.climate?.source ? [] : ['Earth climate normals are unavailable for this candidate, so thermal and luminosity dimensions were dropped from the score.']),
    ],
  };
}

/** Ranks a candidate pool for a planetary site, best first. */
export function rankAnalogs(planet, earthCandidates) {
  return earthCandidates
    .map((earth) => comparePair(planet, earth))
    .filter((r) => r.score !== null)
    .sort((a, b) => b.score - a.score || b.confidence - a.confidence);
}

/**
 * Ranks planetary sites for one Earth candidate, best first. This is the inverse
 * direction of rankAnalogs and answers "which Moon/Mars site does this Earth
 * place most closely resemble?".
 */
export function rankPlanetMatches(earth, planetCandidates) {
  return planetCandidates
    .map((planet) => ({
      ...comparePair(planet, earth),
      planetSite: planet.site,
      planetBody: planet.body,
    }))
    .filter((r) => r.score !== null)
    .sort((a, b) => b.score - a.score || b.confidence - a.confidence);
}

/**
 * The eight requested Earth assessment categories, grouped from the comparable
 * similarity dimensions. Categories without a comparable dataset remain
 * explicitly unassessed; they are never filled with a synthetic grade.
 *
 * `dimensionIds` are combined with the effective weights from comparePair, so
 * a group grade is still a similarity percentage, not an absolute habitat score.
 */
export const EARTH_FACTOR_GROUPS = [
  {
    id: 'materials',
    label: 'Geology, mineralogy & surface materials',
    dimensionIds: ['substrate'],
    note: 'Categorical surface-material affinity only. Similar appearance does not establish similar mineralogy.',
  },
  {
    id: 'terrain',
    label: 'Terrain, elevation, slope, roughness & craters',
    dimensionIds: ['slope', 'roughness'],
    note: 'Slope and regional roughness are measured. Elevation offset and crater populations are not scored.',
  },
  {
    id: 'environment',
    label: 'Temperature, illumination & environmental extremes',
    dimensionIds: ['thermalMean', 'thermalAmp', 'luminosity'],
    note: 'Mean/diurnal thermal proxy and annual solar fraction. Polar illumination time is reported separately.',
  },
  {
    id: 'volatiles',
    label: 'Water, ice, permafrost & potential resources',
    dimensionIds: ['volatile'],
    note: 'Volatile-setting affinity, not a comparison of water quantity or extractable reserves.',
  },
  {
    id: 'processes',
    label: 'Dust, wind, erosion & atmospheric / surface processes',
    dimensionIds: [],
    unratedReason: 'No comparable dust, wind or erosion measurements are held for both the planet and Earth candidate.',
  },
  {
    id: 'biology',
    label: 'Biology, extremophiles, habitability & biosignatures',
    dimensionIds: [],
    unratedReason: 'RADIUM does not hold comparable biological or biosignature measurements for planetary sites.',
  },
  {
    id: 'subsurface',
    label: 'Caves, lava tubes, underground environments & subsurface',
    dimensionIds: [],
    unratedReason: 'Subsurface and cave datasets are not mapped consistently at these sites, so no grade is issued.',
  },
  {
    id: 'operations',
    label: 'Landing, mobility, navigation, robotics, human exploration & construction',
    dimensionIds: ['slope', 'roughness'],
    partial: true,
    note: 'Terrain-only match. Gravity, pressure, radiation, dust, infrastructure and vehicle limits are excluded.',
  },
];

/** Builds the eight factor rows for an Earth-vs-planet comparison. */
/**
 * Extracts the strongest less-studied candidates from a statistical ranking.
 * "New" here means not already established in the curated analog literature; it
 * does not mean a newly discovered coordinate or a verified field site.
 */
export function discoverNewAnalogs(rankings, earthCandidates, limit = 3) {
  const pool = new Map((earthCandidates || []).map((candidate) => [candidate.id, candidate]));
  return (rankings || [])
    .filter((ranking) => ranking.score !== null)
    .map((ranking) => ({ ...ranking, earth: pool.get(ranking.earthId) }))
    .filter((ranking) => ranking.earth && !ranking.earth.established)
    .slice(0, limit)
    .map((ranking) => ({
      ...ranking,
      strongest: ranking.strong[0] || null,
      weakest: ranking.weak[0] || null,
      why: ranking.strong[0]
        ? `Strongest measured overlap: ${ranking.strong[0].label.toLowerCase()} (${Math.round(ranking.strong[0].similarity * 100)}%).`
        : 'No dimension clears the strong-match threshold; the rank comes from broad, moderate overlap.',
    }));
}

export function earthFactorGrades(compare) {
  return EARTH_FACTOR_GROUPS.map((group) => {
    const dims = group.dimensionIds
      .map((id) => compare.dimensions.find((d) => d.id === id))
      .filter((d) => d?.available);
    if (!dims.length) {
      return {
        ...group,
        available: false,
        grade: null,
        similarity: null,
        coverage: 0,
        status: 'unassessed',
      };
    }
    const weight = dims.reduce((sum, d) => sum + d.effectiveWeight, 0);
    const similarity = weight > 0 ? dims.reduce((sum, d) => sum + d.similarity * d.effectiveWeight, 0) / weight : null;
    return {
      ...group,
      available: similarity !== null,
      grade: similarity === null ? null : letterGrade(similarity * 100),
      similarity: similarity === null ? null : round(similarity, 3),
      coverage: round(weight, 2),
      status: group.partial ? 'partial' : 'assessed',
      dimensions: dims.map((d) => d.id),
    };
  });
}
