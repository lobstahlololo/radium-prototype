/**
 * Context imagery thumbnails generated from the same NASA tile services used by
 * the globes. The image always depicts the selected coordinates — never a stock
 * photo standing in for a different place.
 */

const TREK = {
  moon: {
    url: (z, x, y) => `https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/${z}/${y}/${x}.jpg`,
    credit: 'NASA / LRO LROC WAC global mosaic (303 ppd) · NASA Solar System Treks',
    zoom: 7,
    scheme: 'geographic',
  },
  mars: {
    url: (z, x, y) => `https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0/default/default028mm/${z}/${y}/${x}.jpg`,
    credit: 'NASA / MGS Viking MDIM21 color mosaic (232 m) · NASA Solar System Treks',
    zoom: 7,
    scheme: 'geographic',
  },
  earth: {
    url: (z, x, y) => `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/${z}/${y}/${x}.jpeg`,
    credit: 'NASA Blue Marble / shaded relief (NASA GIBS)',
    zoom: 6,
    scheme: 'mercator',
  },
};

function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function geographicPixels(lat, lon, zoom) {
  const cols = 2 ** (zoom + 1);
  const rows = 2 ** zoom;
  const worldW = cols * 256;
  const worldH = rows * 256;
  return {
    x: ((lon + 180) / 360) * worldW,
    y: ((90 - lat) / 180) * worldH,
    cols,
    rows,
  };
}

function mercatorPixels(lat, lon, zoom) {
  const world = 256 * 2 ** zoom;
  const phi = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180;
  const x = ((lon + 180) / 360) * world;
  const y = ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * world;
  return { x, y, cols: 2 ** zoom, rows: 2 ** zoom };
}

/**
 * Draws a 384×256 context thumbnail centred on the coordinates.
 * @returns {Promise<{ok:boolean, credit?:string, reason?:string}>}
 */
export async function drawContextThumb(canvas, { body, lat, lon }) {
  const cfg = TREK[body];
  if (!cfg || !canvas) return { ok: false, reason: 'No imagery service for this body.' };
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = 384;
  const h = 256;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  // Let the card CSS control display size; inline sizes override the compact
  // inspector aspect and force a 384×256 block on every layout.
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#070b13';
  ctx.fillRect(0, 0, w, h);

  const p = cfg.scheme === 'mercator' ? mercatorPixels(lat, lon, cfg.zoom) : geographicPixels(lat, lon, cfg.zoom);
  const startX = Math.round(p.x - w / 2);
  const startY = Math.round(p.y - h / 2);
  const tileX0 = Math.floor(startX / 256);
  const tileY0 = Math.floor(startY / 256);
  const tileX1 = Math.floor((startX + w - 1) / 256);
  const tileY1 = Math.floor((startY + h - 1) / 256);

  const requests = [];
  for (let ty = tileY0; ty <= tileY1; ty += 1) {
    for (let tx = tileX0; tx <= tileX1; tx += 1) {
      if (ty < 0 || ty >= p.rows) continue;
      const wrappedX = ((tx % p.cols) + p.cols) % p.cols;
      requests.push(
        loadImage(cfg.url(cfg.zoom, wrappedX, ty)).then((img) => ({ img, tx, ty })),
      );
    }
  }
  const tiles = await Promise.all(requests);
  const loaded = tiles.filter((t) => t.img);
  if (!loaded.length) return { ok: false, reason: 'Imagery service unavailable.' };

  for (const { img, tx, ty } of loaded) {
    ctx.drawImage(img, tx * 256 - startX, ty * 256 - startY, 256, 256);
  }

  // Crosshair marks the exact sampled coordinate, not a guessed landmark.
  ctx.save();
  ctx.strokeStyle = 'rgba(125, 211, 252, 0.85)';
  ctx.lineWidth = 1;
  const cx = w / 2;
  const cy = h / 2;
  ctx.beginPath();
  ctx.moveTo(cx - 14, cy); ctx.lineTo(cx - 4, cy);
  ctx.moveTo(cx + 4, cy); ctx.lineTo(cx + 14, cy);
  ctx.moveTo(cx, cy - 14); ctx.lineTo(cx, cy - 4);
  ctx.moveTo(cx, cy + 4); ctx.lineTo(cx, cy + 14);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, 2, 0, Math.PI * 2);
  ctx.fillStyle = '#7dd3fc';
  ctx.fill();
  ctx.restore();

  // Vignette for legibility of overlaid text.
  const grad = ctx.createLinearGradient(0, h * 0.62, 0, h);
  grad.addColorStop(0, 'rgba(4,8,16,0)');
  grad.addColorStop(1, 'rgba(4,8,16,0.72)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, h * 0.62, w, h * 0.38);

  return { ok: true, credit: cfg.credit };
}
