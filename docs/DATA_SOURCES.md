# RADIUM data sources and provenance

Accessed 14 November 2026. This document is the human-readable companion to `js/data/datasets.js`, which is the runtime registry used to render source cards.

---

## 1. Bundled data (reproducible)

### 1.1 Lunar DEM — `moon_lola_4ppd`

- **Product**: LRO LOLA global shape model, 4 pixels/degree (`ldem_4.img`)
- **Agency/mission**: NASA GSFC / Lunar Reconnaissance Orbiter, Lunar Orbiter Laser Altimeter
- **Source**: `https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/img/ldem_4.img` (PDS Geosciences Node)
- **Format**: PDS IMG, 16-bit little-endian, simple cylindrical, 1440 × 720
- **Coverage**: global, 90°N–90°S
- **Resolution**: 0.25° (7,580.84 m/pixel)
- **Vertical**: height = DN × 0.5 m relative to a 1,737.4 km reference sphere
- **Processing**: downloaded by `tools/prepare-data.mjs`, decoded little-endian, stored unchanged as int16 in `data/moon_lola_4ppd.bin`; source SHA-256 and derived percentiles recorded in `data/dem-meta.json`
- **Limitations**: interpolated where altimetry tracks are sparse; cannot resolve slopes or hazards below ~7.6 km; derived slope/roughness are regional
- **Licence**: NASA public domain; attribution to LOLA/LRO
- **Rights note**: no redistribution restrictions identified for NASA PDS data; attribution retained

Observed range in the bundled grid: **−8,879 m to +10,504 m**; 2nd/98th percentiles −4,836 / +4,917 m.

### 1.2 Mars DEM — `mars_mola_4ppd`

- **Product**: MGS MOLA global topography, 4 pixels/degree (`megt90n000cb.img`, MEGDR)
- **Agency/mission**: NASA GSFC / Mars Global Surveyor, Mars Orbiter Laser Altimeter
- **Source**: `https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/meg004/megt90n000cb.img`
- **Format**: PDS IMG, 16-bit **big-endian**, simple cylindrical, 1440 × 720
- **Coverage**: global; density lowest near the equator (about 55% of 0.25° bins contain a shot)
- **Resolution**: 0.25° (14.8 km/pixel at the equator)
- **Vertical**: metres relative to the IAU 2000 areoid (GMM3, degree/order 50)
- **Processing**: downloaded, decoded big-endian, converted to little-endian int16 in `data/mars_mola_4ppd.bin`; no values altered; checksums and percentiles in `data/dem-meta.json`
- **Limitations**: coarse cells can mix crater floor and rim; interpolated gap values; not an EDL hazard product
- **Licence**: NASA public domain; attribution to MOLA/MGS

Observed range: **−8,068 m to +21,134 m**; 2nd/98th percentiles −5,101 / +4,708 m.

### 1.3 Provenance fields

`data/dem-meta.json` records, per body: dataset id and label, grid size, radius, scale/offset, source URL, source SHA-256, binary SHA-256, min/mean/max, 2nd/98th percentiles, coverage, resolution, notes and preparation timestamp.

---

## 2. Live planetary imagery

| Dataset | Product | Access | Resolution | Limitations |
| --- | --- | --- | --- | --- |
| `lunar_wac` | LRO LROC WAC global morphology mosaic v2 (303 ppd) | WMTS: `https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/{z}/{y}/{x}.jpg` | ~100 m/px | Display-stretched photomosaic, not calibrated reflectance; no composition measurement |
| `mars_viking` | MGS Viking MDIM21 color mosaic | WMTS: `https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0/default/default028mm/{z}/{y}/{x}.jpg` | 232 m/px | 1970s mosaic; dust/haze affect colour; not current conditions |
| `trek` | NASA Solar System Treks portals | Public WMTS/WMS | Layer-dependent | Availability outside RADIUM control; failures shown on the map |

Both services returned `Access-Control-Allow-Origin: *` at build time and were verified with HTTP 200 tile requests. Tile levels 0–7 are used (`2×1` tiles at level 0, geographic tiling).

