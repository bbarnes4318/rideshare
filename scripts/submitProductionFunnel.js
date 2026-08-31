#!/usr/bin/env node
//
// Drive the LIVE production funnel at quotes.nationallifecoverage.org through an
// IPRoyal residential IP chosen to match the submitted ZIP, and prove that
// TrustedForm issued a certificate for that proxied session.
//
// This is a different target from scripts/submitWithResidentialProxy.js. That
// runner drives the Express/index.html app in this repository. The production
// hostname does NOT serve that app: it redirects (3 hops) to a hosted AngularJS
// funnel at /fv3/nationallifecoverage/1051/, whose DOM and step flow are
// completely different (#zipCode, not #zip; a 16-step hash-routed wizard, not a
// single page). Selectors here were read off the live page, not assumed.

require('dotenv').config();

const fs = require('fs');
const { chromium } = require('playwright-core');
const zipcodes = require('zipcodes');
const {
  probeProxyConnect,
  describeProxyFailure,
  lookupIpGeo,
  fetchThroughProxy,
} = require('./proxyDiagnostics');

const TARGET_URL = process.env.PRODUCTION_FUNNEL_URL || 'https://quotes.nationallifecoverage.org/';
const PROXY_HOST = process.env.IPROYAL_PROXY_HOST || 'geo.iproyal.com';
const PROXY_PORT = Number(process.env.IPROYAL_PROXY_PORT || 12321);
const IP_CHECK_URL = process.env.PROXY_IP_CHECK_URL || 'https://ipv4.icanhazip.com';
const SESSION_PROBE_URL = process.env.PROXY_SESSION_PROBE_URL || 'http://ipv4.icanhazip.com';
const SESSION_ATTEMPTS = Number(process.env.IPROYAL_SESSION_ATTEMPTS || 8);
const SESSION_LIFETIME_MINUTES = Number(process.env.IPROYAL_SESSION_LIFETIME_MINUTES || 30);
const MAX_STEPS = Number(process.env.FUNNEL_MAX_STEPS || 30);

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
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

// ---------------------------------------------------------------------------
// Production funnel step handling.
//
// The wizard is AngularJS and hash-routed. Each step is either a set of choice
// links (<a> elements) or input fields followed by <a class="btn-next">.
// Answers are keyed by the step's hash route, read off the live funnel.
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

