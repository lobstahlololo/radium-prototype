# RADIUM methodology

Version 1.0 · 14 November 2026

This document defines every transform, weight, threshold and missing-data rule used by RADIUM. If the interface and this document disagree, that is a defect.

---

## 1. Two questions, two algorithms

| Question | Engine | Output | Not to be confused with |
| --- | --- | --- | --- |
| How suitable is this site for mission X? | Weighted multicriteria suitability | A–F mission grade, coverage, confidence, factors | Earth analog similarity |
| Which Earth environment resembles this planetary place? | Dimension-wise similarity | A–F analog grade, dimension grades, mismatches | Mission suitability |

No combined “overall” score exists. A site can be an excellent scientific analog and a terrible base, and the interface keeps those statements separate.

---

## 2. Evidence classes

Every value carries one class:

| Class | Meaning |
| --- | --- |
| `observed` | Direct measurement or mission result at/inside the site region (e.g. LCROSS ejecta, Phoenix ice table). |
| `derived` | Computed from a measured grid by a documented method (slope, roughness, aridity, solar fraction). |
| `published-model` | Value from a published illumination/thermal model; representative of the site area, not a point measurement. |
| `modeled` | RADIUM-side or regional climatology estimate with stated assumptions and uncertainty. |
| `inferred` | Indirect evidence (e.g. radar/neutron signatures interpreted as ice). |
| `assessment` | Editorial scientific judgement (exploration value, dust class). Not a measurement. |

Site panels display the class as a badge next to the value; uncertainty and a note are shown where present. Coarse regional products are never described as point observations.

---

## 3. Site suitability

### 3.1 Model

For mission profile \(p\), factor \(i\):

\[
S = \frac{\sum_i w_i s_i}{\sum_i w_i}
\]

where:

- \(s_i \in [0,100]\) is the normalised factor sub-score.
- \(w_i = b_i \cdot m_i\), with profile base weight \(b_i\) and user priority multiplier \(m_i \in [0,2]\).
- The denominator runs over **available** factors only. Unavailable factors are removed and the remaining weights renormalised (effective weight \(w_i / \sum_{available} w_i\)).

### 3.2 Factor normalisation anchors

Anchors are piecewise-linear; values outside the range clamp. These are RADIUM-defined, not NASA standards.

| Factor | Units | Anchors | Evidence | Preference |
| --- | --- | --- | --- | --- |
| Ice/volatile evidence | index 0–100 | directly from curated evidence index | observed / inferred | higher |
| Solar energy | fraction of solar constant | 0→0, 0.05→12, 0.15→35, 0.25→60, 0.35→80, 0.5→95, 0.7→100 | modeled | higher |
| Slope | ° | 0→100, 2→95, 5→80, 8→60, 12→35, 20→10, 30→0 | derived | lower |
| Roughness | m σ | 0→100, 3→90, 8→75, 20→55, 50→30, 100→12, 200→0 | derived | lower |
| Mean temperature | K | 120→12, 160→38, 200→68, 230→88, 250→96, 270→100, 300→90, 340→60, 400→25 | modeled | peak at 250–270 K |
| Earth visibility (Moon) | fraction | value × 100 | modeled | higher |
| Dust exposure (Mars) | class | low 85, moderate 55, high 25 | assessment | lower |
| Landing altitude (Mars) | m | −8000→100, −4000→92, −2000→78, 0→58, 4000→28, 8000→10, 12000→0 | derived | lower |
| Geological relevance | index | direct | assessment | higher |
| Exploration value | index | direct | assessment | higher |

The Mars pressure shown in panels is a barometric approximation, not a factor input:
\(p = 0.699\,\exp(-z/11100)\) kPa (scale height 11.1 km).

### 3.3 Mission profiles and default weights

Weights sum to 1 in every profile. The interface renormalises after user multipliers.

**Lunar Permanent Base**

| Factor | Weight |
| --- | --- |
| Water & ice resources | 24% |
| Solar energy | 16% |
| Terrain safety — slope | 14% |
| Earth communication | 11% |
| Thermal conditions | 10% |
| Terrain roughness | 9% |
| Geological relevance | 8% |
| Exploration value | 8% |

Hard screen: slope > 25° → grade capped at F.

**Mars Robotic Landing**

| Factor | Weight |
| --- | --- |
| Terrain safety — slope | 22% |
| Exploration value | 18% |
| Terrain roughness | 16% |
| Water & ice resources | 12% |
| Landing altitude | 12% |
| Solar energy | 10% |
| Dust exposure | 10% |

Hard screen: slope > 15° → F.

**Mars Human Exploration**

