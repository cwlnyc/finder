// Borough lookup by ZIP.
//
// DCWP leaves `address_borough` blank on roughly a third of records, and every
// blank one turns out to be a business outside the five boroughs -- Yonkers,
// Long Island, New Jersey, upstate. A blank cell reads as missing data; what it
// actually means is "not in NYC", which is a fact worth selling.

// Ranges are inclusive. Anything that is a real five-digit ZIP but outside all
// of them is genuinely not in the city.
const RANGES = [
  ['Manhattan', [[10001, 10282]]],
  ['Staten Island', [[10301, 10314]]],
  ['Bronx', [[10451, 10475]]],
  ['Brooklyn', [[11201, 11256]]],
  ['Queens', [[11004, 11005], [11101, 11120], [11351, 11390], [11411, 11436], [11691, 11697]]],
];

export const OUTSIDE = 'Outside NYC';

/**
 * The borough a ZIP falls in, `OUTSIDE` for a valid ZIP that is not in the
 * city, or '' when the ZIP is missing or malformed -- unknown is not the same
 * as outside, and guessing either way would be worse than a blank.
 */
export function boroughFromZip(zip) {
  const digits = String(zip ?? '').trim().slice(0, 5);
  if (!/^\d{5}$/.test(digits)) return '';
  const n = Number(digits);
  for (const [borough, ranges] of RANGES) {
    if (ranges.some(([lo, hi]) => n >= lo && n <= hi)) return borough;
  }
  return OUTSIDE;
}

/**
 * Fill in a blank borough from the ZIP, leaving a recorded one untouched.
 *
 * Applied when rows are read rather than when they are written, so a store
 * pulled before this existed gets the benefit without being re-downloaded.
 */
export function withArea(row) {
  if (row.borough && row.borough.trim() !== '') return row;
  const derived = boroughFromZip(row.zip);
  return derived ? { ...row, borough: derived } : row;
}
