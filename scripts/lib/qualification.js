'use strict';

//
// Experimental qualification variables for the batch harness.
//
// The quote form asks qualification questions that the source CSV does not
// carry. For controlled testing those are generated to fixed distributions.
//
// These values are EXPERIMENTAL INPUT VARIABLES, not assertions about a person.
// Every generated value is returned alongside the run so the report records
// exactly what was submitted for each test record.
//
// Every string here is the form's ACTUAL vocabulary, read off the live funnel
// with scripts/probeFunnelVocabulary.js rather than assumed:
//
//   #/credit-score   ["700+ Excellent","700-640 Good","640-560 Fair","560- Poor"]
//   #/coverage-amount ["$25,000 (Funeral Expenses)", ...]
//   #/gender         ["Male","Female","Non-Binary"]
//   #/height         a <select> of INCHES as strings, "55".."83"
//   #/weight         an angularjs-slider (role=slider), min 100 max 400
//

// ---------------------------------------------------------------------------
// Seedable RNG, so a batch can be reproduced exactly from its recorded seed.
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Pick one entry from [[value, weight], ...].
 *
 * Weights do not have to sum to 100: the total is normalized, which is what
 * makes the documented female height table usable (see HEIGHT_FEMALE).
 */
function weightedPick(table, rng) {
  const total = table.reduce((sum, [, w]) => sum + w, 0);
  if (!(total > 0)) throw new Error('weightedPick: weights must sum to more than zero');
  let roll = rng() * total;
  for (const [value, weight] of table) {
    roll -= weight;
    if (roll < 0) return value;
  }
  return table[table.length - 1][0];
}