| Factor | Weight |
| --- | --- |
| Water & ice resources | 22% |
| Solar energy | 12% |
| Terrain safety — slope | 12% |
| Exploration value | 12% |
| Thermal conditions | 10% |
| Dust exposure | 10% |
| Terrain roughness | 8% |
| Landing altitude | 8% |
| Geological relevance | 6% |

Hard screen: slope > 20° → F.

Hard screens are exploratory operational screens. Real EDL and construction limits are vehicle-specific and require much finer data.

### 3.4 Missing data

1. A factor is unavailable if the required site value or DEM sample is absent.
2. Its weight is removed; remaining weights renormalise.
3. `coverage = Σ available base weights / Σ all base weights`.
4. If coverage < 0.5, **no letter grade is issued** (shown as “—”).
5. The inspector lists every unavailable factor and why.

The interface never substitutes a default temperature, ice score or slope.

### 3.5 Confidence and grades

`confidence = coverage × mean evidence quality`, with evidence quality:

| Class | Quality |
| --- | --- |
| observed | 1.00 |
| derived | 0.92 |
| published-model | 0.80 |
| modeled | 0.68 |
| inferred | 0.50 |
| assessment | 0.55 |

Confidence labels: High ≥ 0.75, Medium ≥ 0.50, Low < 0.50.

Grade bands:

| Grade | Score | Meaning |
| --- | --- | --- |
| A | 80–100 | Excellent suitability |
| B | 65–79.9 | Good suitability |
| C | 50–64.9 | Moderate suitability |
| D | 35–49.9 | Poor suitability |
| F | 0–34.9 (or hard-screen failure) | Very poor suitability |

Grades are RADIUM-defined and are **not** an official NASA certification.

### 3.6 Priority sliders

Each factor present in the profile has a multiplier 0–2 (default 1). Changing a multiplier:

- recomputes weights and normalised shares,
- recomputes all site scores and letter grades,
- refreshes map badges and the ranking,
- reports the previous and new share and any change in the top-ranked site.

The explanation is computed from the actual before/after rankings; no UI copy is hardcoded to a particular site.

---

## 4. Earth Twin Mode

### 4.1 Earth measurements

For each candidate and for arbitrary clicked points:

- **Climate**: NASA POWER 25-year monthly climatology (January 2001 – December 2025) as primary: 2 m mean/max/min temperature, precipitation and all-sky shortwave radiation. ERA5 daily values for 2023–2024 are a fallback only if POWER is unavailable.
  - `tempMeanK = T2M annual mean + 273.15`
  - `diurnalAmpK = mean over months of (T2M_MAX − T2M_MIN)`
  - `et0Mm = Hargreaves estimate from monthly temperature range and TOA radiation (RADIUM-derived)`
  - `aridityIndex = annual precipitation / annual ET₀`
  - `solarFraction = annual mean shortwave MJ/m²/day / 117.6`
  - The ERA5 fallback uses daily means with FAO-56 ET₀ instead; the source and ET₀ method are shown with each profile.
- **Terrain**: Copernicus DEM GLO-90 sampled on an adaptive 3×3 grid at ≈10 km spacing around the point; Horn slope; elevation standard deviation as roughness.
- Climate is reanalysis and air temperature is a thermal-environment proxy, not a skin temperature. It is flagged in the UI and in the caveats.

The solar fraction is the same physical quantity used for planets: annual mean surface insolation ÷ 24-hour solar constant. It is not the fraction of daylight hours.

### 4.2 Comparable dimensions

| Dimension | Weight | Comparison |
| --- | --- | --- |
| Mean surface temperature | 14% | linear, 120 K difference → 0 similarity |
| Diurnal thermal amplitude | 14% | linear, 200 K difference → 0 |
| Terrain slope | 16% | linear, 12° difference → 0 |
| Terrain roughness (~30 km) | 14% | log-ratio, saturating at 2.2 in log space |
| Surface material | 18% | fixed affinity matrix |
| Volatile setting | 12% | fixed affinity matrix |
| Relative solar resource | 12% | linear, 0.4 fraction difference → 0 |

Similarity \(d_i \in [0,1]\). Available weights renormalise:
\(A = \sum v_i d_i / \sum v_i\). Effective weight is displayed per dimension.

Missing dimensions are dropped, listed as such, and coverage decreases. Confidence = coverage × mean evidence quality (0.85 terrain, 0.7 categorical, 0.6 thermal, 0.75 solar).

### 4.3 Categorical affinities

Substrate groups: `basalt`, `highland`, `impact`, `sulfate`, `clay`, `salt`, `ice`, `permafrost`, `tephra`, `sand`, `silica`, `carbonate`, `granite`, `andesite`, `ultramafic`.

Volatile settings: `none`, `ephemeral_water`, `hydrated_minerals`, `salt_hydrate`, `ground_ice`, `surface_ice`.

