/**
 * 3D planetary globe on CesiumJS with body-correct ellipsoids and NASA Trek
 * WMTS imagery. Markers are curated sites or user-clicked terrain points;
 * terrain layers come from the bundled DEMs. If Cesium or the imagery service
 * is unavailable the map reports that explicitly instead of showing a
 * decorative substitute.
 */

const IMAGERY = {
  moon: {
    url: 'https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/{TileMatrix}/{TileRow}/{TileCol}.jpg',
    layer: 'LRO_WAC_Mosaic_Global_303ppd_v02',
    credit: 'NASA / LRO LROC WAC global mosaic · NASA Solar System Treks',
    height: 400000,
    overview: 3600000,
    maxLevel: 7,
  },
  mars: {
    url: 'https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0/default/default028mm/{TileMatrix}/{TileRow}/{TileCol}.jpg',
    layer: 'Mars_Viking_MDIM21_ClrMosaic_global_232m',
    credit: 'NASA / MGS Viking MDIM21 color mosaic · NASA Solar System Treks',
    height: 900000,
    overview: 7500000,
    maxLevel: 7,
  },
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

export class PlanetGlobe {
  constructor(container, { body, onSiteSelect, onPick, onStatus }) {
    this.container = container;
    this.body = body;
    this.onSiteSelect = onSiteSelect;
    this.onPick = onPick;
    this.onStatus = onStatus;
    this.sites = [];
    this.selectedId = null;
    this.overlay = null;
    this.viewer = null;
    this.creditEl = null;
    this.markerLayer = null;
    this._markers = new Map();
    this._removeMarkerListener = null;
    this._viewport = { width: 0, height: 0 };
  }

  async init() {
    const C = window.Cesium;
    if (!C) throw new Error('CesiumJS could not be loaded (check the network connection).');
    const cfg = IMAGERY[this.body];
    if (!cfg) throw new Error(`No imagery configured for ${this.body}.`);

    const radius =
      this.body === 'moon'
        ? C.Ellipsoid.MOON || new C.Ellipsoid(1737400, 1737400, 1737400)
        : C.Ellipsoid.MARS || new C.Ellipsoid(3396190, 3396190, 3376200);
    this.ellipsoid = radius;
    this.creditEl = document.createElement('div');
    this.creditEl.className = 'cesium-credit';
    this.container.appendChild(this.creditEl);

    this.viewer = new C.Viewer(this.container, {
      baseLayer: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      skyBox: false,
      skyAtmosphere: false,
      shouldAnimate: false,
      creditContainer: this.creditEl,
      globe: new C.Globe(radius),
      mapProjection: new C.GeographicProjection(radius),
      targetFrameRate: 30,
      useBrowserRecommendedResolution: false,
      requestRenderMode: true,
      maximumRenderTimeChange: Infinity,
      contextOptions: { webgl: { alpha: false, preserveDrawingBuffer: false } },
    });

    const scene = this.viewer.scene;
    scene.backgroundColor = C.Color.fromCssColorString('#04070d');
    scene.globe.baseColor = C.Color.fromCssColorString('#0c1422');
    scene.globe.showGroundAtmosphere = false;
    scene.globe.enableLighting = false;
    scene.fog.enabled = false;
    scene.screenSpaceCameraController.minimumZoomDistance = 1200;
    // This globe is imagery plus DOM markers, so multisampling buys little and
    // costs a large amount of fill rate. Mars gets a looser screen-space error
    // target because its 232 m global mosaic is the expensive layer while the
    // markers and DEM overlays stay independent of imagery detail.
    this.viewer.useBrowserRecommendedResolution = false;
    this.viewer.resolutionScale = 1;
    scene.msaaSamples = 1;
    scene.postProcessStages.fxaa.enabled = false;
    scene.globe.maximumScreenSpaceError = 4;
    scene.globe.tileCacheSize = 96;
    scene.globe.preloadAncestors = false;
    scene.globe.preloadSiblings = false;
    scene.requestRenderMode = true;
    scene.maximumRenderTimeChange = Infinity;
    scene.screenSpaceCameraController.inertiaSpin = 0.78;
    scene.screenSpaceCameraController.inertiaTranslate = 0.78;
    scene.screenSpaceCameraController.inertiaZoom = 0.62;
    this.container.dataset.renderMode = 'request';
    this.container.dataset.msaa = '1';
    this.container.dataset.resolutionScale = '1';
    this.container.dataset.screenSpaceError = String(scene.globe.maximumScreenSpaceError);

    const tilingScheme = new C.GeographicTilingScheme({ ellipsoid: radius });
    const credit = new C.Credit(cfg.credit);
    this.imageryProvider = new C.WebMapTileServiceImageryProvider({
      url: cfg.url,
      layer: cfg.layer,
      style: 'default',
      format: 'image/jpeg',
      tileMatrixSetID: 'default028mm',
      tilingScheme,
      maximumLevel: cfg.maxLevel,
      credit,
    });
    this.imageryProvider.errorEvent.addEventListener(() => {
      this.onStatus?.({ type: 'imagery', ok: false, message: 'Imagery tiles are not loading; site markers and DEM layers are unaffected.' });
    });
    this.baseLayer = this.viewer.imageryLayers.addImageryProvider(this.imageryProvider);
    this.viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

    this.viewer.camera.setView({
      destination: C.Cartesian3.fromDegrees(0, 0, cfg.overview, radius),
    });

    this.handler = new C.ScreenSpaceEventHandler(scene.canvas);
    this.handler.setInputAction((click) => {
      const picked = scene.pick(click.position);
      if (C.defined(picked) && picked.id && picked.id.radiumSiteId) {
        this.onSiteSelect?.(picked.id.radiumSiteId);
        return;
      }
      const ray = this.viewer.camera.getPickRay(click.position);
      const cartesian = ray ? scene.globe.pick(ray, scene) : null;
      if (!cartesian) return;
      const carto = radius.cartesianToCartographic(cartesian);
      if (!carto) return;
      this.onPick?.({ lat: C.Math.toDegrees(carto.latitude), lon: C.Math.toDegrees(carto.longitude) });
    }, C.ScreenSpaceEventType.LEFT_CLICK);

    this.handler.setInputAction((movement) => {
      const picked = scene.pick(movement.endPosition);
      scene.canvas.style.cursor = C.defined(picked) && picked.id?.radiumSiteId ? 'pointer' : 'grab';
    }, C.ScreenSpaceEventType.MOUSE_MOVE);

    this.markerLayer = document.createElement('div');
    this.markerLayer.className = 'globe-marker-layer';
    this.container.appendChild(this.markerLayer);
    this._cacheViewport();
    this._removeMarkerListener = scene.postRender.addEventListener(() => this.updateMarkerPositions());

    this.onStatus?.({ type: 'globe', ok: true, message: `${cfg.credit}` });
    return this;
  }

  /** sites: curated sites or clicked points, each with lat/lon and optional grade. */
  setSites(sites) {
    if (!this.viewer || !this.markerLayer) return;
    const C = window.Cesium;
    this.sites = sites;
    this._markers.clear();
    this.markerLayer.replaceChildren();

    for (const site of sites) {
      const isPoint = site.kind === 'point';
      const grade = site.grade || '—';
      const marker = document.createElement('button');
      marker.type = 'button';
      marker.className = `globe-marker ${isPoint ? 'is-point' : `grade-${grade === '—' ? 'U' : grade}`}${site.id === this.selectedId ? ' is-selected' : ''}`;
      marker.dataset.siteId = site.id;
      marker.title = isPoint ? `${site.name} — clicked coordinate` : `${site.name} — suitability grade ${grade}`;
      marker.setAttribute('aria-label', isPoint ? `${site.name}, clicked coordinate` : `${site.name}, suitability grade ${grade}`);
      marker.innerHTML = `
        <span class="globe-marker-label">${escapeHtml(site.name)}</span>
        <span class="globe-marker-badge">${isPoint ? '+' : escapeHtml(grade)}</span>
        <span class="globe-marker-tip" aria-hidden="true"></span>`;
      marker.addEventListener('click', (event) => {
        event.stopPropagation();
        if (isPoint) this.onPick?.({ lat: site.lat, lon: site.lon });
        else this.onSiteSelect?.(site.id);
      });
      this.markerLayer.appendChild(marker);
      this._markers.set(site.id, {
        el: marker,
        // Markers sit on the visible ellipsoid, not at DEM elevation. The globe
        // is smooth, so an elevation offset would sink or float the pin.
        position: C.Cartesian3.fromDegrees(site.lon, site.lat, 0, this.ellipsoid),
        lastX: null,
        lastY: null,
      });
    }
    this.updateMarkerPositions();
    this.viewer.scene.requestRender();
  }

  _cacheViewport() {
    this._viewport = { width: this.container.clientWidth, height: this.container.clientHeight };
  }

  updateMarkerPositions() {
    if (!this.viewer || !this.markerLayer) return;
    const C = window.Cesium;
    const scene = this.viewer.scene;
    const { width, height } = this._viewport;
    if (!width || !height) return;
    const occluder = new C.EllipsoidalOccluder(this.ellipsoid, scene.camera.positionWC);
    for (const marker of this._markers.values()) {
      const screen = C.SceneTransforms.worldToWindowCoordinates(scene, marker.position);
      const visible = Boolean(screen) && occluder.isPointVisible(marker.position)
        && screen.x > -48 && screen.x < width + 48
        && screen.y > -64 && screen.y < height + 24;
      if (!visible) {
        if (!marker.el.hidden) marker.el.hidden = true;
        continue;
      }
      if (marker.el.hidden) marker.el.hidden = false;
      const x = Math.round(screen.x * 2) / 2;
      const y = Math.round(screen.y * 2) / 2;
      if (marker.lastX === x && marker.lastY === y) continue;
      marker.lastX = x;
      marker.lastY = y;
      marker.el.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -100%)`;
    }
  }

  highlight(siteId) {
    this.selectedId = siteId;
    for (const [id, marker] of this._markers) {
      marker.el.classList.toggle('is-selected', id === siteId);
    }
    this.updateMarkerPositions();
    this.viewer?.scene.requestRender();
  }

  setBaseVisible(visible) {
    if (this.baseLayer) this.baseLayer.show = visible;
    this.viewer?.scene.requestRender();
  }

  /** overlay: {canvas, width, height} or null */
  setTerrainOverlay(overlay) {
    if (!this.viewer) return;
    const C = window.Cesium;
    if (this.overlayLayer) {
      this.viewer.imageryLayers.remove(this.overlayLayer, true);
      this.overlayLayer = null;
    }
    if (!overlay?.canvas) return;
    const provider = new C.SingleTileImageryProvider({
      url: overlay.canvas.toDataURL('image/png'),
      rectangle: C.Rectangle.fromDegrees(-180, -90, 180, 90),
      tileWidth: overlay.width,
      tileHeight: overlay.height,
      tilingScheme: new C.GeographicTilingScheme({ ellipsoid: this.ellipsoid }),
    });
    this.overlayLayer = this.viewer.imageryLayers.addImageryProvider(provider);
    this.overlayLayer.alpha = 0.72;
    this.viewer.scene.requestRender();
  }

  flyTo(lat, lon, height) {
    if (!this.viewer) return;
    const C = window.Cesium;
    const cfg = IMAGERY[this.body];
    this.viewer.camera.flyTo({
      destination: C.Cartesian3.fromDegrees(lon, lat, height ?? cfg.height, this.ellipsoid),
      duration: cfg === IMAGERY.mars ? 0.72 : 0.85,
    });
  }

  flyOverview() {
    if (!this.viewer) return;
    const C = window.Cesium;
    const cfg = IMAGERY[this.body];
    this.viewer.camera.flyTo({
      destination: C.Cartesian3.fromDegrees(0, 0, cfg.overview, this.ellipsoid),
      duration: cfg === IMAGERY.mars ? 0.72 : 0.85,
    });
  }

  resize() {
    this._cacheViewport();
    this.viewer?.resize();
    this.viewer?.scene.requestRender();
  }

  destroy() {
    if (this._removeMarkerListener) this._removeMarkerListener();
    this._removeMarkerListener = null;
    this._markers.clear();
    this.markerLayer?.remove();
    this.markerLayer = null;
    if (this.handler) this.handler.destroy();
    if (this.viewer) this.viewer.destroy();
    this.viewer = null;
    this.container.innerHTML = '';
  }
}