Context thumbnails are composed client-side from 2×2 or 3×3 tiles centred on the selected coordinates, with a crosshair. No stock photograph is ever shown as if it depicted the site.

---

## 3. Live Earth data

### 3.1 NASA POWER climatology (`nasa_power`) — primary

- **Provider**: NASA Langley Research Center, POWER project (MERRA-2 meteorology; POWER/CERES solar)
- **Endpoint**: `https://power.larc.nasa.gov/api/temporal/climatology/point`
- **Variables**: `T2M`, `T2M_MAX`, `T2M_MIN` (°C), `PRECTOTCORR` (mm/day), `ALLSKY_SFC_SW_DWN` (kWh/m²/day), `ALLSKY_SRF_ALB` (fraction)
- **Period**: 25-year monthly and annual climatology, January 2001 → December 2025 (as returned in the service header)
- **Resolution**: MERRA-2 meteorology ~0.5° × 0.625°; solar ~1°; interpolated to the requested point
- **Derived**: annual mean temperature (K), mean monthly diurnal range, annual precipitation, Hargreaves ET₀ estimate (RADIUM-derived, **not** a POWER product), aridity index (P/PET₀), solar fraction (annual mean surface shortwave ÷ 117.6 MJ/m²/day), annual surface albedo
- **Caching**: browser `localStorage`, 7-day TTL, versioned key (`v2`)
- **Limitations**: reanalysis-based climatology, not a station; 2 m air temperature is a thermal-environment proxy and not equivalent to planetary surface brightness temperature; coarse resolution and smoothed extremes; the Hargreaves ET₀ is an empirical estimate, not a measured flux
- **Licence**: NASA public domain; POWER attribution and terms of use apply

Verified with HTTP 200 requests for Atacama, Death Valley and Svalbard, each ~2 KB. The full 34-site candidate pool then loaded 34/34 climate records and 34/34 terrain grids with no data issues. `EVPTRNS` was rejected as an aridity input because it returns zero in desert cases; ET₀ is therefore computed and labelled as RADIUM-derived.

### 3.2 ERA5 daily normals (`era5`) — fallback

- **Provider**: ECMWF / Copernicus Climate Change Service, accessed via Open-Meteo
- **Endpoint**: `https://archive-api.open-meteo.com/v1/archive`
- **Variables**: `temperature_2m_mean`, `temperature_2m_max`, `temperature_2m_min`, `precipitation_sum`, `et0_fao_evapotranspiration`, `shortwave_radiation_sum`
- **Period**: 2023-01-01 → 2024-12-31 (two complete calendar years; configurable in `js/data/earth-climate.js`)
- **Resolution**: ERA5 ~0.25° (≈31 km); API interpolation to the requested point
- **Derived**: mean temperature (K), mean diurnal range, annual precipitation, annual FAO-56 ET₀, aridity index (P/PET₀), solar fraction
- **Caching**: same versioned `localStorage` cache as POWER
- **Limitations**: reanalysis, not a station; smoothed diurnal range; the public API enforces a minutely request budget, which produced HTTP 429 under a 34-site burst. RADIUM therefore uses POWER as primary and ERA5 only when POWER fails.
- **Licence**: Copernicus data licence; Open-Meteo attribution and terms apply; verify terms for commercial use

A request for `soil_temperature_0cm` returned null values, so RADIUM does **not** use it; air temperature is used with an explicit proxy label.

### 3.3 Copernicus DEM (`copernicus_dem`)

- **Provider**: ESA / Copernicus DEM GLO-90, accessed via Open-Meteo elevation API
- **Endpoint**: `https://api.open-meteo.com/v1/elevation` (batch up to 100 points)
- **Use**: 3×3 adaptive sampling at ≈10 km spacing around an Earth point; Horn slope; elevation σ as roughness
- **Limitations**: 90 m native data are not used for hazard analysis; RADIUM samples a coarse grid deliberately, to compare with regional planetary terrain metrics
- **Licence**: Copernicus DEM licence; Open-Meteo terms

