'use strict';
//
// Shared implementation behind the production funnel runner and the behavioral
// test harness.
//
// Everything here was moved verbatim out of scripts/submitProductionFunnel.js
// (commit dbea0d6), which is the runner that produced the known-good NJ
// submission. It lives in one module so the harness drives the *same* residential
// targeting, ZIP resolution, sticky-session selection, TrustedForm wait and
// TrustedForm capture as production, instead of a copy that can drift.
//
// The targeting is encoded by the active provider in scripts/lib/proxyProviders.js.
// The walk below - tier ladder, attempt loop, ip-api verification, and handing the
// browser the very session that was probed - is the same for every provider.
//
// Nothing in this file changes that behavior. New behavior belongs in the
// harness, not here.

const fs = require('fs');
const {
  probeProxyConnect,
  lookupIpGeo,
  fetchThroughProxy,
} = require('../proxyDiagnostics');
const { resolveProvider } = require('./proxyProviders');

// Which residential vendor this process talks to. Resolved once, here, so a
// single run cannot end up half on one provider and half on another; an
// unknown PROXY_PROVIDER throws at startup rather than defaulting silently.
const PROXY_PROVIDER = resolveProvider();

const TARGET_URL = process.env.PRODUCTION_FUNNEL_URL || 'https://quotes.nationallifecoverage.org/';
const PROXY_HOST = PROXY_PROVIDER.host;
const PROXY_PORT = PROXY_PROVIDER.port;
const IP_CHECK_URL = process.env.PROXY_IP_CHECK_URL || 'https://ipv4.icanhazip.com';
const SESSION_PROBE_URL = process.env.PROXY_SESSION_PROBE_URL || 'http://ipv4.icanhazip.com';
const SESSION_ATTEMPTS = PROXY_PROVIDER.sessionAttempts;
// IPRoyal's lifetime specifically, and only reachable through buildProxyPassword
// below. Geonode has its own minutes value and Shifter counts in seconds; both
// read theirs from the provider object, so nothing else should consult this.
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

