#!/usr/bin/env node

require('dotenv').config();

const { chromium } = require('playwright-core');
const {
  PROXY_PROVIDER,
  PROXY_HOST,
  PROXY_PORT,
  IP_CHECK_URL,
  LAUNCH_ARGS,
  arg,
  required,
  normalizeProxyToken,
  getZipTarget,
  proxyCredentialsFromEnv,
  selectResidentialSession,
  preflightProxy,
  resolveBrowserPath,
  lookupIpGeo,
} = require('./lib/funnelCore');

// This runner drives the Express/index.html app in THIS repository, whose form
// is a single page with #zip / #gender / #submit-button ids. The production
// funnel at quotes.nationallifecoverage.org serves something else entirely -
// see scripts/submitProductionFunnel.js for that one. Only the DOM handling
// below is specific to this app; the ZIP resolution, provider targeting and
// sticky-session selection are the shared ones in lib/funnelCore.js, so this
// runner can no longer drift away from the runner that is actually in use.
const TARGET_URL = process.env.TRUSTEDFORM_TARGET_URL || 'https://quotes.nationallifecoverage.org/';

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
  const { username, basePassword } = proxyCredentialsFromEnv();
  const zip = required('--zip', arg('zip', process.env.TEST_ZIP));

  const location = getZipTarget(zip);

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
    proxyProvider: PROXY_PROVIDER.id,
    proxyHost: PROXY_HOST,
    proxyPort: PROXY_PORT,
  }, null, 2));

  // Server-side diagnostic first: distinguishes an account/credential problem
  // from a browser problem before Chromium is even started.
  const probe = await preflightProxy({
    host: PROXY_HOST, port: PROXY_PORT, username, basePassword, location, ipCheckUrl: IP_CHECK_URL,
  });
  console.log(`${PROXY_PROVIDER.id} CONNECT preflight: HTTP ${probe.statusCode} (tunnel established)`);

  console.log(`Selecting a residential session near ${location.city}, ${location.state}:`);
  const selection = await selectResidentialSession({
    host: PROXY_HOST,
    port: PROXY_PORT,
    username,
    basePassword,
    location,
  });

  const browser = await chromium.launch({
    executablePath: resolveBrowserPath(),
    headless: process.env.HEADLESS !== 'false',
    // Shared-CPU host: keep Chromium to a single lightweight instance.
    args: LAUNCH_ARGS,
    proxy: {
      server: `http://${PROXY_HOST}:${PROXY_PORT}`,
      // Both halves from the selection - Shifter's targeting and sticky sid
      // live in the username, so the account username alone would silently
      // egress from somewhere other than the IP that was just verified.
      username: selection.username,
      password: selection.password,
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
    console.log(`Observed outbound browser IP through ${PROXY_PROVIDER.id}: ${observedIp}`);

    // A gateway widens the pool silently when the requested city has no peers,
    // so report where the egress IP actually landed instead of assuming the
    // city/state target was honoured.
    const observedGeo = await lookupIpGeo(observedIp);
    let geoTargetMatch = selection.match;
    if (observedGeo) {
      const cityMatch = normalizeProxyToken(observedGeo.city) === normalizeProxyToken(location.city);
      const stateMatch = normalizeProxyToken(observedGeo.regionName) === normalizeProxyToken(location.stateName);
      if (cityMatch && stateMatch) geoTargetMatch = 'city + state matched';
      else if (stateMatch) geoTargetMatch = 'state matched, city did not';
      else geoTargetMatch = 'NOT matched - the gateway fell back to a wider pool';
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
    console.log(`Proxy Provider: ${PROXY_PROVIDER.id}${selection.strict ? ' (strict targeting)' : ''}`);
    console.log(`Proxy Host: ${PROXY_HOST}:${PROXY_PORT}`);
    console.log(`Observed Browser Public IP: ${observedIp}`);
    console.log(`Observed IP Location: ${observedGeo ? `${observedGeo.city}, ${observedGeo.regionName}` : 'unknown'}`);
    console.log(`Observed IP ISP: ${observedGeo ? observedGeo.isp : 'unknown'}`);
    console.log(`Geo Target Result: ${geoTargetMatch}`);
    console.log(`Targeting Used: ${selection.tier}`);
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