### 3.4 Earth imagery overlays

| Dataset | Layer | Native resolution | Notes |
| --- | --- | --- | --- |
| `gibs_blue_marble` | `BlueMarble_ShadedRelief_Bathymetry` | 500 m composite | Static composite; relief shading is cartographic |
| `gibs_lst` | `MODIS_Terra_L3_Land_Surface_Temp_8Day_Day` | 1 km | Latest available 8-day composite; cloud-masked; display-only |
| `gibs_albedo` | `MODIS_Combined_L3_Black_Sky_Albedo_Daily` | 500 m native | 16-day BRDF retrieval; latest available; display-only |
| `gibs_aerosol` | `MERRA2_Total_Aerosol_Optical_Thickness_550nm_Extinction_Monthly` | ~0.5° | Monthly reanalysis, not a daily retrieval; display-only |
| `gibs_topography` | `ASTER_GDEM_Color_Shaded_Relief` | 30 m | Static shaded relief, ~83°N–83°S; not a numeric cursor value |
| `esri_labels` | `World_Boundaries_and_Places` | multi-scale | Cartographic reference only; Esri terms/attribution |

Verified endpoints returned HTTP 200 tiles (Blue Marble, ASTER topography, MODIS albedo, LST at z2 and z5, MERRA-2 monthly AOD at z2/z4). The previous daily MODIS AOD layer was replaced because its swath gaps made it a poor global context layer; the current monthly reanalysis is labelled accordingly. The working GIBS legend `MERRA2_Total_Aerosol_Optical_Thickness_550nm_Extinction_Monthly_H.svg` is used. Snow-cover and NDVI layer IDs returned HTTP 400 at test time and were therefore **not** shipped.

Colour legends are loaded from the official GIBS legend SVGs where available, with a fallback ramp. RADIUM does not extract numbers from tile colours.

---

## 4. Planetary measurement sources (curated, cited)

RADIUM v1 does not bundle per-pixel planetary temperature or ice rasters. Site values are regional estimates or published results, labelled with an evidence class, uncertainty and note. Source records are shown in every site panel.

| Dataset | Used for | Resolution / nature | Key limitation |
| --- | --- | --- | --- |
| `diviner` (LRO) | Regional mean temperature and diurnal amplitude | Global climatology ~0.5–1°; polar products finer | Values in RADIUM are regional estimates, not point granules; terrain shadowing unresolved |
| `lamp_minirf` (LRO) | Polar frost/radar ice evidence | ~0.5–2 km / ~15 m targeted | Radar CPR can indicate roughness as well as ice; debates remain |
| `lcross` | Cabeus water-ice detection | Single impact experiment | One PSR; not a resource estimate |
| `mro_crism` | Substrate/mineral class | 18 m targeted, ~200 m global summaries | Sparse targeted coverage; dust obscures surfaces |
| `mro_hirise_ctx` | Site geology/hazard context | 0.25–6 m | Not ingested numerically; no landing certification |
| `odyssey_neutron` | Regional ground-ice evidence | ~300–600 km footprint | Detects hydrogen, not ice; cannot support point-scale reserves |
| `sharad` | Buried ice/layered deposits | ~10–20 m vertical, km along-track | Sparse, interpretation ambiguity |
| `mars_tes` | Thermal inertia and regional dust climatology | ~3 km footprint / binned maps | Dust opacity not measured at every site; RADIUM dust classes are assessments |

These are cited as evidence, not converted into false precision. The ice index is an evidence-strength index (0–100), not a water abundance.

---

## 5. Candidate pool and site coordinates

