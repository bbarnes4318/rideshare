'use strict';
//
// Shared implementation behind the production funnel runner and the behavioral
// test harness.
//
// Everything here was moved verbatim out of scripts/submitProductionFunnel.js
// (commit dbea0d6), which is the runner that produced the known-good NJ
// submission. It lives in one module so the harness drives the *same* IPRoyal
// targeting, ZIP resolution, sticky-session selection, TrustedForm wait and
// TrustedForm capture as production, instead of a copy that can drift.
//
// Nothing in this file changes that behavior. New behavior belongs in the
// harness, not here.

const fs = require('fs');
const {
  probeProxyConnect,
  describeProxyFailure,
  lookupIpGeo,
  fetchThroughProxy,
} = require('../proxyDiagnostics');

const TARGET_URL = process.env.PRODUCTION_FUNNEL_URL || 'https://quotes.nationallifecoverage.org/';
const PROXY_HOST = process.env.IPROYAL_PROXY_HOST || 'geo.iproyal.com';
const PROXY_PORT = Number(process.env.IPROYAL_PROXY_PORT || 12321);
const IP_CHECK_URL = process.env.PROXY_IP_CHECK_URL || 'https://ipv4.icanhazip.com';
const SESSION_PROBE_URL = process.env.PROXY_SESSION_PROBE_URL || 'http://ipv4.icanhazip.com';
const SESSION_ATTEMPTS = Number(process.env.IPROYAL_SESSION_ATTEMPTS || 8);
const SESSION_LIFETIME_MINUTES = Number(process.env.IPROYAL_SESSION_LIFETIME_MINUTES || 30);

const zipcodes = require('zipcodes');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

function hasFlag(name) {
  return process.argv.includes('--' + name);
}

function required(name, value) {
  if (value === undefined || value === null || value === '') {
    throw new Error('Missing required value: ' + name);
  }
  return String(value);
}