async function fillStepFields(page, fields, lead) {
  for (const f of fields) {
    const key = (f.id || f.name).toLowerCase();
    const sel = f.id ? CSS_ID(f.id) : '[name="' + f.name + '"]';
    if (f.tag === 'select') {
      const real = (f.opts || []).filter((v) => v !== '');
      if (!real.length) continue;
      let value = real[0];
      // Angular emits "string:N" month values, zero-based.
      if (key.includes('month')) value = real[lead.birthMonth - 1] || real[0];
      else if (key.includes('height')) value = real.includes(lead.height) ? lead.height : real[0];
      await page.locator(sel).selectOption(value).catch(() => {});
      continue;
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
    if (value !== null) await page.locator(sel).fill(String(value)).catch(() => {});
  }
}

async function waitForTrustedFormCert(page, timeout = 45000) {
  await page.waitForFunction(() => {
    const f = document.querySelector('input[name=xxTrustedFormCertUrl]');
    return f && /^https?:\/\//i.test(f.value || '');
  }, { timeout });
  return page.evaluate(() => document.querySelector('input[name=xxTrustedFormCertUrl]').value);
}

async function main() {
  const username = required('IPROYAL_PROXY_USERNAME', process.env.IPROYAL_PROXY_USERNAME);
  const basePassword = required('IPROYAL_PROXY_PASSWORD', process.env.IPROYAL_PROXY_PASSWORD);
  const zip = required('--zip', arg('zip', process.env.TEST_ZIP));
  const location = getZipTarget(zip);

  const dob = required('--dob', arg('dob', process.env.TEST_DOB));
  const dobParts = dob.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!dobParts) throw new Error('--dob must be MM/DD/YYYY, got "' + dob + '"');

  const lead = {
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
  const answers = buildAnswers();

  console.log(JSON.stringify({
    targetUrl: TARGET_URL,
    submittedZip: location.zip,
    resolvedCity: location.city,
    resolvedState: location.state,
    zipCentroid: { latitude: location.latitude, longitude: location.longitude },
    proxyHost: PROXY_HOST,
    proxyPort: PROXY_PORT,
  }, null, 2));

  // Account check first (402 = no balance, 407 = bad credentials).
  const probeTarget = new URL(IP_CHECK_URL);
  const probe = await probeProxyConnect({
    host: PROXY_HOST,
    port: PROXY_PORT,
    username,
    password: buildProxyPassword(basePassword, location, null, TARGETING_TIERS[TARGETING_TIERS.length - 1]),
    target: probeTarget.hostname + ':' + (probeTarget.port || 443),
  });
  if (!probe.ok) throw new Error(describeProxyFailure(probe));
  console.log('IPRoyal CONNECT preflight: HTTP ' + probe.statusCode + ' (tunnel established)');

  console.log('Selecting a residential session near ' + location.city + ', ' + location.state + ':');
  const selection = await selectResidentialSession({
    host: PROXY_HOST, port: PROXY_PORT, username, basePassword, location,
  });

  const browserPath = process.env.CHROME_EXECUTABLE_PATH || process.env.CHROMIUM_EXECUTABLE_PATH;
  if (!browserPath) throw new Error('Set CHROME_EXECUTABLE_PATH to a local Chromium/Chrome executable.');

  const browser = await chromium.launch({
    executablePath: browserPath,
    headless: process.env.HEADLESS !== 'false',
    args: [
      '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
      '--disable-background-networking', '--disable-extensions', '--renderer-process-limit=2',
    ],
    proxy: {
      server: 'http://' + PROXY_HOST + ':' + PROXY_PORT,
      username,
      password: selection.password,
    },
  });

  let observedIp = null;
  let observedGeo = null;
  let trustedFormCertUrl = null;
  let finalUrl = null;
  let outcome = null;

  try {
    const context = await browser.newContext({ locale: 'en-US', timezoneId: 'America/Chicago' });
    const page = await context.newPage();
    page.setDefaultTimeout(45000);

    // --capture <file> records everything the browser exchanges with
    // TrustedForm, so the certificate's contents can be inspected afterwards.
    const capturePath = arg('capture', null);
    const captured = [];
    if (capturePath) {
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
    }

    await page.goto(IP_CHECK_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    observedIp = (await page.locator('body').innerText()).trim();
    observedGeo = await lookupIpGeo(observedIp);
    console.log('Observed outbound browser IP through IPRoyal: ' + observedIp);
    if (observedGeo) {
      console.log('Observed IP location: ' + observedGeo.city + ', ' + observedGeo.regionName
        + ' (ISP: ' + observedGeo.isp + ', hosting: ' + observedGeo.hosting + ')');
    }

    await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 90000 });
    await page.waitForTimeout(4000);
    console.log('Funnel URL after redirects: ' + page.url());

    for (let step = 1; step <= MAX_STEPS; step += 1) {
      const s = await page.evaluate(readStep);
      console.log('  step ' + step + ' ' + s.hash + (s.question ? '  "' + s.question + '"' : ''));

      const isFinal = s.fields.some((f) => /email|phone|firstname|lastname/i.test(f.id + f.name));
      await fillStepFields(page, s.fields, lead);

      if (isFinal) {
        trustedFormCertUrl = await waitForTrustedFormCert(page);
        console.log('  TrustedForm certificate: ' + trustedFormCertUrl);

        const submit = page.getByText('Submit', { exact: true }).first();
        if (!(await submit.count())) throw new Error('Submit control not found on ' + s.hash);
        await submit.click();
        await page.waitForTimeout(9000).catch(() => {});
        finalUrl = page.url();
        const body = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').trim();
        outcome = body.slice(0, 260);
        console.log('  post-submit URL: ' + finalUrl);
        console.log('  post-submit page: ' + outcome);

        const stillOnForm = /verify-information/.test(finalUrl)
          && await page.locator(CSS_ID('email')).isVisible().catch(() => false);
        if (stillOnForm) throw new Error('Funnel did not advance past the contact step: ' + outcome);
        break;
      }

      let clicked = false;
      const next = page.locator('a.btn-next').first();
      if (await next.count() && await next.isVisible().catch(() => false)) {
        await next.click().catch(() => {});
        clicked = true;
      } else {
        const wanted = answers[s.hash];
        const pick = (wanted && s.choices.find((c) => c.toLowerCase() === String(wanted).toLowerCase()))
          || (wanted && s.choices.find((c) => c.toLowerCase().startsWith(String(wanted).toLowerCase())))
          || s.choices[0];
        if (pick) {
          await page.getByText(pick, { exact: true }).first().click().catch(() => {});
          clicked = true;
          console.log('    -> ' + pick);
        }
      }
      if (!clicked) throw new Error('No control to advance step ' + s.hash);

      await page.waitForTimeout(2500);
      const after = await page.evaluate(() => location.hash || '#/');
      if (after === s.hash) throw new Error('Funnel stalled at ' + s.hash + ' (validation rejected the answer?)');
    }

    if (!trustedFormCertUrl) throw new Error('Never reached the contact step; no TrustedForm certificate captured.');

    const cityMatch = observedGeo && normalizeProxyToken(observedGeo.city) === normalizeProxyToken(location.city);
    const stateMatch = observedGeo && normalizeProxyToken(observedGeo.regionName) === normalizeProxyToken(location.stateName);

    console.log('');
    console.log('===== PRODUCTION FUNNEL RESIDENTIAL TEST RESULT =====');
    console.log('Target URL: ' + TARGET_URL);
    console.log('Resolved ZIP: ' + location.zip);
    console.log('Resolved City: ' + location.city);
    console.log('Resolved State: ' + location.state + ' (' + location.stateName + ')');
    console.log('Proxy Host: ' + PROXY_HOST + ':' + PROXY_PORT);
    console.log('Observed Browser Public IP: ' + observedIp);
    console.log('Observed IP Location: ' + (observedGeo ? observedGeo.city + ', ' + observedGeo.regionName : 'unknown'));
    console.log('Observed IP ISP: ' + (observedGeo ? observedGeo.isp : 'unknown'));
    console.log('IP matches submitted ZIP: ' + (cityMatch && stateMatch ? 'YES (city + state)' : stateMatch ? 'state only' : 'NO'));
    console.log('IPRoyal Targeting Used: ' + selection.tier);
    console.log('TrustedForm Certificate: ' + trustedFormCertUrl);
    console.log('TrustedForm Certificate ID: ' + String(trustedFormCertUrl).split('/').pop());
    console.log('Post-submit URL: ' + finalUrl);
    console.log('Post-submit page: ' + outcome);
    console.log('====================================================');
    console.log('');
    if (capturePath) {
      fs.writeFileSync(capturePath, JSON.stringify({
        certUrl: trustedFormCertUrl,
        certId: String(trustedFormCertUrl).split('/').pop(),
        egressIp: observedIp,
        egressGeo: observedGeo ? observedGeo.city + ', ' + observedGeo.regionName + ', ' + observedGeo.isp : null,
        pageUrl: finalUrl,
        events: captured,
      }, null, 1));
      console.log('TrustedForm capture written to ' + capturePath + ' (' + captured.length + ' events)');
    }
    console.log('Production funnel submission completed successfully.');
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error('ERROR: ' + error.message);
  process.exitCode = 1;
});
