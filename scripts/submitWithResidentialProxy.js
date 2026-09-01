#!/usr/bin/env node

require('dotenv').config();

const { chromium } = require('playwright-core');
const zipcodes = require('zipcodes');
const { probeProxyConnect, describeProxyFailure } = require('./proxyDiagnostics');

const TARGET_URL = process.env.TRUSTEDFORM_TARGET_URL || 'https://quotes.nationallifecoverage.org/';
const PROXY_HOST = process.env.IPROYAL_PROXY_HOST || 'geo.iproyal.com';
const PROXY_PORT = Number(process.env.IPROYAL_PROXY_PORT || 12321);
const IP_CHECK_URL = process.env.PROXY_IP_CHECK_URL || 'https://ipv4.icanhazip.com';

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function required(name, value) {
  if (value === undefined || value === null || value === '') {
    throw new Error(`Missing required value: ${name}`);
  }
  return String(value);
}

function normalizeProxyToken(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
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
    stateName: zipcodes.states.abbr[location.state] || location.state,
    latitude: location.latitude,
    longitude: location.longitude,
  };
}

function buildProxyPassword(basePassword, location) {
  return [
    basePassword,
    'country-us',
    `state-${normalizeProxyToken(location.stateName)}`,
    `city-${normalizeProxyToken(location.city)}`,
  ].join('_');
}

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

function parseDurationSeconds() {
  const raw = arg('duration', process.env.TEST_DURATION_SECONDS);
  if (raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 3600) {
    throw new Error('--duration must be a number between 0 and 3600 seconds.');
  }
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getBrowserObservedIp(page) {
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

async function waitForControlledDwell(page, startTime, targetSeconds) {
  if (targetSeconds === null) return;

  const targetMs = targetSeconds * 1000;
  const elapsedMs = Date.now() - startTime;
  const remainingMs = targetMs - elapsedMs;

  if (remainingMs > 0) {
    console.log(`Controlled test dwell: waiting ${Math.ceil(remainingMs / 1000)}s before submission.`);
    await sleep(remainingMs);
  }

  const actualSeconds = (Date.now() - startTime) / 1000;
  console.log(`Controlled test dwell complete: ${actualSeconds.toFixed(2)}s elapsed.`);
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
  const durationSeconds = parseDurationSeconds();
  const testMode = hasFlag('test-mode') || durationSeconds !== null;

  const location = getZipTarget(zip);
  const proxyPassword = buildProxyPassword(basePassword, location);

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
    testMode,
    targetDurationSeconds: durationSeconds,
  }, null, 2));

  const probeTarget = new URL(IP_CHECK_URL);
  const probe = await probeProxyConnect({
    host: PROXY_HOST,
    port: PROXY_PORT,
    username,
    password: proxyPassword,
    target: `${probeTarget.hostname}:${probeTarget.port || 443}`,
  });
  if (!probe.ok) {
    throw new Error(describeProxyFailure(probe));
  }
  console.log(`IPRoyal CONNECT preflight: HTTP ${probe.statusCode} (tunnel established)`);

  const browserPath = process.env.CHROME_EXECUTABLE_PATH || process.env.CHROMIUM_EXECUTABLE_PATH;
  if (!browserPath) {
    throw new Error('Set CHROME_EXECUTABLE_PATH (or CHROMIUM_EXECUTABLE_PATH) to a local Chromium/Chrome executable.');
  }

  const browser = await chromium.launch({
    executablePath: browserPath,
    headless: process.env.HEADLESS !== 'false',
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

    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
    const pageStartTime = Date.now();

    const trustedFormCertUrlPromise = waitForTrustedFormCert(page);
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

    // This is deliberately a controlled benchmark dwell, not an attempt to
    // simulate or disguise human behavior. It lets the authorized test compare
    // TrustedForm records at known page durations.
    await waitForControlledDwell(page, pageStartTime, durationSeconds);

    const actualDurationSeconds = (Date.now() - pageStartTime) / 1000;

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
    console.log(`Target Duration: ${durationSeconds === null ? 'not specified' : `${durationSeconds}s`}`);
    console.log(`Actual Page Duration: ${actualDurationSeconds.toFixed(2)}s`);
    console.log(`TrustedForm Certificate: ${trustedFormCertUrl}`);
    console.log('Form Response:');
    console.log(responseMessage);
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