// Compares two place names for equality, ignoring case and separators, so
// "Jersey City" from the zipcodes package and "Jersey City" from ip-api agree.
// This is a COMPARISON helper, not a targeting-token builder: the per-vendor
// slugs live in scripts/lib/proxyProviders.js and differ from each other.
function normalizeProxyToken(value) {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Narrowest first; supplied by the active provider. Both vendors' ladders are
// the same three rungs - exact city, state only, then a country floor that
// always completes - so the walk below is identical either way.
const TARGETING_TIERS = PROXY_PROVIDER.tiers;

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

/**
 * Build the auth pair the active provider needs for one targeted, sticky
 * session. BOTH halves matter: IPRoyal encodes targeting in the password, while
 * Geonode and Shifter encode it in the username. A caller that keeps a static
 * username and uses only the password therefore gets an untargeted Geonode or
 * Shifter session that still succeeds - with an IP from the wrong city and no
 * error anywhere.
 */
function buildProxyCredentials(username, basePassword, location, session, tier = TARGETING_TIERS[0]) {
  return PROXY_PROVIDER.buildCredentials({
    username, password: basePassword, location, session, tier,
  });
}

// Password half only. Kept because the IPRoyal password format is asserted
// verbatim by test/unit.js, and because nothing but IPRoyal ever needed it.
function buildProxyPassword(basePassword, location, session, tier = TARGETING_TIERS[0]) {
  return buildProxyCredentials('', basePassword, location, session, tier).password;
}

// `log` is injected rather than assumed: batch rows now run several at a time,
// and every line below belongs to one specific row. The caller passes a logger
// that prefixes it with that row's number; alone on a terminal it is console.log.
async function selectResidentialSession({ host, port, username, basePassword, location, log = console.log }) {
  let fallback = null;
  for (const tier of TARGETING_TIERS) {
    log('  targeting: ' + tier.name);
    let anyEgress = false;
    for (let attempt = 1; attempt <= SESSION_ATTEMPTS; attempt += 1) {
      // Unique per attempt, and therefore per row: Shifter documents that a
      // sid must not be shared across concurrent workflows, and Geonode that a
      // reused session id resolves to the *existing* sticky session rather than
      // a new one. A batch runs up to 8 rows at once. The id stays within
      // Geonode's 1-25 alphanumeric/underscore limit; test/unit.js asserts it.
      const session = 'nlc' + Math.random().toString(36).slice(2, 10);
      const creds = buildProxyCredentials(username, basePassword, location, session, tier);
      const result = await fetchThroughProxy({
        host, port, username: creds.username, password: creds.password, url: SESSION_PROBE_URL,
      });
      if (!result.ok || !/^\d{1,3}(\.\d{1,3}){3}$/.test(result.body)) {
        log('    probe ' + attempt + '/' + SESSION_ATTEMPTS + ': no usable egress ('
          + (result.error || 'HTTP ' + result.statusCode) + ')');
        continue;
      }
      anyEgress = true;
      const ip = result.body;
      const geo = await lookupIpGeo(ip);
      const cityMatch = geo && normalizeProxyToken(geo.city) === normalizeProxyToken(location.city);
      const stateMatch = geo && normalizeProxyToken(geo.regionName) === normalizeProxyToken(location.stateName);
      log('    probe ' + attempt + '/' + SESSION_ATTEMPTS + ': ' + ip + ' -> '
        + (geo ? geo.city + ', ' + geo.regionName : 'unknown location'));
      // The browser is launched on this exact session, so it must carry both
      // halves of the auth pair the probe used - see buildProxyCredentials.
      const selected = (match) => ({
        session,
        username: creds.username,
        password: creds.password,
        ip,
        geo,
        match,
        tier: tier.name,
        provider: PROXY_PROVIDER.id,
        strict: !!tier.strict,
      });
      if (cityMatch && stateMatch) {
        log('  matched ' + location.city + ', ' + location.state + ' via ' + tier.name);
        return selected('city + state matched');
      }
      if (stateMatch && (!fallback || fallback.match !== 'state matched, city did not')) {
        fallback = selected('state matched, city did not');
      } else if (!fallback) {
        fallback = selected('NOT matched - wider pool');
      }
    }
    if (!anyEgress) { log('  no peers for ' + tier.name + '; widening'); continue; }
    if (fallback && fallback.match === 'state matched, city did not') break;
  }
  if (!fallback) {
    throw new Error('No usable ' + PROXY_PROVIDER.id + ' residential session for '
      + location.city + ', ' + location.state);
  }
  log('  no exact city match; using best available (' + fallback.match + ')');
  return fallback;
}

/**
 * Account check before any browser starts, on the widest tier so that a
 * momentarily empty city cannot be mistaken for a broken account. The failure
 * text is the provider's, because the status codes mean different things to
 * each of them (Geonode 465 = nothing matched; IPRoyal 402 = no balance;
 * Shifter 400 = bad targeting flag).
 */
async function preflightProxy({ host, port, username, basePassword, location, ipCheckUrl }) {
  const probeTarget = new URL(ipCheckUrl || IP_CHECK_URL);
  const widest = TARGETING_TIERS[TARGETING_TIERS.length - 1];
  const creds = buildProxyCredentials(username, basePassword, location, null, widest);
  const probe = await probeProxyConnect({
    host,
    port,
    username: creds.username,
    password: creds.password,
    target: probeTarget.hostname + ':' + (probeTarget.port || 443),
  });
  if (!probe.ok) throw new Error(PROXY_PROVIDER.describeFailure(probe));
  return probe;
}

/**
 * The active provider's credentials, read from the env vars that provider
 * documents. Call sites used to name IPROYAL_* directly, which silently kept
 * them on IPRoyal's variables after the provider switch.
 */
function proxyCredentialsFromEnv() {
  return {
    username: required(PROXY_PROVIDER.usernameEnv, process.env[PROXY_PROVIDER.usernameEnv]),
    basePassword: required(PROXY_PROVIDER.passwordEnv, process.env[PROXY_PROVIDER.passwordEnv]),
  };
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
  PROXY_PROVIDER,
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
  buildProxyCredentials,
  proxyCredentialsFromEnv,
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
