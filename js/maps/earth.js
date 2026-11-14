/**
 * 2D Earth map on MapLibre GL with live NASA GIBS raster layers.
 * Basemap and overlays are real NASA products; place labels are Esri reference
 * tiles. Overlay colours are shown as delivered by GIBS (no numeric extraction
 * from pixels is performed).
 */

const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';
const ESRI = 'https://services.arcgisonline.com/ArcGIS/rest/services';

const SOURCES = {
  'blue-marble': `${GIBS}/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg`,
  satellite: `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`,
  topography: `${GIBS}/ASTER_GDEM_Color_Shaded_Relief/default/GoogleMapsCompatible_Level12/{z}/{y}/{x}.jpeg`,
  lst: `${GIBS}/MODIS_Terra_L3_Land_Surface_Temp_8Day_Day/default/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png`,
  albedo: `${GIBS}/MODIS_Combined_L3_Black_Sky_Albedo_Daily/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png`,
  aod: `${GIBS}/MERRA2_Total_Aerosol_Optical_Thickness_550nm_Extinction_Monthly/default/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png`,
  labels: `${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`,
};

export const EARTH_LAYERS = {
  lst: {
    id: 'lst',
    label: 'Land surface temperature',
    title: 'MODIS land surface temperature (8-day day composite)',
    unit: '°C',
    datasetId: 'gibs_lst',
    note: 'Cloud-masked 8-day composite served by NASA GIBS; the latest available composite is displayed, not a single date. Display-only: no numeric extraction from tile colours.',
    legendUrl: 'https://gibs.earthdata.nasa.gov/legends/MODIS_Terra_L3_Land_Surface_Temp_8Day_Day_H.svg',
    fallbackTicks: ['−20 °C', '0 °C', '20 °C', '40 °C'],
    fallbackGradient: 'linear-gradient(90deg,#3b0f70,#2c7fb8,#41ab5d,#feb24c,#e31a1c)',
  },
  albedo: {
    id: 'albedo',
    label: 'Surface albedo (brightness)',
    title: 'MODIS black-sky albedo (daily, 16-day retrieval)',
    unit: 'fraction',
    datasetId: 'gibs_albedo',
    note: 'Directional reflectance at local solar noon from the latest available MODIS 16-day BRDF retrieval. Brighter colours mean more reflected shortwave radiation. Display-only; no numeric extraction from tile colours.',
    legendUrl: null,
    fallbackTicks: ['0.0', '0.2', '0.4', '0.6', '0.8'],
    fallbackGradient: 'linear-gradient(90deg,#08306b,#2171b5,#41ab5d,#fec44f,#fff7bc)',
  },
  aod: {
    id: 'aod',
    label: 'Aerosol optical depth (monthly)',
    title: 'MERRA-2 monthly aerosol optical depth at 550 nm',
    unit: 'AOD',
    datasetId: 'gibs_aerosol',
    note: 'Monthly MERRA-2 reanalysis of aerosol extinction, not a daily satellite retrieval. Continuous global field for context; display-only, not used in scoring.',
    legendUrl: 'https://gibs.earthdata.nasa.gov/legends/MERRA2_Total_Aerosol_Optical_Thickness_550nm_Extinction_Monthly_H.svg',
    fallbackTicks: ['0.0', '0.5', '1.0', '2.0+'],
    fallbackGradient: 'linear-gradient(90deg,#f7f4c0,#fdd27f,#f39c4a,#d95f2b,#8c2d19)',
  },
};

/** Basemap legends are separate because they describe the base layer, not an overlay. */
export const EARTH_BASEMAPS = {
  topography: {
    id: 'topography',
    label: 'Topography',
    title: 'ASTER GDEM color shaded relief',
    unit: 'relief',
    datasetId: 'gibs_topography',
    note: 'Static ASTER Global DEM shaded relief, 30 m native (83°N–83°S). Relief shading is cartographic and display-only; use the Terrain section for numeric elevation, slope and roughness.',
    legendUrl: null,
    fallbackTicks: ['low', 'high'],
    fallbackGradient: 'linear-gradient(90deg,#215d4a,#7f9b63,#b98d5e,#eadcc4,#f8f5ef)',
  },
};

const PIN_COLORS = { A: 'a', B: 'b', C: 'c', D: 'd', F: 'f', '—': 'u' };

export class EarthMap {
  constructor(container, { onSelect, onPick, onMove }) {
    this.container = container;
    this.onSelect = onSelect;
    this.onPick = onPick;
    this.onMove = onMove;
    this.markers = new Map();
    this.map = null;
  }

