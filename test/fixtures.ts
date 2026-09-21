// Shared test data: real element sets with published or well-known values, and a builder for
// synthetic ones so a test can place objects on orbits it controls.

/**
 * Vallado's SGP4 verification case 00005 ("Revisiting Spacetrack Report #3", 2006), the standard
 * test every SGP4 implementation is checked against. Expected TEME states are from its published output.
 */
export const VALLADO_00005 = {
  line1: '1 00005U 58002B   00179.78495062  .00000023  00000-0  28098-4 0  4753',
  line2: '2 00005  34.2682 348.7242 1859667 331.7664  19.3264 10.82419157413667',
  expected: [
    { min: 0, r: [7022.46529266, -1400.08296755, 0.03995155], v: [1.893841015, 6.405893759, 4.53480725] },
    { min: 360, r: [-7154.03120202, -3783.17682504, -3536.19412294], v: [4.741887409, -4.151817765, -2.093935425] },
    { min: 720, r: [-7134.59340119, 6531.68641334, 3260.27186483], v: [-4.113793027, -2.911922039, -2.557327851] },
  ],
};

/** The ISS (epoch 2008-09-20), the well-known example element set from Wikipedia's TLE article. */
export const ISS_TLE = `ISS (ZARYA)
1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927
2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537`;

/** Epoch of ISS_TLE as a UTC timestamp. */
export const ISS_EPOCH_MS = Date.UTC(2008, 0, 1) + (264.51782528 - 1) * 86_400_000;

function checksum(line: string): number {
  let sum = 0;
  for (const ch of line) sum += ch === '-' ? 1 : /\d/.test(ch) ? Number(ch) : 0;
  return sum % 10;
}

export interface Elements {
  norad: number;
  /** Epoch as year and fractional day of year (1 = 1 January 00:00 UTC). */
  year: number;
  day: number;
  incDeg: number;
  raanDeg: number;
  ecc: number;
  argpDeg: number;
  meanAnomalyDeg: number;
  /** Revolutions per day. */
  meanMotion: number;
}

/** Build a column-exact two-line element set (no drag) for the given mean elements. */
export function makeTle(e: Elements): [string, string] {
  const id = String(e.norad).padStart(5, '0');
  const epoch = `${String(e.year % 100).padStart(2, '0')}${e.day.toFixed(8).padStart(12, '0')}`;
  const l1 = `1 ${id}U 24001A   ${epoch}  .00000000  00000-0  00000-0 0  999`;
  const ang = (deg: number) => deg.toFixed(4).padStart(8, ' ');
  const ecc = e.ecc.toFixed(7).slice(2);
  const l2 = `2 ${id} ${ang(e.incDeg)} ${ang(e.raanDeg)} ${ecc} ${ang(e.argpDeg)} ${ang(e.meanAnomalyDeg)} ${e.meanMotion.toFixed(8).padStart(11, ' ')}    1`;
  return [l1 + checksum(l1), l2 + checksum(l2)];
}

/** Epoch of a makeTle element set as a UTC timestamp. */
export const epochMs = (e: Pick<Elements, 'year' | 'day'>) => Date.UTC(e.year, 0, 1) + (e.day - 1) * 86_400_000;
