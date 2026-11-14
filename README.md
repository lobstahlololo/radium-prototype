# RADIUM

**Planetary exploration and terrestrial analog discovery** — a NASA Space Apps Challenge project.

RADIUM lets you explore the Moon and Mars on interactive 3D globes, evaluate real sites against configurable mission priorities, get explainable letter grades, and activate **Earth Twin Mode** to find terrestrial environments that share measurable characteristics with a planetary site.

It is built as a working scientific application, not a mockup. Elevation, slope and roughness are computed live from bundled NASA DEMs; Earth climate comes from live NASA POWER climatology (ERA5 fallback); imagery is streamed from NASA's Solar System Treks and NASA GIBS. Where data does not exist, RADIUM says so, reduces coverage/confidence, and refuses to invent a value.

![No screenshot is bundled; run the app locally to explore it.]

---

## Quick start

```bash
npm start          # zero-dependency static server on http://localhost:8080
# or
node server.mjs 8080
```

No install or build step is required. An internet connection is needed for NASA imagery tiles and Earth measurements (NASA POWER, with ERA5/Open-Meteo fallback). CesiumJS, MapLibre GL and fonts are loaded from public CDNs.

```bash
npm test           # 22 unit tests (grading, scoring, similarity, terrain, catalogs)
npm run data       # re-download and rebuild the bundled DEMs from NASA PDS
```

Requires Node 20+ (developed on Node 24). The app itself is plain ES modules.

---

## What is implemented

| Area | Status |
| --- | --- |
| 3D Moon globe with LRO LROC WAC imagery | Working (CesiumJS) |
| 3D Mars globe with Viking MDIM21 imagery | Working (CesiumJS) |
| 2D Earth map with NASA GIBS Blue Marble, MODIS LST and MODIS AOD overlays | Working (MapLibre) |
| Real LOLA/MOLA DEM point sampling (0.25°/px, fixed 10 km terrain baseline) | Working — elevation, slope, roughness |
| DEM-derived global elevation/slope/roughness layers with legends | Working |
| 16 curated lunar sites, 15 Mars sites | Working |
| Mission profiles: lunar base, Mars robotic landing, Mars human exploration | Working |
| Adjustable priorities with live re-ranking and explanation | Working |
| Explainable A–F suitability grades with coverage/confidence and constraints | Working |
| Earth Twin Mode: 34 terrestrial candidates, live NASA POWER/DEM measurements, dimension grades | Working |
| Side-by-side comparison, strong/weak matches, applications, physical mismatches | Working |
| Dataset registry with provenance, resolution, licensing and limitations | Working |
| Context imagery at the selected coordinate | Working (NASA tiles drawn client-side) |

### Explicitly not implemented

- Global per-pixel planetary temperature or ice rasters (RADIUM uses labelled regional values/published models instead).
- Certified landing-hazard analysis at metre scale. The 0.25° DEM cannot resolve it, and the UI says so.
- Gravity, atmosphere, radiation or magnetic-field simulation. These are listed as **not comparable**, never scored.
- Autonomous global discovery of arbitrary new analog sites. The candidate pool is curated and extensible; arbitrary Earth points can still be measured and compared.
- A multi-user database backend. The data layer is static + live public APIs.

---

## Scientific design in one page

RADIUM keeps two questions strictly apart:

1. **Site suitability** — weighted multicriteria model over mission-specific factors:
   `S = Σ(wᵢ·sᵢ) / Σwᵢ`, with weights normalised over available factors. Hard screens can cap a grade at F. Coverage and confidence are reported; a grade is withheld below 50% data coverage.
2. **Earth analog similarity** — separate dimension-by-dimension comparison:
   `A = Σ(vᵢ·dᵢ) / Σvᵢ`, using documented scales for thermal, terrain and solar dimensions and fixed affinity matrices for material/volatile classes. Gravity, pressure, radiation and dust physics are excluded and displayed as mismatches.

Grades: A ≥ 80, B ≥ 65, C ≥ 50, D ≥ 35, F < 35. These are RADIUM-defined exploratory assessments, **not NASA certification**.

Every measurement is tagged as **observed**, **derived**, **published model**, **modelled estimate**, **inferred** or **assessment**, with a note and uncertainty where applicable.

Full derivations, anchors, weights and validation: [`docs/METHODOLOGY.md`](docs/METHODOLOGY.md). Provenance and licensing: [`docs/DATA_SOURCES.md`](docs/DATA_SOURCES.md).

---

## Architecture