  async init() {
    if (!window.maplibregl) throw new Error('MapLibre GL could not be loaded (check the network connection).');
    this.map = new window.maplibregl.Map({
      container: this.container,
      style: {
        version: 8,
        sources: {
          bm: { type: 'raster', tiles: [SOURCES['blue-marble']], tileSize: 256, maxzoom: 8, attribution: 'NASA GIBS · Blue Marble' },
          sat: { type: 'raster', tiles: [SOURCES.satellite], tileSize: 256, maxzoom: 8, attribution: 'Imagery © Esri' },
          topo: { type: 'raster', tiles: [SOURCES.topography], tileSize: 256, maxzoom: 8, attribution: 'NASA GIBS · ASTER GDEM' },
          lst: { type: 'raster', tiles: [SOURCES.lst], tileSize: 256, maxzoom: 7, attribution: 'NASA GIBS · MODIS LST' },
          albedo: { type: 'raster', tiles: [SOURCES.albedo], tileSize: 256, maxzoom: 8, attribution: 'NASA GIBS · MODIS albedo' },
          aod: { type: 'raster', tiles: [SOURCES.aod], tileSize: 256, maxzoom: 6, attribution: 'NASA GIBS · MERRA-2 AOD' },
          labels: { type: 'raster', tiles: [SOURCES.labels], tileSize: 256, maxzoom: 8, attribution: 'Labels © Esri' },
        },
        layers: [
          { id: 'bg', type: 'background', paint: { 'background-color': '#04070d' } },
          { id: 'base-bm', type: 'raster', source: 'bm', paint: { 'raster-opacity': 1 } },
          { id: 'base-sat', type: 'raster', source: 'sat', layout: { visibility: 'none' } },
          { id: 'base-topo', type: 'raster', source: 'topo', layout: { visibility: 'none' }, paint: { 'raster-opacity': 1 } },
          { id: 'overlay-lst', type: 'raster', source: 'lst', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.55 } },
          { id: 'overlay-albedo', type: 'raster', source: 'albedo', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.65 } },
          { id: 'overlay-aod', type: 'raster', source: 'aod', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.7 } },
          { id: 'labels', type: 'raster', source: 'labels', paint: { 'raster-opacity': 0.95 } },
        ],
      },
      center: [12, 18],
      zoom: 1.4,
      minZoom: 0.5,
      maxZoom: 8,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
    });
    this.map.touchZoomRotate.disableRotation();
    this.map.addControl(new window.maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    this.map.addControl(new window.maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left');

    this.map.on('click', (e) => {
      this.onPick?.({ lat: e.lngLat.lat, lon: e.lngLat.lng });
    });
    this.map.on('mousemove', (e) => {
      this.onMove?.({ lat: e.lngLat.lat, lon: e.lngLat.lng });
    });
    this.map.on('zoom', () => this.updateLabelClass());

    // MapLibre constructs the map asynchronously. Calling setLayoutProperty()
    // before the inline style has loaded throws "Style is not done loading",
    // which previously surfaced as "Earth map unavailable" on slower loads.
    await new Promise((resolve, reject) => {
      const map = this.map;
      if (map.isStyleLoaded()) {
        resolve();
        return;
      }
      const cleanup = () => {
        clearTimeout(timer);
        map.off('styledata', check);
        map.off('load', check);
      };
      const check = () => {
        if (!map.isStyleLoaded()) return;
        cleanup();
        resolve();
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('The Earth basemap style did not finish loading. Check the network connection and retry.'));
      }, 15000);
      map.on('styledata', check);
      map.on('load', check);
      check();
    });
    return this;
  }

  updateLabelClass() {
    if (!this.map) return;
    const show = this.map.getZoom() >= 3.2;
    this.container.classList.toggle('show-labels', show);
  }

  setBasemap(kind) {
    if (!this.map) return;
    this.map.setLayoutProperty('base-bm', 'visibility', kind === 'blue-marble' ? 'visible' : 'none');
    this.map.setLayoutProperty('base-sat', 'visibility', kind === 'satellite' ? 'visible' : 'none');
    this.map.setLayoutProperty('base-topo', 'visibility', kind === 'topography' ? 'visible' : 'none');
  }

  setOverlay(kind) {
    if (!this.map) return;
    this.map.setLayoutProperty('overlay-lst', 'visibility', kind === 'lst' ? 'visible' : 'none');
    this.map.setLayoutProperty('overlay-albedo', 'visibility', kind === 'albedo' ? 'visible' : 'none');
    this.map.setLayoutProperty('overlay-aod', 'visibility', kind === 'aod' ? 'visible' : 'none');
  }

  setLabelsVisible(visible) {
    if (!this.map) return;
    this.map.setLayoutProperty('labels', 'visibility', visible ? 'visible' : 'none');
  }

  /** items: [{id,name,lat,lon,grade,country,established,score}] */
  setMarkers(items, onSelect) {
    if (!this.map) return;
    for (const marker of this.markers.values()) marker.remove();
    this.markers.clear();
    for (const item of items) {
      const el = document.createElement('button');
      el.className = `earth-pin pin-${PIN_COLORS[item.grade] || 'u'}${item.selected ? ' selected' : ''}`;
      el.type = 'button';
      el.title = `${item.name} — Earth analog grade ${item.grade || 'unrated'}`;
      el.setAttribute('aria-label', `${item.name}, analog grade ${item.grade || 'unrated'}`);
      el.innerHTML = `<span class="pin-dot">${item.grade || '—'}</span><span class="pin-text">${item.name}<em>${item.country || ''}</em></span>`;
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        (onSelect || this.onSelect)?.(item.id);
      });
      const marker = new window.maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([item.lon, item.lat])
        .addTo(this.map);
      this.markers.set(item.id, marker);
    }
    this.updateLabelClass();
  }

  flyTo(lat, lon, zoom = 5) {
    this.map?.flyTo({ center: [lon, lat], zoom, duration: 1100 });
  }

  resize() {
    this.map?.resize();
  }

  destroy() {
    if (this.map) this.map.remove();
    this.map = null;
    this.markers.clear();
  }
}