function uniformInt(lo, hi, rng) {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

// ---------------------------------------------------------------------------
// Static fields. Every submission sends exactly these.
// ---------------------------------------------------------------------------

const STATIC_ANSWERS = Object.freeze({
  military: 'No',
  cancer: 'No',
  heartDisease: 'No',
  coverageAmount: '$25,000 (Funeral Expenses)',
});

// ---------------------------------------------------------------------------
// Weighted fields.
// ---------------------------------------------------------------------------

const CURRENTLY_INSURED = [['No', 90], ['Yes', 10]];
const MARRIED = [['No', 50], ['Yes', 50]];
const HOMEOWNER = [['Yes', 70], ['No', 30]];
const TOBACCO = [['No', 95], ['Yes', 5]];

// The live form offers four tiers, not the five in the original specification,
// so the spec's "or target form exact drop-down values" applies. Uniform.
const CREDIT_TIERS = ['700+ Excellent', '700-640 Good', '640-560 Fair', '560- Poor'];

// Heights are expressed in the source specification as feet/inches and are
// submitted as inches, because that is what the form's <select> contains.
const IN = (feet, inches) => String(feet * 12 + inches);

// Sums to exactly 100.
const HEIGHT_MALE = [
  [IN(5, 10), 25], [IN(6, 0), 20], [IN(5, 11), 20], [IN(5, 9), 17],
  [IN(5, 8), 11], [IN(6, 3), 3], [IN(6, 4), 2], [IN(5, 7), 2],
];

// NOTE: as specified these weights sum to 110, not 100. They are used as
// relative weights and normalized by weightedPick, which preserves every ratio
// in the specification. The normalization is reported, not hidden - see
// describeDistributions().
const HEIGHT_FEMALE = [
  [IN(5, 4), 15], [IN(5, 3), 15], [IN(5, 2), 12], [IN(5, 1), 10],
  [IN(5, 0), 8], [IN(5, 7), 10], [IN(5, 6), 10], [IN(5, 5), 10],
  [IN(5, 11), 5], [IN(5, 10), 5], [IN(5, 9), 5], [IN(5, 8), 5],
];

const WEIGHT_RANGE = { male: [155, 275], female: [120, 210] };

// A row whose gender is neither male nor female still has to be given a height
// and weight, because the form requires both. Rather than silently borrowing
// one gender's table, such a row draws from the union of both and is flagged in
// the record so the report shows the substitution happened.
const HEIGHT_OTHER = [...HEIGHT_MALE, ...HEIGHT_FEMALE];
const WEIGHT_OTHER = [120, 275];

function heightTableFor(gender) {
  if (gender === 'male') return HEIGHT_MALE;
  if (gender === 'female') return HEIGHT_FEMALE;
  return HEIGHT_OTHER;
}

function weightRangeFor(gender) {
  return WEIGHT_RANGE[gender] || WEIGHT_OTHER;
}

/**
 * Generate one test record's qualification variables.
 *
 * `gender` is the normalized lowercase value from the CSV.
 * Returns both the values and the provenance of each, so the run report can
 * state which were fixed, which were drawn, and from what.
 */
function generateQualification(gender, rng = Math.random) {
  const normalized = String(gender || '').toLowerCase();
  const known = normalized === 'male' || normalized === 'female';

  const height = weightedPick(heightTableFor(normalized), rng);
  const [wLo, wHi] = weightRangeFor(normalized);
  const weight = uniformInt(wLo, wHi, rng);

  return {
    // static
    military: STATIC_ANSWERS.military,
    cancer: STATIC_ANSWERS.cancer,
    heartDisease: STATIC_ANSWERS.heartDisease,
    coverageAmount: STATIC_ANSWERS.coverageAmount,
    // weighted
    currentlyInsured: weightedPick(CURRENTLY_INSURED, rng),
    married: weightedPick(MARRIED, rng),
    homeowner: weightedPick(HOMEOWNER, rng),
    tobacco: weightedPick(TOBACCO, rng),
    creditScore: CREDIT_TIERS[Math.floor(rng() * CREDIT_TIERS.length)],
    heightInches: height,
    heightLabel: Math.floor(Number(height) / 12) + "'" + (Number(height) % 12) + '"',
    weightLbs: String(weight),
    // provenance
    genderBasis: known ? normalized : 'unspecified (drew from the combined table)',
    weightRange: [wLo, wHi],
  };
}

/**
 * Map generated qualification values onto the funnel's hash routes, in the
 * shape the runner's answer lookup expects.
 */
function toFunnelAnswers(qualification, gender) {
  const g = String(gender || '').toLowerCase();
  const genderChoice = g === 'male' ? 'Male' : g === 'female' ? 'Female' : 'Non-Binary';
  return {
    '#/gender': genderChoice,
    '#/currently-insured': qualification.currentlyInsured,
    '#/credit-score': qualification.creditScore,
    '#/marriage-status': qualification.married,
    '#/homeowner': qualification.homeowner,
    '#/va-loan': qualification.military,
    '#/tobacco-use': qualification.tobacco,
    '#/cancer': qualification.cancer,
    '#/heart-disease': qualification.heartDisease,
    '#/coverage-amount': qualification.coverageAmount,
  };
}

/** Human-readable statement of the distributions actually in force. */
function describeDistributions() {
  const pct = (table) => {
    const total = table.reduce((s, [, w]) => s + w, 0);
    return table.map(([v, w]) => v + '=' + (Math.round((w / total) * 1000) / 10) + '%').join(' ');
  };
  return [
    'static:            military=No cancer=No heartDisease=No coverage="' + STATIC_ANSWERS.coverageAmount + '"',
    'currentlyInsured:  ' + pct(CURRENTLY_INSURED),
    'married:           ' + pct(MARRIED),
    'homeowner:         ' + pct(HOMEOWNER),
    'tobacco:           ' + pct(TOBACCO),
    'creditScore:       uniform over ' + JSON.stringify(CREDIT_TIERS),
    'height male (in):  ' + pct(HEIGHT_MALE),
    'height female(in): ' + pct(HEIGHT_FEMALE)
      + '   [specified weights sum to '
      + HEIGHT_FEMALE.reduce((s, [, w]) => s + w, 0) + ', normalized to 100]',
    'weight:            male ' + WEIGHT_RANGE.male.join('-') + ' lbs, female '
      + WEIGHT_RANGE.female.join('-') + ' lbs (uniform integer)',
  ].join('\n');
}

module.exports = {
  mulberry32,
  weightedPick,
  uniformInt,
  generateQualification,
  toFunnelAnswers,
  describeDistributions,
  STATIC_ANSWERS,
  CREDIT_TIERS,
  CURRENTLY_INSURED,
  MARRIED,
  HOMEOWNER,
  TOBACCO,
  HEIGHT_MALE,
  HEIGHT_FEMALE,
  WEIGHT_RANGE,
};
