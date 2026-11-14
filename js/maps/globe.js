/**
 * 3D planetary globe on CesiumJS with body-correct ellipsoids and NASA Trek
 * WMTS imagery. All markers are curated sites; terrain layers come from the
 * bundled DEMs. If Cesium or the imagery service is unavailable the map reports
 * that explicitly instead of showing a decorative substitute.
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

const GRADE_COLORS = {
  A: ['#0e3b2e', '#4ade80'],
  B: ['#0b3336', '#2dd4bf'],
  C: ['#3b3312', '#fbbf24'],
  D: ['#3b2012', '#fb923c'],
  F: ['#3b1218', '#f87171'],
  '—': ['#1b2436', '#94a3b8'],
};

function badgeImage(letter) {
  const [bg, fg] = GRADE_COLORS[letter] || GRADE_COLORS['—'];
  const size = 96;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  ctx.beginPath();
  ctx.arc(size / 2, size / 2 - 8, 30, 0, Math.PI * 2);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = fg;
  ctx.stroke();
  ctx.fillStyle = fg;
  ctx.font = '600 34px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(letter, size / 2, size / 2 - 4);
  // pointer
  ctx.beginPath();
  ctx.moveTo(size / 2 - 7, size / 2 + 14);
  ctx.lineTo(size / 2 + 7, size / 2 + 14);
  ctx.lineTo(size / 2, size / 2 + 26);
  ctx.closePath();
  ctx.fillStyle = fg;
  ctx.fill();
  return c.toDataURL();
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
      contextOptions: { webgl: { alpha: false, preserveDrawingBuffer: false } },
    });

    const scene = this.viewer.scene;
    scene.backgroundColor = C.Color.fromCssColorString('#04070d');
    scene.globe.baseColor = C.Color.fromCssColorString('#0c1422');
    scene.globe.showGroundAtmosphere = false;
    scene.globe.enableLighting = false;
    scene.fog.enabled = false;
    scene.screenSpaceCameraController.minimumZoomDistance = 1200;

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

    this.onStatus?.({ type: 'globe', ok: true, message: `${cfg.credit}` });
    return this;
  }

  badgeFor(letter) {
    if (!this._badges) this._badges = {};
    const key = letter || '—';
    if (!this._badges[key]) this._badges[key] = badgeImage(key);
    return this._badges[key];
  }

  /** sites: [{...site, grade, elevationM}] */
  setSites(sites) {
    if (!this.viewer) return;
    const C = window.Cesium;
    for (const entity of this._entities || []) this.viewer.entities.remove(entity);
    this._entities = [];
    this.sites = sites;
    for (const site of sites) {
      const entity = this.viewer.entities.add({
        position: C.Cartesian3.fromDegrees(site.lon, site.lat, (site.elevationM ?? 0) + 1200, this.ellipsoid),
        billboard: {
          image: this.badgeFor(site.grade),
          width: site.id === this.selectedId ? 36 : 27,
          height: site.id === this.selectedId ? 36 : 27,
          verticalOrigin: C.VerticalOrigin.BOTTOM,
          scaleByDistance: new C.NearFarScalar(200000, 1.25, 30000000, 0.75),
        },
        label: {
          text: site.name,
          font: '500 13px Inter, system-ui, sans-serif',
          fillColor: C.Color.WHITE,
          showBackground: true,
          backgroundColor: C.Color.fromCssColorString('rgba(4,9,17,0.82)'),
          backgroundPadding: new C.Cartesian2(8, 5),
          pixelOffset: new C.Cartesian2(0, -44),
          verticalOrigin: C.VerticalOrigin.BOTTOM,
          show: site.id === this.selectedId,
          disableDepthTestDistance: 6000,
        },
      });
      entity.radiumSiteId = site.id;
      this._entities.push(entity);
    }
  }

  highlight(siteId) {
    this.selectedId = siteId;
    this.setSites(this.sites);
  }

  setBaseVisible(visible) {
    if (this.baseLayer) this.baseLayer.show = visible;
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
  }

  flyTo(lat, lon, height) {
    if (!this.viewer) return;
    const C = window.Cesium;
    const cfg = IMAGERY[this.body];
    this.viewer.camera.flyTo({
      destination: C.Cartesian3.fromDegrees(lon, lat, height ?? cfg.height, this.ellipsoid),
      duration: 1.1,
    });
  }

  flyOverview() {
    if (!this.viewer) return;
    const C = window.Cesium;
    const cfg = IMAGERY[this.body];
    this.viewer.camera.flyTo({
      destination: C.Cartesian3.fromDegrees(0, 0, cfg.overview, this.ellipsoid),
      duration: 1.1,
    });
  }

  resize() {
    this.viewer?.resize();
  }

  destroy() {
    if (this.handler) this.handler.destroy();
    if (this.viewer) this.viewer.destroy();
    this.viewer = null;
    this.container.innerHTML = '';
  }
}
