/**
 * Terrain sampling from bundled planetary DEMs.
 *
 * Pure computation lives here so it can be unit-tested in Node. Loading is a
 * separate async function that fetches the bundled binary grids.
 */

const META_URL = 'data/dem-meta.json';

function clampLat(lat) {
  return Math.max(-89.999, Math.min(89.999, lat));
}

function wrapLon(lon) {
  let l = ((lon + 180) % 360 + 360) % 360 - 180;
  if (l === -180) l = 180;
  return l;
}

export class DemGrid {
  /**
   * @param {{width:number,height:number,radiusM:number,scale:number,offset?:number,endian?:'le'|'be',datasetLabel:string,datasetId:string}} meta
   * @param {Int16Array|DataView} data
   */
  constructor(meta, data) {
    this.meta = meta;
    this.width = meta.width;
    this.height = meta.height;
    this.radiusM = meta.radiusM;
    this.scale = meta.scale ?? 1;
    this.offset = meta.offset ?? 0;
    this.datasetLabel = meta.datasetLabel;
    this.datasetId = meta.datasetId;
    // PDS labels for both products declare WESTERNMOST_LONGITUDE = 0°, i.e. the
    // grid runs 0–360°E. This must not be assumed to be −180–180.
    this.lonOrigin = meta.lonOrigin ?? 0;
    this.values = data instanceof DataView ? null : data;
    this.view = data instanceof DataView ? data : null;
    this.cellDegLon = 360 / this.width;
    this.cellDegLat = 180 / this.height;
    this.lonSpacingM = (2 * Math.PI * this.radiusM) / this.width;
    this.latSpacingM = (Math.PI * this.radiusM) / this.height;
  }

  static fromArrayBuffer(meta, buffer) {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < meta.width * meta.height * 2) {
      throw new Error(`DEM buffer for ${meta.datasetId} has unexpected size.`);
    }
    return new DemGrid(meta, new Int16Array(buffer, 0, meta.width * meta.height));
  }

  elevationAtRowCol(row, col) {
    const r = Math.max(0, Math.min(this.height - 1, row));
    const c = ((col % this.width) + this.width) % this.width;
    const dn = this.view ? this.view.getInt16((r * this.width + c) * 2, this.meta.endian !== 'be' ? true : false) : this.values[r * this.width + c];
    return dn * this.scale + this.offset;
  }

  /** Bilinear elevation sample in metres. */
  elevation(lat, lon) {
    const phi = clampLat(lat);
    const lam = wrapLon(lon);
    const x = ((((lam - this.lonOrigin) % 360) + 360) % 360) / 360 * this.width - 0.5;
    const y = (90 - phi) / 180 * this.height - 0.5;
    const c0 = Math.floor(x);
    const r0 = Math.floor(y);
    const fx = x - c0;
    const fy = y - r0;
    const z00 = this.elevationAtRowCol(r0, c0);
    const z10 = this.elevationAtRowCol(r0, c0 + 1);
    const z01 = this.elevationAtRowCol(r0 + 1, c0);
    const z11 = this.elevationAtRowCol(r0 + 1, c0 + 1);
    return (z00 * (1 - fx) + z10 * fx) * (1 - fy) + (z01 * (1 - fx) + z11 * fx) * fy;
  }

  /**
   * Regional terrain metrics from a 3×3 physical sampling grid (default 10 km
   * spacing, ~20 km window). Using a physical baseline avoids the artificial
   * slope inflation that adjacent 0.25° columns produce near the poles, where
   * longitude convergence makes grid cells only tens of metres wide. It also
   * makes planetary metrics comparable with the Earth sampling grid.
   */
  sample(lat, lon, spacingKm = null) {
    const phi = clampLat(lat);
    const lam = wrapLon(lon);
    const targetKm = Number(spacingKm ?? this.meta.sampleSpacingKm ?? 10);
    const targetM = targetKm * 1000;
    const degPerM = 180 / (Math.PI * this.radiusM);
    const dLat = targetM * degPerM;
    const cosLat = Math.max(0.02, Math.cos((phi * Math.PI) / 180));
    const dLon = Math.min(30, (targetM * degPerM) / cosLat);
    const dxM = Math.max(1, ((dLon * Math.PI) / 180) * this.radiusM * cosLat);
    const dyM = Math.max(1, ((dLat * Math.PI) / 180) * this.radiusM);

    const z = (dr, dc) => this.elevation(phi + dr * dLat, lam + dc * dLon);
    const a = z(-1, -1); const b = z(-1, 0); const c = z(-1, 1);
    const d = z(0, -1); const e = z(0, 0); const f = z(0, 1);
    const g = z(1, -1); const h = z(1, 0); const i = z(1, 1);

    const dzdx = ((c + 2 * f + i) - (a + 2 * d + g)) / (8 * dxM);
    const dzdy = ((g + 2 * h + i) - (a + 2 * b + c)) / (8 * dyM);
    const slopeDeg = (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;

    const vals = [a, b, c, d, e, f, g, h, i];
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;

    return {
      lat: phi,
      lon: lam,
      elevationM: e,
      slopeDeg,
      roughnessM: Math.sqrt(variance),
      windowKm: Number((2 * targetKm).toFixed(1)),
      resolutionKm: targetKm,
      nativeCellKm: Number(((this.latSpacingM + this.lonSpacingM * cosLat) / 2000).toFixed(1)),
      cells: { width: this.width, height: this.height, cellDeg: this.cellDegLat },
      datasetLabel: this.datasetLabel,
      datasetId: this.datasetId,
      method: `${targetKm} km physical sampling grid; Horn 3×3 slope; population σ over 9 samples`,
    };
  }
}

/** Loads bundled DEM metadata and binary grids for a body. */
export async function loadDem(body) {
  const metaRes = await fetch(META_URL, { cache: 'force-cache' });
  if (!metaRes.ok) throw new Error('DEM metadata unavailable.');
  const metaAll = await metaRes.json();
  const meta = metaAll[body];
  if (!meta) throw new Error(`No DEM registered for ${body}.`);
  const binRes = await fetch(meta.binPath, { cache: 'force-cache' });
  if (!binRes.ok) throw new Error(`${body} DEM binary unavailable.`);
  const buffer = await binRes.arrayBuffer();
  return DemGrid.fromArrayBuffer(meta, buffer);
}

/** Fixed-colour ramp sampling for data layers (no data → transparent). */
export function sampleRamp(stops, t) {
  if (!Number.isFinite(t)) return null;
  const x = Math.max(0, Math.min(1, t));
  for (let i = 1; i < stops.length; i += 1) {
    const [p1, c1] = stops[i - 1];
    const [p2, c2] = stops[i];
    if (x <= p2) {
      const f = (x - p1) / (p2 - p1 || 1);
      const a1 = c1[3] ?? 255;
      const a2 = c2[3] ?? 255;
      return [
        Math.round(c1[0] + f * (c2[0] - c1[0])),
        Math.round(c1[1] + f * (c2[1] - c1[1])),
        Math.round(c1[2] + f * (c2[2] - c1[2])),
        Math.round(a1 + f * (a2 - a1)),
      ];
    }
  }
  const last = stops[stops.length - 1][1];
  return [last[0], last[1], last[2], last[3] ?? 255];
}