// IPRoyal location tokens are lowercase alphanumeric with NO separator:
// "_city-losangeles" resolves, "_city-los-angeles" is refused outright.
function normalizeProxyToken(value) {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// IPRoyal documents targeting as country + city with no state token, and that
// lands more accurately than adding one. Widen only if a tier has no peers.
const TARGETING_TIERS = [
  { name: 'city (IPRoyal country+city form)', state: false, city: true },
  { name: 'state only', state: true, city: false },
  { name: 'country only', state: false, city: false },
];

function getZipTarget(zip) {
  const normalizedZip = String(zip).trim().slice(0, 5);
  const location = zipcodes.lookup(normalizedZip);
  if (!location) throw new Error('ZIP ' + normalizedZip + ' could not be resolved locally.');
  return {
    zip: normalizedZip,
    city: location.city,
    state: location.state,
    stateName: zipcodes.states.abbr[location.state] || location.state,
    latitude: location.latitude,
    longitude: location.longitude,
  };
}

function buildProxyPassword(basePassword, location, session, tier = TARGETING_TIERS[0]) {
  const tokens = [basePassword, 'country-us'];
  if (tier.state) tokens.push('state-' + normalizeProxyToken(location.stateName));
  if (tier.city) tokens.push('city-' + normalizeProxyToken(location.city));
  // Pin one peer for the whole run; IPRoyal otherwise rotates per request and
  // TrustedForm would observe several different source IPs in one session.
  if (session) tokens.push('session-' + session, 'lifetime-' + SESSION_LIFETIME_MINUTES + 'm');
  return tokens.join('_');
}

async function selectResidentialSession({ host, port, username, basePassword, location }) {
  let fallback = null;
  for (const tier of TARGETING_TIERS) {
    console.log('  targeting: ' + tier.name);
    let anyEgress = false;
    for (let attempt = 1; attempt <= SESSION_ATTEMPTS; attempt += 1) {
      const session = 'nlc' + Math.random().toString(36).slice(2, 10);
      const password = buildProxyPassword(basePassword, location, session, tier);
      const result = await fetchThroughProxy({ host, port, username, password, url: SESSION_PROBE_URL });
      if (!result.ok || !/^\d{1,3}(\.\d{1,3}){3}$/.test(result.body)) {
        console.log('    probe ' + attempt + '/' + SESSION_ATTEMPTS + ': no usable egress ('
          + (result.error || 'HTTP ' + result.statusCode) + ')');
        continue;
      }
      anyEgress = true;
      const ip = result.body;
      const geo = await lookupIpGeo(ip);
      const cityMatch = geo && normalizeProxyToken(geo.city) === normalizeProxyToken(location.city);
      const stateMatch = geo && normalizeProxyToken(geo.regionName) === normalizeProxyToken(location.stateName);
      console.log('    probe ' + attempt + '/' + SESSION_ATTEMPTS + ': ' + ip + ' -> '
        + (geo ? geo.city + ', ' + geo.regionName : 'unknown location'));
      if (cityMatch && stateMatch) {
        console.log('  matched ' + location.city + ', ' + location.state + ' via ' + tier.name);
        return { session, password, ip, geo, match: 'city + state matched', tier: tier.name };
      }
      if (stateMatch && (!fallback || fallback.match !== 'state matched, city did not')) {
        fallback = { session, password, ip, geo, match: 'state matched, city did not', tier: tier.name };
      } else if (!fallback) {
        fallback = { session, password, ip, geo, match: 'NOT matched - wider pool', tier: tier.name };
      }
    }
    if (!anyEgress) { console.log('  no peers for ' + tier.name + '; widening'); continue; }
    if (fallback && fallback.match === 'state matched, city did not') break;
  }
  if (!fallback) throw new Error('No usable IPRoyal residential session for ' + location.city + ', ' + location.state);
  console.log('  no exact city match; using best available (' + fallback.match + ')');
  return fallback;
}

// Account check first (402 = no balance, 407 = bad credentials).
async function preflightProxy({ host, port, username, basePassword, location, ipCheckUrl }) {
  const probeTarget = new URL(ipCheckUrl || IP_CHECK_URL);
  const probe = await probeProxyConnect({
    host,
    port,
    username,
    password: buildProxyPassword(basePassword, location, null, TARGETING_TIERS[TARGETING_TIERS.length - 1]),
    target: probeTarget.hostname + ':' + (probeTarget.port || 443),
  });
  if (!probe.ok) throw new Error(describeProxyFailure(probe));
  return probe;
}

async function waitForTrustedFormCert(page, timeout = 45000) {
  await page.waitForFunction(() => {
    const f = document.querySelector('input[name=xxTrustedFormCertUrl]');
    return f && /^https?:\/\//i.test(f.value || '');
  }, { timeout });
  return page.evaluate(() => document.querySelector('input[name=xxTrustedFormCertUrl]').value);
}

/**
 * Record everything the browser exchanges with TrustedForm.
 *
 * Same listeners the production runner installs for `--capture <file>`; the
 * returned array is the `events` array that ends up in the capture file.
 */
function attachTrustedFormCapture(page) {
  const captured = [];
  page.on('request', (req) => {
    if (!/trustedform/i.test(req.url())) return;
    captured.push({ dir: 'REQ', method: req.method(), url: req.url(), type: req.resourceType(), post: req.postData() || null });
  });
  page.on('response', async (res) => {
    if (!/trustedform/i.test(res.url())) return;
    let body = null;
    try {
      const ct = res.headers()['content-type'] || '';
      if (/json|text/i.test(ct)) body = (await res.text()).slice(0, 2000);
    } catch { /* body unavailable */ }
    captured.push({ dir: 'RES', status: res.status(), url: res.url(), body });
  });
  return captured;
}

function writeCapture(capturePath, { certUrl, observedIp, observedGeo, finalUrl, events }) {
  fs.writeFileSync(capturePath, JSON.stringify({
    certUrl,
    certId: certIdFromUrl(certUrl),
    egressIp: observedIp,
    egressGeo: observedGeo ? observedGeo.city + ', ' + observedGeo.regionName + ', ' + observedGeo.isp : null,
    pageUrl: finalUrl,
    events,
  }, null, 1));
  return events.length;
}

function certIdFromUrl(certUrl) {
  return certUrl ? String(certUrl).split('/').pop() : null;
}

function resolveBrowserPath() {
  const browserPath = process.env.CHROME_EXECUTABLE_PATH || process.env.CHROMIUM_EXECUTABLE_PATH;
  if (!browserPath) throw new Error('Set CHROME_EXECUTABLE_PATH to a local Chromium/Chrome executable.');
  return browserPath;
}

const LAUNCH_ARGS = [
  '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
  '--disable-background-networking', '--disable-extensions', '--renderer-process-limit=2',
];

// ---------------------------------------------------------------------------
// Production funnel DOM contract.
//
// Moved verbatim from submitProductionFunnel.js. The wizard is AngularJS and
// hash-routed: each step is either a set of choice links (<a> elements) or
// input fields followed by <a class="btn-next">. Answers are keyed by the
// step's hash route, read off the live funnel.
//
// NOTE: these are the PRODUCTION funnel's selectors. The #zip / #gender /
// #date_of_birth / #submit-button / #response-message ids belong to this
// repository's self-hosted index.html, which quotes.nationallifecoverage.org
// does not serve.
// ---------------------------------------------------------------------------

const CSS_ID = (id) => '[id="' + id + '"]';

function buildAnswers() {
  return {
    '#/gender': arg('gender', 'Male'),
    '#/currently-insured': arg('currently-insured', 'No'),
    '#/credit-score': arg('credit', '700-640 Good'),
    '#/marriage-status': arg('marital', 'No'),
    '#/homeowner': arg('homeowner', 'No'),
    '#/va-loan': arg('military', 'No'),
    '#/tobacco-use': arg('tobacco', 'No'),
    '#/cancer': arg('cancer', 'No'),
    '#/heart-disease': arg('heart-disease', 'No'),
    '#/coverage-amount': arg('coverage', '$25,000 (Funeral Expenses)'),
  };
}

const readStep = () => {
  const vis = (e) => !!(e.offsetParent || e.getClientRects().length);
  const isQ = (e) => vis(e) && e.children.length === 0 && (e.textContent || '').trim().endsWith('?');
  return {
    hash: location.hash || '#/',
    question: ([...document.querySelectorAll('h1,h2,h3,p,label,div,span')].filter(isQ)[0] || {})
      .textContent?.trim().slice(0, 90) || '',
    fields: [...document.querySelectorAll('input,select,textarea')].filter(vis).map((e) => ({
      tag: e.tagName.toLowerCase(), type: e.type || '', id: e.id || '', name: e.name || '',
      ph: e.placeholder || '',
      opts: e.tagName === 'SELECT' ? [...e.options].map((o) => o.value) : undefined,
    })),
    choices: [...document.querySelectorAll('a')].filter(vis)
      .map((e) => (e.textContent || '').trim())
      .filter((t) => t && t.length < 40 && !/call now|888-|privacy|terms|do not sell|^X$/i.test(t)),
    tfCert: document.querySelector('input[name=xxTrustedFormCertUrl]')?.value || null,
  };
};

/**
 * Decide what a single field on the current step should receive.
 *
 * This is the exact key->lead mapping the production runner has always used;
 * only the delivery differs (production fills, the harness types), so both
 * agree on which field gets which value.
 */
function planField(field, lead) {
  const key = (field.id || field.name).toLowerCase();
  const selector = field.id ? CSS_ID(field.id) : '[name="' + field.name + '"]';
  if (field.tag === 'select') {
    const real = (field.opts || []).filter((v) => v !== '');
    if (!real.length) return null;
    let value = real[0];
    // Angular emits "string:N" month values, zero-based.
    if (key.includes('month')) value = real[lead.birthMonth - 1] || real[0];
    else if (key.includes('height')) value = real.includes(lead.height) ? lead.height : real[0];
    return { kind: 'select', key, selector, value };
  }
  let value = null;
  if (key.includes('zip')) value = lead.zip;
  else if (key.includes('day')) value = lead.birthDay;
  else if (key.includes('year')) value = lead.birthYear;
  else if (key.includes('height')) value = lead.height;
  else if (key.includes('weight')) value = lead.weight;
  else if (key.includes('address')) value = lead.address;
  else if (key.includes('firstname')) value = lead.fname;
  else if (key.includes('lastname')) value = lead.lname;
  else if (key.includes('email')) value = lead.email;
  else if (key.includes('phone')) value = lead.phone;
  if (value === null) return null;
  return { kind: 'text', key, selector, value: String(value) };
}

/** The contact step is the one carrying the identity fields. */
function isFinalStep(fields) {
  return fields.some((f) => /email|phone|firstname|lastname/i.test(f.id + f.name));
}

/**
 * Build the test lead from --flags, falling back to the TEST_* environment
 * variables. No test data is hard-coded here or anywhere in the app.
 */
function buildLead(location) {
  const dob = required('--dob', arg('dob', process.env.TEST_DOB));
  const dobParts = dob.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!dobParts) throw new Error('--dob must be MM/DD/YYYY, got "' + dob + '"');
  return {
    zip: location.zip,
    birthMonth: Number(dobParts[1]),
    birthDay: dobParts[2],
    birthYear: dobParts[3],
    height: arg('height', '70'),
    weight: arg('weight', '160'),
    address: required('--address', arg('address', process.env.TEST_ADDRESS)),
    fname: required('--fname', arg('fname', process.env.TEST_FNAME)),
    lname: required('--lname', arg('lname', process.env.TEST_LNAME)),
    email: required('--email', arg('email', process.env.TEST_EMAIL)),
    phone: required('--phone', arg('phone', process.env.TEST_PHONE)),
  };
}

module.exports = {
  TARGET_URL,
  PROXY_HOST,
  PROXY_PORT,
  IP_CHECK_URL,
  SESSION_PROBE_URL,
  SESSION_ATTEMPTS,
  SESSION_LIFETIME_MINUTES,
  LAUNCH_ARGS,
  TARGETING_TIERS,
  arg,
  hasFlag,
  required,
  normalizeProxyToken,
  getZipTarget,
  buildProxyPassword,
  selectResidentialSession,
  preflightProxy,
  waitForTrustedFormCert,
  attachTrustedFormCapture,
  writeCapture,
  certIdFromUrl,
  resolveBrowserPath,
  lookupIpGeo,
  CSS_ID,
  buildAnswers,
  readStep,
  planField,
  isFinalStep,
  buildLead,
};
