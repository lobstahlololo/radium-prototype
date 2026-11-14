/**
 * RADIUM grading primitives.
 *
 * RADIUM reports letter grades in the interface and keeps numeric values
 * internally for sorting. The bands below are RADIUM-defined and are NOT an
 * official NASA certification. They are documented in docs/METHODOLOGY.md and
 * tested in tests/science.test.mjs.
 */

export const GRADE_BANDS = [
  { min: 80, letter: 'A', label: 'Excellent', blurb: 'Strongly favourable under the selected criteria.' },
  { min: 65, letter: 'B', label: 'Good', blurb: 'Generally favourable with manageable caveats.' },
  { min: 50, letter: 'C', label: 'Moderate', blurb: 'Mixed evidence; notable limitations apply.' },
  { min: 35, letter: 'D', label: 'Poor', blurb: 'Significant limiting factors dominate.' },
  { min: 0, letter: 'F', label: 'Very poor', blurb: 'Critical limitations or a failed hard constraint.' },
];

export const UNRATED = '—';

export function clamp(n, lo = 0, hi = 1) {
  return Math.min(hi, Math.max(lo, n));
}

export function clamp01(n) {
  return clamp(n, 0, 1);
}

/** Letter grade for a 0-100 score. Returns UNRATED for null/NaN. */
export function letterGrade(score) {
  if (score === null || score === undefined || Number.isNaN(score)) return UNRATED;
  const s = clamp(score, 0, 100);
  for (const band of GRADE_BANDS) {
    if (s >= band.min) return band.letter;
  }
  return 'F';
}

export function gradeMeta(letter) {
  return GRADE_BANDS.find((b) => b.letter === letter) || { letter: UNRATED, label: 'Unrated', blurb: 'Insufficient data coverage for a grade.' };
}

/**
 * Piecewise-linear interpolation over ascending [x, y] anchors.
 * Values outside the anchor range clamp to the end values.
 */
export function piecewise(x, anchors) {
  if (x === null || x === undefined || Number.isNaN(x)) return null;
  if (!Array.isArray(anchors) || anchors.length === 0) return null;
  if (x <= anchors[0][0]) return anchors[0][1];
  const last = anchors[anchors.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < anchors.length; i += 1) {
    const [x1, y1] = anchors[i - 1];
    const [x2, y2] = anchors[i];
    if (x <= x2) {
      const t = (x - x1) / (x2 - x1 || 1);
      return y1 + t * (y2 - y1);
    }
  }
  return last[1];
}

/** Rounds for display only; internal values keep full precision. */
export function round(n, digits = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** Formats a value with unit, or the literal "Data unavailable." */
export function fmt(value, unit = '', digits = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'Data unavailable.';
  const num = typeof value === 'number' ? round(value, digits) : value;
  return unit ? `${num} ${unit}` : String(num);
}

export function confidenceLabel(confidence) {
  if (confidence === null || confidence === undefined) return 'Unknown';
  if (confidence >= 0.75) return 'High';
  if (confidence >= 0.5) return 'Medium';
  return 'Low';
}
