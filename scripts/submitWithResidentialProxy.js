#!/usr/bin/env node

require('dotenv').config();

const { chromium } = require('playwright-core');
const zipcodes = require('zipcodes');
const {
  probeProxyConnect,
  describeProxyFailure,
  lookupIpGeo,
  fetchThroughProxy,
} = require('./proxyDiagnostics');

const TARGET_URL = process.env.TRUSTEDFORM_TARGET_URL || 'https://quotes.nationallifecoverage.org/';
const PROXY_HOST = process.env.IPROYAL_PROXY_HOST || 'geo.iproyal.com';
const PROXY_PORT = Number(process.env.IPROYAL_PROXY_PORT || 12321);
const IP_CHECK_URL = process.env.PROXY_IP_CHECK_URL || 'https://ipv4.icanhazip.com';
// Plain-HTTP probe endpoint: sampling a session's egress IP does not need TLS,
// and avoiding a CONNECT tunnel per probe keeps the shared-CPU host cheap.
const SESSION_PROBE_URL = process.env.PROXY_SESSION_PROBE_URL || 'http://ipv4.icanhazip.com';
const SESSION_ATTEMPTS = Number(process.env.IPROYAL_SESSION_ATTEMPTS || 8);
const SESSION_LIFETIME_MINUTES = Number(process.env.IPROYAL_SESSION_LIFETIME_MINUTES || 30);

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

function required(name, value) {
  if (value === undefined || value === null || value === '') {
    throw new Error(`Missing required value: ${name}`);
  }
  return String(value);
}

