#!/usr/bin/env node
/**
 * RADIUM data preparation — reproducible ingestion of the two bundled DEMs.
 *
 *   node tools/prepare-data.mjs [--keep-src]
 *
 * Sources (NASA PDS, public domain):
 *   Moon: LRO LOLA LDEM 4 ppd, ldem_4.img  (LSB int16, height = DN × 0.5 m)
 *   Mars: MGS MOLA MEGDR 4 ppd, megt90n000cb.img (MSB int16, metres vs areoid)
 *
 * Outputs:
 *   data/moon_lola_4ppd.bin   little-endian int16 of DN (height = DN × 0.5 m)
 *   data/mars_mola_4ppd.bin   little-endian int16 of elevation in metres
 *   data/dem-meta.json        grid metadata, source checksums, percentiles
 *
 * No value is altered beyond endianness conversion. Percentiles are computed
 * for colour-ramp scaling only and do not modify the stored grid.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const SRC_DIR = path.join(DATA_DIR, 'src');
const KEEP_SRC = process.argv.includes('--keep-src');

const SOURCES = {
  moon: {
    body: 'moon',
    datasetId: 'moon_lola_4ppd',
    datasetLabel: 'LRO LOLA LDEM 4 ppd',
    url: 'https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/img/ldem_4.img',
    filename: 'ldem_4.img',
    width: 1440,
    height: 720,
    lonOrigin: 0,
    radiusM: 1737400,
    scale: 0.5,
    offset: 0,
    srcEndian: 'le',
    outFilename: 'moon_lola_4ppd.bin',
    notes: 'Simple cylindrical, planetocentric. Each sample is height relative to the 1737.4 km reference radius, DN × 0.5 m.',
  },
  mars: {
    body: 'mars',
    datasetId: 'mars_mola_4ppd',
    datasetLabel: 'MGS MOLA MEGDR 4 ppd',
    url: 'https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/meg004/megt90n000cb.img',
    filename: 'megt90n000cb.img',
    width: 1440,
    height: 720,
    lonOrigin: 0,
    radiusM: 3396190,
    scale: 1,
    offset: 0,
    srcEndian: 'be',
    outFilename: 'mars_mola_4ppd.bin',
    notes: 'Simple cylindrical, planetocentric; topography in metres relative to the IAU 2000 areoid. Empty bins are interpolated by the MOLA team.',
  },
};

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(dest, buf);
  return buf;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

async function main() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(SRC_DIR, { recursive: true });
  const meta = {};

  for (const [key, cfg] of Object.entries(SOURCES)) {
    const srcPath = path.join(SRC_DIR, cfg.filename);
    let raw;
    try {
      raw = await fs.readFile(srcPath);
      console.log(`[${key}] using cached ${cfg.filename}`);
    } catch {
      console.log(`[${key}] downloading ${cfg.url}`);
      raw = await download(cfg.url, srcPath);
    }
    if (raw.length !== cfg.width * cfg.height * 2) {
      throw new Error(`[${key}] expected ${cfg.width * cfg.height * 2} bytes, got ${raw.length}`);
    }

    const expectedEndian = cfg.srcEndian === 'be' ? false : true;
    const srcView = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const values = new Int16Array(cfg.width * cfg.height);
    const sample = [];
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    for (let i = 0; i < values.length; i += 1) {
      const dn = srcView.getInt16(i * 2, expectedEndian);
      values[i] = dn;
      const metres = dn * cfg.scale + cfg.offset;
      if (metres < min) min = metres;
      if (metres > max) max = metres;
      sum += metres;
      if (i % 7 === 0) sample.push(metres);
    }
    sample.sort((a, b) => a - b);

    const outPath = path.join(DATA_DIR, cfg.outFilename);
    await fs.writeFile(outPath, Buffer.from(values.buffer, values.byteOffset, values.byteLength));

    meta[key] = {
      body: cfg.body,
      datasetId: cfg.datasetId,
      datasetLabel: cfg.datasetLabel,
      width: cfg.width,
      height: cfg.height,
      lonOrigin: cfg.lonOrigin,
      radiusM: cfg.radiusM,
      scale: cfg.scale,
      offset: cfg.offset,
      endian: 'le',
      binPath: `data/${cfg.outFilename}`,
      sourceUrl: cfg.url,
      sourceSha256: sha256(raw),
      binSha256: sha256(Buffer.from(values.buffer, values.byteOffset, values.byteLength)),
      minM: Number(min.toFixed(1)),
      maxM: Number(max.toFixed(1)),
      meanM: Number((sum / values.length).toFixed(1)),
      p02M: Number(percentile(sample, 2).toFixed(1)),
      p98M: Number(percentile(sample, 98).toFixed(1)),
      coverage: 'Global 90°N–90°S, 0–360°E',
      resolution: '0.25° per pixel (4 ppd)',
      notes: `${cfg.notes} PDS label WESTERNMOST_LONGITUDE = 0°, so the left edge of the grid is 0°E, not −180°; lonOrigin records this.`,
      preparedAt: new Date().toISOString(),
    };
    console.log(`[${key}] wrote ${cfg.outFilename} · elevation ${min.toFixed(0)} … ${max.toFixed(0)} m · p02/p98 ${meta[key].p02M}/${meta[key].p98M} m`);
  }

  await fs.writeFile(path.join(DATA_DIR, 'dem-meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  console.log('wrote data/dem-meta.json');

  if (!KEEP_SRC) {
    await fs.rm(SRC_DIR, { recursive: true, force: true });
    console.log('removed downloaded source files (use --keep-src to retain)');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
