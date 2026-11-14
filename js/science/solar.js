/** Derived solar geometry. Clearly labelled as a model, not a measurement. */

const OBLIQUITY_DEG = { moon: 1.543, mars: 25.19, earth: 23.44 };

/**
 * Mean top-of-atmosphere irradiance at each body's orbit, W/m². The Moon is
 * effectively at 1 AU; Mars's semi-major axis is 1.524 AU, giving 1361/1.524².
 * These are published orbital constants, not site measurements.
 */
export const SOLAR_IRRADIANCE_WM2 = Object.freeze({ moon: 1361, mars: 586.2, earth: 1361 });

export function topOfAtmosphereIrradiance(body) {
  return SOLAR_IRRADIANCE_WM2[body] ?? null;
}

/**
 * Annual mean insolation on a flat, unobstructed surface expressed as a
 * fraction of the solar constant (24-hour basis), integrated over a circular
 * orbit. This is an ENERGY fraction, comparable across bodies: an equatorial
 * airless surface is ~0.32, not 1.0, because the Sun is below the horizon half
 * the time and never overhead at night.
 *
 * It ignores terrain shadowing, which matters enormously at the lunar poles.
 * Published polar values are usually "fraction of the year sunlit", a
 * different quantity, so they are reported separately and never substituted
 * into the energy score.
 */
export function geometricSolarFraction(body, latDeg) {
  const eps = (OBLIQUITY_DEG[body] ?? 23.44) * (Math.PI / 180);
  const phi = (latDeg * Math.PI) / 180;
  let sum = 0;
  let n = 0;
  for (let day = 0; day < 365; day += 3) {
    const decl = eps * Math.sin((2 * Math.PI * (day - 80)) / 365.25);
    const cosH0 = -Math.tan(phi) * Math.tan(decl);
    const H0 = Math.acos(Math.max(-1, Math.min(1, cosH0)));
    const meanSinElev = (Math.sin(phi) * Math.sin(decl) * H0 + Math.cos(phi) * Math.cos(decl) * Math.sin(H0)) / Math.PI;
    sum += Math.max(0, meanSinElev);
    n += 1;
  }
  return sum / n;
}

/**
 * Effective solar ENERGY resource for a planetary site, as a fraction of the
 * solar constant. Mars is multiplied by an atmospheric transmission factor for
 * a typical dust optical depth (a documented assumption, not a measurement).
 * A published polar illumination-time fraction, when present, is returned
 * separately as `publishedIllumination` and is NOT used in scoring.
 */
export function effectiveSolar(site) {
  const geo = geometricSolarFraction(site.body, site.lat);
  const transmission = site.body === 'mars' ? 0.75 : 1;
  return {
    value: geo * transmission,
    uncertainty: site.body === 'mars' ? 0.15 : 0.12,
    evidence: 'modeled',
    note:
      site.body === 'mars'
        ? 'Modelled annual mean surface insolation as a fraction of the solar constant, multiplied by a typical dust transmission factor of 0.75. Not a measured insolation record.'
        : 'Modelled annual mean surface insolation as a fraction of the solar constant for a flat, unobstructed surface. Terrain shadowing and low Sun angles at the poles reduce the true energy yield.',
    publishedIllumination: site.solarOverride || null,
  };
}

/**
 * Absolute mean surface irradiance, W/m², from the same 24-hour geometric
 * fraction used by the solar-resource factor. Mars includes a documented 0.75
 * dust-transmission assumption. This is a modelled annual mean, not a measured
 * pyranometer record, and is deliberately separate from relative solar fraction.
 */
export function meanSurfaceIrradiance(site) {
  if (!site?.body || site.lat === null || site.lat === undefined) return null;
  const toa = topOfAtmosphereIrradiance(site.body);
  if (toa === null) return null;
  const solar = effectiveSolar(site);
  return {
    value: Number((solar.value * toa).toFixed(1)),
    uncertainty: Number((solar.uncertainty * toa).toFixed(1)),
    evidence: 'modeled',
    note: `Annual mean surface irradiance = ${Math.round(toa)} W/m² top-of-atmosphere × ${Math.round(solar.value * 100)}% 24-hour geometric fraction${site.body === 'mars' ? ' × 0.75 dust transmission' : ''}. Modelled, not a measured irradiance record.`,
  };
}

export function marsPressureKPa(elevationM) {
  if (elevationM === null || elevationM === undefined) return null;
  // Barometric approximation, scale height 11.1 km, datum pressure 0.699 kPa.
  return 0.699 * Math.exp(-elevationM / 11100);
}