The matrices are symmetric and shown in full in the app’s Methodology dialog. Undocumented pairs default to 0.15. Examples: basalt↔tephra 0.90, basalt↔sand 0.35, clay↔clay 1.00, clay↔salt 0.25, ground_ice↔surface_ice 0.85.

Categorical affinity is intentionally not a numerical distance: salt and basalt are not “numerically close”.

### 4.4 Excluded physics

The following are **never** part of the score and are displayed as mismatches:

- Surface gravity (Moon 1.62, Mars 3.71, Earth 9.81 m/s²).
- Atmospheric pressure and composition (vacuum / ~0.6 kPa CO₂ / ~101.3 kPa N₂–O₂).
- Radiation environment (no global lunar field; thin Martian atmosphere; Earth shielding).
- Dust-regime physics (electrostatic transport vs CO₂ dust storms vs terrestrial wind/moisture).

An Earth analog can therefore be excellent for rover mobility or ice-drilling tests while physically unable to reproduce the planetary environment.

### 4.5 Applications

Applications are generated from the matched substrate/volatile class and measured aridity/solar conditions, e.g.:

- basaltic dry terrain → rover mobility, wheel–regolith interaction, dust mitigation;
- sulfate/acidic → astrobiology instrument and sample-handling tests;
- clay → drilling, sample preservation, spectroscopy;
- ice/ground ice → cryogenic drilling and permafrost engineering;
- impact → cratering/ejecta studies;
- high solar fraction → solar array and thermal-control testing.

They are possibilities supported by the match, not claims that a site has been used for that purpose.

### 4.6 Less-studied candidates

The pool deliberately mixes established analog sites with less-studied candidates (e.g. Waw an Namus, Emi Koussi, Harrat Khaybar, Salar de Arizaro, Qaidam, Mistastin). A high grade for such a site is labelled “less-studied data-driven candidate”; the ranking is computed from measured characteristics, not from fame.

### 4.7 Reverse matching and Earth’s eight-factor profile

For an Earth candidate, RADIUM computes the same comparison against all 31 curated planetary sites (16 Moon, 15 Mars), ranks the results and reports the best match. That best match sets the **overall analog grade** and supplies the factor profile. “Mimics” therefore means “closest measured analog among the curated planetary sites”, not a claim of geological identity.

The eight requested categories are built from the comparable similarity dimensions:

| Earth factor | Underlying dimensions | Status |
| --- | --- | --- |
| Geology, mineralogy & surface materials | surface material affinity | assessed, categorical only |
| Terrain, elevation, slope, roughness & craters | slope + roughness | assessed; elevation offset and crater populations not scored |
| Temperature, illumination & environmental extremes | mean temperature + diurnal amplitude + solar fraction | assessed |
| Water, ice, permafrost & potential resources | volatile-setting affinity | assessed, not water quantity |
| Dust, wind, erosion & atmospheric / surface processes | none | **unassessed** |
| Biology, extremophiles, habitability & biosignatures | none | **unassessed** |
| Caves, lava tubes, underground environments & subsurface | none | **unassessed** |
| Landing, mobility, navigation, robotics, human exploration & construction | slope + roughness | **partial**, terrain only |

A group grade is the effective-weight-weighted mean of its available dimension similarities, converted with the same letter bands. Groups without comparable data are shown as “not assessed” and are not replaced with an estimate. The operations group is explicitly partial because gravity, pressure, radiation, dust and site infrastructure are excluded. The overall grade remains the full seven-dimension similarity score; no extra weighting is applied for the eight display groups.

The Moon/Mars analog interface reports only the **top five** Earth candidates. The Earth candidate list reports each site’s best planetary match and overall grade after the live pool has been measured.

---

## 5. Terrain computation

### 5.1 Planetary DEMs

| Body | Product | Grid | Datum | Notes |
| --- | --- | --- | --- | --- |
| Moon | LRO LOLA LDEM 4 ppd | 1440×720, 0.25° | 1737.4 km sphere; height = DN × 0.5 m | Interpolated where tracks are sparse |
| Mars | MGS MOLA MEGDR 4 ppd | 1440×720, 0.25° | IAU 2000 areoid; metres | ~55% of equatorial bins contain a shot; gaps interpolated |

Elevation at a coordinate is bilinear. Site metrics are computed on a **fixed 10 km physical sampling grid** (3×3 samples, ~20 km window), not on adjacent grid cells. This avoids the artificial slope inflation that longitude convergence produces near the poles, where 0.25° columns are only tens of metres apart, and it matches the Earth sampling scale. Slope is Horn’s derivative on that grid; roughness is the population standard deviation of the nine samples.

The global elevation/slope/roughness display layers are generated separately from native cells (Horn on 0.25° cells; σ over 3×3 native cells), and their legends say so. At 0.25°/px, all of these metrics describe regional terrain, **not** landing hazards, outcrops or rover-scale roughness.