- Lunar sites: 16, including Apollo 11 and 17 ground truth, Tycho, Marius Hills and Tranquillitatis pits, Ina, Aristarchus, Compton–Belkovich, Reiner Gamma, and seven south-polar Artemis-relevant regions/features.
- Mars sites: 15, including Jezero, Gale, Oxia Planum, Mawrth Vallis, Nili Fossae, Eberswalde, Melas Chasma, Arcadia, Utopia, Deuteronilus, Korolev, Phoenix, InSight/Elysium, Olympus Mons and Valles Marineris.
- Earth candidates: 34, mixing established analogs (Atacama, Dry Valleys, Haughton, Rio Tinto, Iceland, Hawaii, Svalbard) with less-studied candidates (Waw an Namus, Emi Koussi, Harrat Khaybar, Salar de Arizaro, Qaidam, Mistastin).

**Coordinate caveat.** Polar coordinates are representative points for named regions/features. They are not official NASA Artemis landing-zone polygons or certified centroids; several records say so explicitly. Regional temperature/illumination values must not be read as point measurements.

Earth climate and terrain are deliberately absent from the curated records and fetched live, so their provenance is always the live service, never a stale hardcoded number.

---

## 6. Licensing summary

| Source | Licence / terms |
| --- | --- |
| NASA PDS (LOLA, MOLA, Diviner, LAMP, Mini-RF, LCROSS, CRISM, SHARAD, Odyssey, TES) | NASA public domain; attribution requested |
| NASA LROC WAC, Viking MDIM21, Blue Marble, MODIS LST/AOD | NASA public domain; attribution retained |
| NASA Solar System Treks | Public service; NASA-produced layers public domain |
| NASA POWER | NASA public domain; POWER attribution requested |
| ERA5 / Copernicus | Copernicus licence; Open-Meteo terms; attribution required |
| Copernicus DEM GLO-90 | Copernicus DEM licence; Open-Meteo attribution |
| Esri World Imagery / labels | Esri terms; on-map attribution required |
| CesiumJS | Apache-2.0 |
| MapLibre GL JS | BSD-3-Clause |

RADIUM is an independent Space Apps project, not an official NASA product.

---

## 7. Verification performed during build

- PDS DEM URLs returned HTTP 200; files were 2,073,600 bytes each and matched the expected 1440×720 int16 layout.
- Moon DEM decoded little-endian; Apollo 11 sample ≈ −1,883 m (plausible for Mare Tranquillitatis).
- Mars DEM decoded big-endian; Jezero ≈ −2,651 m, Hellas ≈ −6,151 m, Olympus ≈ +18,609 m in the coarse cell, north polar cap ≈ −2,256 m. A little-endian decode produced nonsense, confirming byte order.
- NASA Trek Moon and Mars WMTS level-0 tiles returned 200 `image/jpeg` with `Access-Control-Allow-Origin: *`.
- NASA GIBS Blue Marble, MODIS LST (8-day day) and MODIS AOD tiles returned 200; snow-cover/NDVI IDs returned 400 and were excluded.
- NASA POWER climatology API returned 200 for Atacama, Death Valley and Svalbard; a full pool build produced 34/34 climate and 34/34 terrain records with no issues.
- Open-Meteo archive and elevation APIs returned 200 with CORS enabled; the archive endpoint returned HTTP 429 ("Minutely API request limit exceeded") under a 34-site burst, which is why POWER is primary and Open-Meteo is the fallback. Unsupported soil-temperature variables were identified and not used.
- `npm test`: 24 tests passing (see `docs/METHODOLOGY.md`).
- The app was booted against a local server to verify that the shell, mission controls and inspector render with live DEM data; WebGL/Cesium availability depends on the browser and is reported in-app if unavailable.

No validation result here is inferred from a screenshot or assumed; failed or unavailable checks are described as such.

---

## 8. Reproducing and extending

```bash
npm run data     # re-download DEMs, rebuild binaries and metadata
npm test         # verify engines and catalogs
npm start        # serve the app
```

To add a dataset: register it in `js/data/datasets.js` (with resolution, coverage, licence and limitations), cite its id from site records, and implement point ingestion in `js/data/` or `js/science/`. Do not add a heatmap unless a gridded product supports it; do not add a measurement without an evidence class.
