#!/usr/bin/env node

require('dotenv').config();

const { chromium } = require('playwright-core');
const zipcodes = require('zipcodes');

const TARGET_URL = process.env.TRUSTEDFORM_TARGET_URL || 'https://quotes.nationallifecoverage.org/';
const PROXY_HOST = process.env.IPROYAL_PROXY_HOST || 'geo.iproyal.com';
const PROXY_PORT = Number(process.env.IPROYAL_PROXY_PORT || 12321);
const IP_CHECK_URL = process.env.PROXY_IP_CHECK_URL || 'https://ipv4.icanhazip.com';

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
    latitude: location.latitude,
    longitude: location.longitude,
  };
}

function buildProxyPassword(basePassword, location) {
  // IPRoyal's documented residential router syntax supports country/state/city
  // targeting in the password. The supplied ZIP is first resolved to its city
  // and state because IPRoyal does not document a ZIP targeting key here.
  return [
    basePassword,
    `country-us`,
    `state-${normalizeProxyToken(location.state)}`,
    `city-${normalizeProxyToken(location.city)}`,
  ].join('_');
}

async function waitForTrustedFormCert(page) {
  await page.waitForFunction(() => {
    const field = document.querySelector('#xxTrustedFormCertUrl');
    return field && /^https?:\/\//i.test(field.value || '');
  }, { timeout: 20_000 });

  return page.locator('#xxTrustedFormCertUrl').inputValue();
}

async function main() {
  const username = required('IPROYAL_PROXY_USERNAME or IPRoyal username', process.env.IPROYAL_PROXY_USERNAME || process.env.IPROYAL_USERNAME);
  const basePassword = required('IPROYAL_PROXY_PASSWORD or IPRoyal password', process.env.IPROYAL_PROXY_PASSWORD || process.env.IPROYAL_PASSWORD);
  const zip = required('--zip', arg('zip', process.env.TEST_ZIP));

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
  }, null, 2));

  const browserPath = process.env.CHROME_EXECUTABLE_PATH || process.env.CHROMIUM_EXECUTABLE_PATH;
  if (!browserPath) {
    throw new Error('Set CHROME_EXECUTABLE_PATH (or CHROMIUM_EXECUTABLE_PATH) to a local Chromium/Chrome executable.');
  }

  const browser = await chromium.launch({
    executablePath: browserPath,
    headless: process.env.HEADLESS !== 'false',
    proxy: {
      server: `http://${PROXY_HOST}:${PROXY_PORT}`,
      username,
      password: proxyPassword,
    },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  try {
    const context = await browser.newContext({
      locale: 'en-US',
      timezoneId: 'America/New_York',
      ignoreHTTPSErrors: false,
    });

    const page = await context.newPage();
    page.setDefaultTimeout(30_000);

    const ipResponse = await page.request.get(IP_CHECK_URL, { timeout: 15_000 });
    const observedIp = (await ipResponse.text()).trim();
    console.log(`Observed outbound IP through IPRoyal: ${observedIp}`);

    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });

    // TrustedForm's browser script must execute from this proxied browser session.
    const trustedFormCertUrlPromise = waitForTrustedFormCert(page);

    await page.locator('#zip').fill(payload.zip);
    await page.locator('#gender').selectOption({ label: payload.gender });
    await page.locator('#date_of_birth').fill(payload.date_of_birth);
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
    await page.locator('#weight').fill(payload.weight);
    await page.locator('#address').fill(payload.address);
    await page.locator('#fname').fill(payload.fname);
    await page.locator('#lname').fill(payload.lname);
    await page.locator('#email').fill(payload.email);
    await page.locator('#phone').fill(payload.phone);

    const trustedFormCertUrl = await trustedFormCertUrlPromise;
    console.log(`TrustedForm certificate URL: ${trustedFormCertUrl}`);

    await page.locator('#submit-button').click();
    await page.locator('#response-message').waitFor({ state: 'visible' });

    const responseMessage = await page.locator('#response-message').innerText();
    console.log(`Form response: ${responseMessage.trim()}`);

    if (!/^✓\s*Request received/i.test(responseMessage.trim())) {
      throw new Error(`Form submission did not report success: ${responseMessage.trim()}`);
    }

    console.log('Residential-proxy TrustedForm submission completed successfully.');
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
});