// IPRoyal location tokens must be lowercase alphanumeric with NO separator:
// "_state-newyork" and "_city-losangeles" resolve, while "_state-new-york" and
// "_city-los-angeles" are rejected outright (the proxy refuses the tunnel).
// Verified against geo.iproyal.com:12321 on 2026-08-31.
function normalizeProxyToken(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function getZipTarget(zip) {
  const normalizedZip = String(zip).trim().slice(0, 5);
  const location = zipcodes.lookup(normalizedZip);

  if (!location) {
    throw new Error(`ZIP ${normalizedZip} could not be resolved locally.`);
  }

  return {
    zip: normalizedZip,
    city: location.city,
    state: location.state,
    // zipcodes reports the two-letter code (TN); IPRoyal's router expects the
    // spelled-out state name (tennessee) in the password targeting suffix.
    stateName: zipcodes.states.abbr[location.state] || location.state,
    latitude: location.latitude,
    longitude: location.longitude,
  };
}

// IPRoyal's city vocabulary does not always match the zipcodes database (it
// knows New York City as "newyorkcity", and has no peers at all for
// "city-newyork"), and even a valid city can be empty at request time. Degrade
// through progressively wider targets rather than failing the run.
const TARGETING_TIERS = [
  { name: 'city + state', state: true, city: true },
  { name: 'state only', state: true, city: false },
  { name: 'country only', state: false, city: false },
];

function buildProxyPassword(basePassword, location, session, tier = TARGETING_TIERS[0]) {
  const tokens = [basePassword, 'country-us'];

  if (tier.state) tokens.push(`state-${normalizeProxyToken(location.stateName)}`);
  if (tier.city) tokens.push(`city-${normalizeProxyToken(location.city)}`);

  // A sticky session pins one residential peer for the whole run. Without it
  // IPRoyal rotates per request, so the page load, the TrustedForm pings and
  // the /api-proxy/ POST would each egress from a different IP.
  if (session) {
    tokens.push(`session-${session}`, `lifetime-${SESSION_LIFETIME_MINUTES}m`);
  }

  return tokens.join('_');
}

// Sample candidate sticky sessions over plain HTTP and keep the one whose
// egress IP actually lands in the ZIP's city/state. IPRoyal widens the pool
// silently when a city has no free peers, so without this the run would just
// accept whatever US IP it was handed.
async function selectResidentialSession({ host, port, username, basePassword, location }) {
  let fallback = null;

  for (const tier of TARGETING_TIERS) {
    console.log(`  targeting: ${tier.name}`);
    let tierProducedEgress = false;

    for (let attempt = 1; attempt <= SESSION_ATTEMPTS; attempt += 1) {
      const session = `nlc${Math.random().toString(36).slice(2, 10)}`;
      const password = buildProxyPassword(basePassword, location, session, tier);
      const result = await fetchThroughProxy({ host, port, username, password, url: SESSION_PROBE_URL });

      if (!result.ok || !/^\d{1,3}(\.\d{1,3}){3}$/.test(result.body)) {
        console.log(`    probe ${attempt}/${SESSION_ATTEMPTS}: no usable egress`
          + ` (${result.error || `HTTP ${result.statusCode}`})`);
        continue;
      }

      tierProducedEgress = true;
      const ip = result.body;
      const geo = await lookupIpGeo(ip);
      const cityMatch = geo && normalizeProxyToken(geo.city) === normalizeProxyToken(location.city);
      const stateMatch = geo && normalizeProxyToken(geo.regionName) === normalizeProxyToken(location.stateName);
      console.log(`    probe ${attempt}/${SESSION_ATTEMPTS}: ${ip} -> ${geo ? `${geo.city}, ${geo.regionName}` : 'unknown location'}`);

      if (cityMatch && stateMatch) {
        console.log(`  matched ${location.city}, ${location.state} via ${tier.name}`);
        return { session, password, ip, geo, match: 'city + state matched', tier: tier.name };
      }
      if (stateMatch && (!fallback || fallback.match !== 'state matched, city did not')) {
        fallback = { session, password, ip, geo, match: 'state matched, city did not', tier: tier.name };
      } else if (!fallback) {
        fallback = { session, password, ip, geo, match: 'NOT matched - IPRoyal fell back to a wider pool', tier: tier.name };
      }
    }

    // A tier that never returned an egress IP means IPRoyal has no peers for
    // that target at all; widening is the only way forward.
    if (!tierProducedEgress) {
      console.log(`  no peers available for ${tier.name}; widening`);
      continue;
    }
    if (fallback && fallback.match === 'state matched, city did not') break;
  }

  if (!fallback) {
    throw new Error(`No usable IPRoyal residential session for ${location.city}, ${location.state}.`);
  }
  console.log(`  no exact city match; using best available (${fallback.match})`);
  return fallback;
}

// The form's own submit handler emits MM/DD/YYYY, but the DOM control is an
// <input type="date">, which only accepts YYYY-MM-DD via fill(). Convert here so
// the CLI can keep taking --dob in MM/DD/YYYY.
function toDateInputValue(value) {
  const raw = String(value).trim();
  const slashed = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashed) {
    const [, month, day, year] = slashed;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  throw new Error(`Unsupported --dob value "${raw}". Use MM/DD/YYYY or YYYY-MM-DD.`);
}

async function getBrowserObservedIp(page) {
  // Use the browser page itself so this check follows the exact same proxy path
  // as the TrustedForm page and its third-party scripts.
  await page.goto(IP_CHECK_URL, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  return (await page.locator('body').innerText()).trim();
}

async function waitForTrustedFormCert(page) {
  await page.waitForFunction(() => {
    const field = document.querySelector('#xxTrustedFormCertUrl');
    return field && /^https?:\/\//i.test(field.value || '');
  }, { timeout: 20_000 });

  return page.locator('#xxTrustedFormCertUrl').inputValue();
}

async function main() {
  const username = required(
    'IPROYAL_PROXY_USERNAME or IPRoyal username',
    process.env.IPROYAL_PROXY_USERNAME || process.env.IPROYAL_USERNAME,
  );
  const basePassword = required(
    'IPROYAL_PROXY_PASSWORD or IPrRoyal password',
    process.env.IPROYAL_PROXY_PASSWORD || process.env.IPROYAL_PASSWORD,
  );
  const zip = required('--zip', arg('zip', process.env.TEST_ZIP));

  const location = getZipTarget(zip);
  // Country-only: this probe answers "is the account usable?" (402/407).
  // Geo targeting is resolved afterwards by selectResidentialSession, which
  // can widen when a city has no peers instead of aborting the run.
  const preflightPassword = buildProxyPassword(
    basePassword, location, null, TARGETING_TIERS[TARGETING_TIERS.length - 1],
  );

  const payload = {
    zip: location.zip,
    gender: required('--gender', arg('gender', process.env.TEST_GENDER || 'Male')),
    date_of_birth: required('--dob', arg('dob', process.env.TEST_DOB)),
    currently_insured: required('--currently-insured', arg('currently-insured', process.env.TEST_CURRENTLY_INSURED || 'No')),
    credit_rating: required('--credit-rating', arg('credit-rating', process.env.TEST_CREDIT_RATING || 'good')),
    marital: required('--marital', arg('marital', process.env.TEST_MARITAL || 'No')),
    homeowner: required('--homeowner', arg('homeowner', process.env.TEST_HOMEOWNER || 'Yes')),
    military: required('--military', arg('military', process.env.TEST_MILITARY || 'No')),
    tobacco_use: required('--tobacco', arg('tobacco', process.env.TEST_TOBACCO || 'No')),
    cancer: required('--cancer', arg('cancer', process.env.TEST_CANCER || 'No')),
    heart_disease: required('--heart-disease', arg('heart-disease', process.env.TEST_HEART_DISEASE || 'No')),
    coverage_amount: required('--coverage', arg('coverage', process.env.TEST_COVERAGE || '$25,000')),
    height: required('--height', arg('height', process.env.TEST_HEIGHT || '70')),
    weight: required('--weight', arg('weight', process.env.TEST_WEIGHT || '160')),
    address: required('--address', arg('address', process.env.TEST_ADDRESS)),
    fname: required('--fname', arg('fname', process.env.TEST_FNAME)),
    lname: required('--lname', arg('lname', process.env.TEST_LNAME)),
    email: required('--email', arg('email', process.env.TEST_EMAIL)),
    phone: required('--phone', arg('phone', process.env.TEST_PHONE)),
  };

  console.log(JSON.stringify({
    targetUrl: TARGET_URL,
    submittedZip: location.zip,
    resolvedCity: location.city,
    resolvedState: location.state,
    zipCentroid: { latitude: location.latitude, longitude: location.longitude },
    proxyHost: PROXY_HOST,
    proxyPort: PROXY_PORT,
  }, null, 2));

  // Server-side diagnostic first: distinguishes an IPRoyal account/credential
  // problem from a browser problem before Chromium is even started.
  const probeTarget = new URL(IP_CHECK_URL);
  const probe = await probeProxyConnect({
    host: PROXY_HOST,
    port: PROXY_PORT,
    username,
    password: preflightPassword,
    target: `${probeTarget.hostname}:${probeTarget.port || 443}`,
  });
  if (!probe.ok) {
    throw new Error(describeProxyFailure(probe));
  }
  console.log(`IPRoyal CONNECT preflight: HTTP ${probe.statusCode} (tunnel established)`);

  console.log(`Selecting a residential session near ${location.city}, ${location.state}:`);
  const selection = await selectResidentialSession({
    host: PROXY_HOST,
    port: PROXY_PORT,
    username,
    basePassword,
    location,
  });
  const proxyPassword = selection.password;

  const browserPath = process.env.CHROME_EXECUTABLE_PATH || process.env.CHROMIUM_EXECUTABLE_PATH;
  if (!browserPath) {
    throw new Error('Set CHROME_EXECUTABLE_PATH (or CHROMIUM_EXECUTABLE_PATH) to a local Chromium/Chrome executable.');
  }

  const browser = await chromium.launch({
    executablePath: browserPath,
    headless: process.env.HEADLESS !== 'false',
    // Shared-CPU host: keep Chromium to a single lightweight instance.
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-background-networking',
      '--disable-extensions',
      '--renderer-process-limit=2',
    ],
    proxy: {
      server: `http://${PROXY_HOST}:${PROXY_PORT}`,
      username,
      password: proxyPassword,
    },
  });

  try {
    const context = await browser.newContext({
      locale: 'en-US',
      timezoneId: 'America/New_York',
      ignoreHTTPSErrors: false,
    });

    const page = await context.newPage();
    page.setDefaultTimeout(30_000);

    const observedIp = await getBrowserObservedIp(page);
    console.log(`Observed outbound browser IP through IPRoyal: ${observedIp}`);

    // IPRoyal widens the pool silently when the requested city has no peers,
    // so report where the egress IP actually landed instead of assuming the
    // city/state target was honoured.
    const observedGeo = await lookupIpGeo(observedIp);
    let geoTargetMatch = selection.match;
    if (observedGeo) {
      const cityMatch = normalizeProxyToken(observedGeo.city) === normalizeProxyToken(location.city);
      const stateMatch = normalizeProxyToken(observedGeo.regionName) === normalizeProxyToken(location.stateName);
      if (cityMatch && stateMatch) geoTargetMatch = 'city + state matched';
      else if (stateMatch) geoTargetMatch = 'state matched, city did not';
      else geoTargetMatch = 'NOT matched - IPRoyal fell back to a wider pool';
      console.log(`Observed IP location: ${observedGeo.city}, ${observedGeo.regionName}, ${observedGeo.country}`
        + ` (ISP: ${observedGeo.isp}, hosting: ${observedGeo.hosting})`);
      console.log(`Geo target result: ${geoTargetMatch}`);
    }

    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });

    // TrustedForm runs in this browser session, so its network observations use
    // the same residential proxy as the page and its third-party requests.
    const trustedFormCertUrlPromise = waitForTrustedFormCert(page);
    // Filling the form takes several seconds; keep a handler attached so a
    // TrustedForm timeout surfaces at the await below, not as an unhandled
    // rejection that would kill the process mid-fill.
    trustedFormCertUrlPromise.catch(() => {});

    await page.locator('#zip').fill(payload.zip);
    await page.locator('#gender').selectOption({ label: payload.gender });
    await page.locator('#date_of_birth').fill(toDateInputValue(payload.date_of_birth));
    await page.locator('#currently_insured').selectOption(payload.currently_insured);
    await page.locator('#credit_rating').selectOption(payload.credit_rating);
    await page.locator('#marital').selectOption(payload.marital);
    await page.locator('#homeowner').selectOption(payload.homeowner);
    await page.locator('#military').selectOption(payload.military);
    await page.locator('#tobacco_use').selectOption(payload.tobacco_use);
    await page.locator('#cancer').selectOption(payload.cancer);
    await page.locator('#heart_disease').selectOption(payload.heart_disease);
    await page.locator('#coverage_amount').selectOption(payload.coverage_amount);
    await page.locator('#height').selectOption(payload.height);
    await page.locator('#weight').evaluate((element, value) => {
      element.value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }, payload.weight);
    await page.locator('#address').fill(payload.address);
    await page.locator('#fname').fill(payload.fname);
    await page.locator('#lname').fill(payload.lname);
    await page.locator('#email').fill(payload.email);
    await page.locator('#phone').fill(payload.phone);

    const trustedFormCertUrl = await trustedFormCertUrlPromise;
    console.log(`TrustedForm certificate URL: ${trustedFormCertUrl}`);

    await page.locator('#submit-button').click();
    await page.waitForFunction(() => {
      const el = document.querySelector('#response-message');
      return !!el && el.innerText.trim().length > 0;
    }, { timeout: 30_000 });

    const responseMessage = (await page.locator('#response-message').innerText()).trim();
    console.log(`Form response: ${responseMessage}`);

    if (!/^✓\s*Request received/i.test(responseMessage)) {
      throw new Error(`Form submission did not report success: ${responseMessage}`);
    }

    console.log('');
    console.log('===== RESIDENTIAL-PROXY TRUSTEDFORM TEST RESULT =====');
    console.log(`Resolved ZIP: ${location.zip}`);
    console.log(`Resolved City: ${location.city}`);
    console.log(`Resolved State: ${location.state} (${location.stateName})`);
    console.log(`Proxy Host: ${PROXY_HOST}:${PROXY_PORT}`);
    console.log(`Observed Browser Public IP: ${observedIp}`);
    console.log(`Observed IP Location: ${observedGeo ? `${observedGeo.city}, ${observedGeo.regionName}` : 'unknown'}`);
    console.log(`Observed IP ISP: ${observedGeo ? observedGeo.isp : 'unknown'}`);
    console.log(`Geo Target Result: ${geoTargetMatch}`);
    console.log(`IPRoyal Targeting Used: ${selection.tier}`);
    console.log(`TrustedForm Certificate: ${trustedFormCertUrl}`);
    console.log(`Form Response:`);
    console.log(`${responseMessage}`);
    console.log('====================================================');
    console.log('');
    console.log('Residential-proxy TrustedForm submission completed successfully.');
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
});
