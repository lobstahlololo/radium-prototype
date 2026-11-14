import test from 'node:test';
import assert from 'node:assert/strict';

import { MOON_SITES } from '../js/data/moon-sites.js';
import { MARS_SITES } from '../js/data/mars-sites.js';
import { EARTH_ANALOGS } from '../js/data/analogs.js';
import { DATASETS, DATASET_ORDER, getDataset } from '../js/data/datasets.js';
import { SUBSTRATE_AFFINITY, VOLATILE_AFFINITY } from '../js/science/similarity.js';

function assertUniqueIds(list, label) {
  const ids = new Set();
  for (const item of list) {
    assert.ok(!ids.has(item.id), `${label}: duplicate id ${item.id}`);
    ids.add(item.id);
  }
}

test('all planetary sites carry unique ids, valid coordinates and provenance', () => {
  for (const [sites, body] of [[MOON_SITES, 'moon'], [MARS_SITES, 'mars']]) {
    assertUniqueIds(sites, body);
    assert.ok(sites.length >= 10, `${body} has enough sites for a candidate ranking`);
    for (const s of sites) {
      assert.equal(s.body, body);
      assert.ok(s.lat >= -90 && s.lat <= 90, `${s.id} latitude`);
      assert.ok(s.lon >= -180 && s.lon <= 180, `${s.id} longitude`);
      assert.ok(s.name && s.region && s.summary, `${s.id} readable metadata`);
      assert.ok(Object.keys(SUBSTRATE_AFFINITY).includes(s.substrateGroup), `${s.id} substrate group ${s.substrateGroup}`);
      assert.ok(Object.keys(VOLATILE_AFFINITY).includes(s.volatileGroup), `${s.id} volatile group ${s.volatileGroup}`);
      assert.ok(s.sources.length >= 2, `${s.id} sources`);
      for (const ds of s.sources) assert.ok(getDataset(ds), `${s.id} references unknown dataset ${ds}`);
      assert.ok(s.tempMeanK && s.tempMeanK.value > 30 && s.tempMeanK.value < 500, `${s.id} temperature plausible`);
      assert.ok(s.tempMeanK.uncertainty > 0, `${s.id} temperature uncertainty documented`);
      assert.ok(s.tempMeanK.note, `${s.id} temperature note`);
      if (body === 'moon') {
        assert.ok(s.earthVisibility && s.earthVisibility.value >= 0 && s.earthVisibility.value <= 1, `${s.id} Earth visibility`);
      }
      if (body === 'mars') {
        assert.ok(['low', 'moderate', 'high'].includes(s.dustRisk.class), `${s.id} dust class`);
      }
      assert.ok(s.ice.score >= 0 && s.ice.score <= 100, `${s.id} ice index`);
      assert.ok(['observed', 'inferred', 'modeled', 'assessment'].includes(s.ice.evidence), `${s.id} ice evidence class`);
      for (const v of [s.geologyValue, s.scienceValue]) {
        assert.ok(v.score >= 0 && v.score <= 100, `${s.id} assessment range`);
        assert.ok(v.rationale.length > 20, `${s.id} assessment rationale`);
      }
      if (s.solarOverride) {
        assert.ok(s.solarOverride.value >= 0 && s.solarOverride.value <= 1);
        assert.ok(s.solarOverride.uncertainty > 0);
      }
      if (Math.abs(s.lat) > 80) {
        assert.ok(s.solarOverride, `${s.id} polar site needs published illumination override`);
      }
    }
  }
});

test('solar overrides are limited to polar sites and marked as published models', () => {
  for (const s of [...MOON_SITES, ...MARS_SITES]) {
    if (s.solarOverride) {
      assert.ok(Math.abs(s.lat) > 80, `${s.id} non-polar override`);
      assert.ok(s.solarOverride.note, `${s.id} override note`);
    }
  }
});

test('Earth analog pool has valid, comparable categories', () => {
  assertUniqueIds(EARTH_ANALOGS, 'earth');
  assert.ok(EARTH_ANALOGS.length >= 25);
  for (const a of EARTH_ANALOGS) {
    assert.ok(a.lat >= -90 && a.lat <= 90, `${a.id} latitude`);
    assert.ok(a.lon >= -180 && a.lon <= 180, `${a.id} longitude`);
    assert.ok(Object.keys(SUBSTRATE_AFFINITY).includes(a.substrateGroup), `${a.id} substrate`);
    assert.ok(Object.keys(VOLATILE_AFFINITY).includes(a.volatileGroup), `${a.id} volatile`);
    assert.equal(typeof a.established, 'boolean');
    assert.ok(a.geologyBasis && a.landform && a.country);
    assert.equal(a.climate, undefined, 'Earth climate must be fetched, never hardcoded');
    assert.equal(a.terrain, undefined, 'Earth terrain must be derived, never hardcoded');
  }
  const established = EARTH_ANALOGS.filter((a) => a.established).length;
  assert.ok(established > 5 && established < EARTH_ANALOGS.length, 'pool mixes established and emerging candidates');
});

test('dataset registry is complete and self-consistent', () => {
  for (const id of DATASET_ORDER) {
    const ds = DATASETS[id];
    assert.ok(ds, `missing dataset ${id}`);
    assert.equal(ds.id, id);
    for (const key of ['title', 'agency', 'purpose', 'url', 'access', 'coverage', 'resolution', 'temporal', 'crs', 'license', 'limitations', 'processing']) {
      assert.ok(ds[key] && String(ds[key]).length > 3, `${id}.${key}`);
    }
    assert.ok(ds.variables.length > 0, `${id}.variables`);
    assert.ok(ds.url.startsWith('http'), `${id}.url`);
  }
  assert.ok(DATASET_ORDER.length >= 15);
});