```
index.html                 App shell, CDN libraries
css/radium.css             Design system and responsive layout
server.mjs                 Zero-dependency static server

js/app.js                  Controller: state, selection, twin mode, rendering
js/ui/modals.js            Methodology, sources and scope dialogs

js/data/
  constants.js             Body radii, gravity, datums, caveat
  datasets.js              Dataset registry (provenance, licensing, limits)
  moon-sites.js            16 curated lunar sites with evidence classes
  mars-sites.js            15 curated Mars sites with evidence classes
  analogs.js               34 terrestrial candidate sites (no hardcoded climate)
  earth-climate.js         Live NASA POWER/ERA5 + Copernicus DEM sampling and indices

js/science/
  grade.js                 A–F bands, piecewise interpolation, formatting
  suitability.js           Mission profiles, priorities, missing-data policy
  similarity.js            Earth Twin dimensions, affinities, coverage, confidence
  solar.js                 Solar geometry, Mars pressure approximation
  terrain.js               DEM bilinear sampling, Horn slope, roughness

js/maps/
  globe.js                 Cesium Moon/Mars globes and grade markers
  earth.js                 MapLibre Earth map and GIBS overlays
  dem-layer.js             DEM-derived rasters + legends
  thumb.js                 Real context-imagery thumbnails at coordinates

data/
  moon_lola_4ppd.bin       1440×720 int16, little-endian (LOLA LDEM 4 ppd)
  mars_mola_4ppd.bin       1440×720 int16, little-endian (MOLA MEGDR 4 ppd)
  dem-meta.json            Grid metadata, source checksums, percentiles

tools/prepare-data.mjs     Reproducible PDS ingestion
tests/                     22 unit + catalog-integrity tests
docs/                      Methodology and data-source documentation
```

---

## Data at a glance

| Use | Product | Access |
| --- | --- | --- |
| Lunar elevation/slope/roughness | LRO LOLA LDEM 4 ppd (PDS) | Bundled binary (2 MB), reproducible |
| Mars elevation/slope/roughness | MGS MOLA MEGDR 4 ppd (PDS) | Bundled binary (2 MB), reproducible |
| Moon imagery | LRO LROC WAC 303 ppd mosaic | Live WMTS, NASA Solar System Treks |
| Mars imagery | MGS Viking MDIM21 color mosaic 232 m | Live WMTS, NASA Solar System Treks |
| Earth basemap | NASA Blue Marble / shaded relief | Live WMTS, NASA GIBS |
| Earth temperature overlay | MODIS Terra LST 8-day day | Live WMTS, NASA GIBS |
| Earth aerosol overlay | MODIS Terra AOD 3 km | Live WMTS, NASA GIBS |
| Earth climate | NASA POWER 25-year climatology (2001–2025) | Live POWER API; ERA5 fallback |
| Earth terrain | Copernicus DEM GLO-90 | Live Open-Meteo elevation API |
| Planetary temperature/illumination/ice | Diviner, LAMP/Mini-RF, LCROSS, CRISM, Odyssey, SHARAD, TES | Cited regional values, never fabricated point data |

Live services can be unavailable. RADIUM degrades explicitly: imagery errors appear on the map, Earth climate failures produce "Data unavailable" and drop similarity dimensions, and the app never substitutes placeholder science.

---

## Reproducing the DEMs

```bash
npm run data            # downloads from PDS, converts endianness, writes checksums
```

- Moon: `ldem_4.img` (`LSB_INTEGER`, height = DN × 0.5 m, reference radius 1,737.4 km).
- Mars: `megt90n000cb.img` (`MSB_INTEGER`, metres relative to the IAU 2000 areoid, converted to little-endian).
- Result: `data/*.bin` + `data/dem-meta.json` (min/max/mean, 2nd/98th percentiles, SHA-256, source URL, preparation timestamp).

No values are altered other than byte order. Percentiles are used only for colour-ramp scaling.

---

## Tests and verification

`npm test` covers:

- Grade-band boundaries and A–F monotonicity.
- Mission weights sum to 1; missing data is dropped and renormalised; coverage threshold withholds a grade.
- Hard constraints cap the grade at F.
- Priority multipliers change effective weights while staying normalised.
- Similarity bounded 0–1, symmetry of affinity matrices, identical values → 1.0, missing dimensions renormalised, incomparable physics listed.
- DEM bilinear sampling, Horn slope on synthetic grids, roughness behaviour.
- NASA POWER and ERA5 summariser arithmetic, aridity and comparable solar fraction.
- Catalog integrity: unique ids, valid coordinates/groups, provenance references, polar illumination overrides, no hardcoded Earth climate.

Run `node server.mjs` and open the app to exercise live layers. Verification notes for this build are in [`docs/METHODOLOGY.md`](docs/METHODOLOGY.md#validation).

---

## Attribution

- NASA / LRO LOLA, LROC, Diviner; NASA / MGS MOLA, TES; NASA / MRO CRISM, SHARAD, HiRISE/CTX; NASA LCROSS; NASA Odyssey; NASA GSFC and USGS Astrogeology. NASA public-domain data; mission attribution retained.
- NASA Solar System Treks for planetary WMTS tiles.
- NASA GIBS / EOSDIS for Earth imagery and environmental layers.
- NASA POWER (NASA Langley Research Center; MERRA-2/POWER) for Earth climatology.
- ERA5 / Copernicus Climate Change Service (fallback) and Copernicus DEM, accessed through Open-Meteo (subject to their terms).
- Esri World Imagery / reference labels where selected (attribution on map).
- CesiumJS and MapLibre GL JS (Apache-2.0 / BSD).

RADIUM is an independent Space Apps project and is not an official NASA product. Site grades are exploratory scientific assessments, not mission approval.