### 5.2 Earth terrain

Adaptive 3×3 sampling at ≈10 km spacing, with longitude spacing corrected for latitude. The same Horn formulation is applied. Window ≈ 20 km; resolution ≈ 10 km. This is intentionally comparable to the planetary regional scale, and intentionally not a substitute for 90 m or 1 m analysis.

---

## 6. Solar geometry

Annual mean insolation on a flat, unobstructed surface, as a fraction of the solar constant, integrated every 3 days:

\[
f = \frac{1}{N}\sum_{\text{days}} \frac{\sin\phi\sin\delta\,H_0 + \cos\phi\cos\delta\sin H_0}{\pi}
\]

with obliquity 1.543° (Moon), 25.19° (Mars), 23.44° (Earth). Mars is multiplied by a typical dust transmission of 0.75 (documented assumption).

Consequences:

- Equatorial airless surface ≈ 0.32 of the solar constant, not 1.0.
- Mars equatorial ≈ 0.24 after dust.
- A polar ridge that is sunlit 83% of the year still receives very little **energy** because the Sun is near the horizon.

RADIUM therefore reports the published polar **illumination-time** fraction separately and never substitutes it into the solar energy score. This distinction is explicit in the inspector.

---

## 7. Validation

Automated tests (`npm test`, 24 tests):

- Grade bands, boundaries, null handling.
- Profile weights sum to 1.
- Missing-data renormalisation and coverage < 0.5 → unrated.
- Hard constraint → grade F with explanation.
- Priority multipliers change effective weights; shares remain normalised.
- Similarity bounds, symmetry, identical-value identity, missing-dimension renormalisation, incomparable list.
- Inverse Earth-to-planet ranking and planetary identity preservation.
- Eight-factor grouping, including explicitly unassessed and partial factors.
- Affinity matrices symmetric and within [0,1].
- DEM bilinear sampling, Horn slope against an analytic gradient, roughness on flat/sloped synthetic grids.
- NASA POWER summariser on synthetic monthly normals (annual mean, monthly-mean diurnal range, precipitation, solar, Hargreaves ET₀, missing `-999` handling).
- ERA5 fallback summariser arithmetic on a synthetic daily series (no invented values).
- Earth terrain summariser on synthetic 3×3 samples.
- Catalog integrity: unique ids, coordinates in range, valid substrate/volatile classes, provenance references exist, polar overrides only at polar sites, Earth climate/terrain absent from the curated records (so they must be fetched).

Known validation gaps, stated honestly:

- No comparison against independent station data or published site grades; the scoring model is a transparent multicriteria construct, not a calibrated predictive model.
- Planetary temperature/illumination values are regional literature estimates. They were not re-derived from Diviner granules in this build.
- No metre-scale DEM comparison, so landing-hazard claims are deliberately absent.
- Live services were exercised manually; unit tests do not mock or test Cesium/MapLibre rendering.

---

## 8. Limitations

1. **Scale.** 0.25°/px planetary DEMs and ~10 km Earth sampling cannot resolve landing hazards, boulders, crevasses or metre-scale ice.
2. **Regional values as site values.** Polar temperature and ice indices describe regions, not the exact pin.
3. **Curated pool.** Earth analogs come from a curated 34-site pool, not a global search. Clicking arbitrary Earth points produces live measurements and (when a planetary site is selected) a similarity grade, but material classes are only assigned for curated sites.
4. **Reanalysis.** Earth climate is NASA POWER reanalysis-based climatology (ERA5 fallback), not station data; 2 m air temperature is a proxy for surface thermal environment, and ET₀ is an empirical Hargreaves estimate.
5. **Solar.** Terrain shadowing and low-Sun geometry are not fully modelled; published polar illumination values are time fractions, not energy.
6. **Dust.** Mars dust classes are coarse regional assessments, not per-site opacity records.
7. **No physics simulation.** Gravity, pressure, radiation and dust regimes are flagged, not modelled.
8. **Service dependence.** Imagery and Earth measurements require network access; failures are shown rather than hidden.

---

## 9. Next scientific steps

- Ingest Diviner polar temperature and rock-abundance products at native resolution, replacing regional estimates.
- Serve LOLA/MOLA at higher zoom from COGs and compute slope at multiple baselines (1 km, 10 km, 100 km).
- Add CRISM global hydrated-mineral summary products as a gridded substrate layer instead of site classes.
- Replace the curated analog pool with a global candidate grid + clustering + similarity ranking, with the same provenance rules.
- Add a radiation/thermal environment model (clearly separated from landscape similarity).
- Add PostGIS-backed provenance and dataset versioning for team deployments.
