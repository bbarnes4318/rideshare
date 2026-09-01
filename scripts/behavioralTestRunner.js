#!/usr/bin/env node
//
// Authorized behavioral test harness for the ActiveProspect / TrustedForm
// study.
//
// WHAT THIS IS
//   A measurement instrument. It drives the same production funnel, through
//   the same IPRoyal residential proxy, with the same ZIP -> location routing
//   and the same TrustedForm capture as scripts/submitProductionFunnel.js
//   (all of that is shared code in scripts/lib/funnelCore.js). What it adds is
//   a controlled, randomized interaction model and a full interaction
//   timeline, so browser-side telemetry can be correlated with the certificate
//   TrustedForm issues for the same session.
//
// WHAT THIS IS NOT
//   It does not modify, forge or post-process TrustedForm data, does not spoof
//   IP headers, and does not alter the user agent. The browser really is
//   headless Chromium unless HEADLESS=false, and the reports say so. Randomized
//   timing is an experimental variable being measured, not a claim about
//   defeating anything.
//
// Requires --test-mode. Never run it against production traffic.

require('dotenv').config();

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright-core');

const core = require('./lib/funnelCore');
const { PAGE_INSTRUMENTATION, Recorder } = require('./lib/telemetry');
const reporting = require('./lib/reporting');

const { arg, hasFlag, required } = core;

// --------------------------------------------------------------------------
// Configuration. Every knob is overridable so the cohort ranges can be tuned
// against the funnel's measured timing instead of guessed at.
// --------------------------------------------------------------------------

const MAX_STEPS = Number(process.env.FUNNEL_MAX_STEPS || 30);
const EXPECTED_STEPS = Number(process.env.BEHAVIOR_EXPECTED_STEPS || 16);
const PAUSE_MIN_MS = Number(process.env.BEHAVIOR_PAUSE_MIN_MS || 250);
const PAUSE_MAX_MS = Number(process.env.BEHAVIOR_PAUSE_MAX_MS || 25000);
const TYPING_CPM_MIN = Number(process.env.BEHAVIOR_TYPING_CPM_MIN || 150);
const TYPING_CPM_MAX = Number(process.env.BEHAVIOR_TYPING_CPM_MAX || 480);
const SCROLL_PROBABILITY = Number(process.env.BEHAVIOR_SCROLL_PROBABILITY || 0.55);
const SCROLL_MIN_PX = Number(process.env.BEHAVIOR_SCROLL_MIN_PX || 120);
const SCROLL_MAX_PX = Number(process.env.BEHAVIOR_SCROLL_MAX_PX || 700);
// Below this much scrollable overflow a step is treated as unscrollable, so the
// timeline never records a wheel burst that could not have moved anything.
const SCROLL_MIN_MOVE_PX = Number(process.env.BEHAVIOR_SCROLL_MIN_MOVE_PX || 40);
const STEP_SETTLE_MAX_MS = Number(process.env.BEHAVIOR_STEP_SETTLE_MAX_MS || 10000);
const RESPONSE_WAIT_MS = Number(process.env.BEHAVIOR_RESPONSE_WAIT_MS || 15000);
const TF_AVAILABLE_TIMEOUT_MS = Number(process.env.BEHAVIOR_TF_TIMEOUT_MS || 30000);
const BETWEEN_RUNS_MS = Number(process.env.BEHAVIOR_BETWEEN_RUNS_MS || 3000);
// Held back from the pause budget for the certificate wait, the submit click
// and the response, which happen after the last pause and are not pauses.
const SUBMIT_RESERVE_MS = Number(process.env.BEHAVIOR_SUBMIT_RESERVE_MS || 2500);
// Bootstrap for the pause budget's per-step overhead reserve, used only for the
// first few steps before the run has measured its own. Measured live: a full
// 16-step run spends ~18-25s outside pauses, of which typing is tracked
// separately, leaving roughly this much per step for clicks and view swaps.
const STEP_OVERHEAD_MS = Number(process.env.BEHAVIOR_STEP_OVERHEAD_MS || 700);
// The final review absorbs the leftover budget, so it is allowed to run longer
// than an ordinary pause - a long cohort legitimately spends a while on the
// completed form before submitting.
const FINAL_REVIEW_MAX_MS = Number(process.env.BEHAVIOR_FINAL_REVIEW_MAX_MS || 90000);

function parseRange(spec, fallback) {
  if (!spec) return fallback;
  const m = String(spec).match(/^\s*(\d+(?:\.\d+)?)\s*(?:-|:|,|\.\.)\s*(\d+(?:\.\d+)?)\s*$/);
  if (!m) throw new Error('A duration range must look like "10-35"; got "' + spec + '"');
  const lo = Number(m[1]);
  const hi = Number(m[2]);
  if (!(lo > 0) || !(hi >= lo)) throw new Error('Invalid duration range "' + spec + '"');
  return [lo, hi];
}

// Suggested defaults; override per cohort with BEHAVIOR_RANGE_* or --duration-range.
const COHORT_RANGES = {
  short: parseRange(process.env.BEHAVIOR_RANGE_SHORT, [10, 35]),
  medium: parseRange(process.env.BEHAVIOR_RANGE_MEDIUM, [35, 100]),
  long: parseRange(process.env.BEHAVIOR_RANGE_LONG, [100, 240]),
};

// --------------------------------------------------------------------------
// Randomization helpers. Every run draws independently: no run is forced onto
// the same duration, field order, typing speed or pause pattern as another.
// --------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const randFloat = (lo, hi) => lo + Math.random() * (hi - lo);
const randInt = (lo, hi) => Math.floor(randFloat(lo, hi + 1));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function shuffle(items) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Characters this lead will have to type over the whole funnel.
 *
 * Used only to reserve typing time out of the pause budget. The funnel asks for
 * the ZIP twice (its own first step and again on the address step), which is why
 * that one is counted twice. Select controls are excluded: they are chosen, not
 * typed. An overestimate is the safe direction - it reserves a little too much
 * and lands slightly under target rather than over.
 */
function plannedTypingChars(lead) {
  const typed = [
    lead.zip, lead.zip, lead.birthDay, lead.birthYear,
    lead.weight, lead.address, lead.fname, lead.lname, lead.email, lead.phone,
  ];
  return typed.reduce((total, value) => total + String(value ?? '').length, 0);
}

/** Split `total` into `parts` positive random shares. */
function splitBudget(total, parts) {
  if (parts <= 0) return [];
  const weights = Array.from({ length: parts }, () => 0.2 + Math.random());
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => (w / sum) * total);
}

// --------------------------------------------------------------------------
// Field-order profiles.
//
// The production funnel is a hash-routed wizard: its STEP order is fixed by
// the application and cannot be reordered without producing an invalid
// submission. What legitimately varies is the order in which the fields WITHIN
// a step are completed, which is what these profiles randomize.
// --------------------------------------------------------------------------

const prioritize = (preferred) => (plans) => {
  const rank = (plan) => {
    const i = preferred.findIndex((p) => plan.key.includes(p));
    return i === -1 ? preferred.length : i;
  };
  return [...plans].sort((a, b) => rank(a) - rank(b));
};

const FIELD_ORDER_PROFILES = [
  { name: 'dom-order', order: (plans) => plans },
  { name: 'reverse-dom', order: (plans) => [...plans].reverse() },
  { name: 'shuffled', order: shuffle },
  { name: 'identity-first', order: prioritize(['firstname', 'lastname', 'address', 'email', 'phone']) },
  { name: 'contact-first', order: prioritize(['email', 'phone', 'firstname', 'lastname', 'address']) },
  { name: 'address-first', order: prioritize(['address', 'zip', 'firstname', 'lastname', 'phone', 'email']) },
];

// --------------------------------------------------------------------------
// Interaction primitives. Each records what it actually did, with a real
// timestamp, into the run's timeline.
// --------------------------------------------------------------------------

async function pause(ctx, ms, reason) {
  const durationMs = Math.round(ms);
  if (durationMs <= 0) return 0;
  ctx.recorder.record('pause', { durationMs, reason });
  await sleep(durationMs);
  ctx.pausedMs += durationMs;
  return durationMs;
}

function charDelayMs(cpm) {
  const mean = 60000 / cpm;
  // Per-character jitter around the run's baseline speed.
  return clamp(mean * randFloat(0.35, 1.9), 8, 1200);
}

/**
 * Enter a value into a text field.
 *
 * The two entry modes are the experiment's independent variable:
 *
 *   type (default) - a real click to focus, then one key at a time through the
 *     keyboard, so the page receives genuine keydown/keypress/keyup events.
 *
 *   fill - Playwright's locator.fill(), which is what the production runner
 *     uses. It assigns the element's value and dispatches a single input event;
 *     it emits NO key events at all. Anything that derives a typing rate from
 *     key events therefore counts zero keystrokes for a filled field, even
 *     though the value lands correctly and the change is observable as a
 *     timestamped input event.
 *
 * Running both arms is how the study measures what TrustedForm actually
 * records, instead of assuming it.
 */
async function typeValue(page, plan, ctx) {
  const locator = page.locator(plan.selector).first();
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  ctx.recorder.record('field-start', {
    selector: plan.selector, field: plan.key, valueLength: plan.value.length, entryMode: ctx.entryMode,
  });

  const startedAt = Date.now();
  if (ctx.entryMode === 'fill') {
    await locator.fill(plan.value).catch(() => {});
  } else {
    await locator.click({ timeout: 10000 }).catch(() => {});
    const existing = await locator.inputValue().catch(() => '');
    if (existing) {
      await page.keyboard.press('Control+A').catch(() => {});
      await page.keyboard.press('Backspace').catch(() => {});
    }
    for (const character of plan.value) {
      await page.keyboard.type(character).catch(() => {});
      await sleep(charDelayMs(ctx.typingCpm));
    }
  }
  // Entry time is tracked apart from per-step overhead, and the characters are
  // struck off the reserve, so the budget stops holding back time for typing
  // that has already happened.
  const typedMs = Date.now() - startedAt;
  ctx.typedMs += typedMs;
  ctx.charsRemaining = Math.max(0, ctx.charsRemaining - plan.value.length);

  ctx.recorder.record('field-complete', {
    selector: plan.selector, field: plan.key, valueLength: plan.value.length, typedMs,
  });
}

async function selectValue(page, plan, ctx) {
  const locator = page.locator(plan.selector).first();
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  ctx.recorder.record('field-start', { selector: plan.selector, field: plan.key });
  await locator.selectOption(plan.value).catch(() => {});
  ctx.recorder.record('field-complete', {
    selector: plan.selector, field: plan.key, valueLength: String(plan.value).length,
  });
}

/**
 * Bounded scrolling, only where the step can actually scroll.
 *
 * Measured on the live funnel: 13 of its 16 steps fit the viewport, so wheel
 * events there move nothing. Scrolling regardless filled the timeline with
 * scroll-actions whose scrollPosition never changed, which reads as scrolling
 * that did not happen. The skip is recorded so an unscrollable step is explicit
 * in the report rather than silently absent, and each burst records how far the
 * page actually moved.
 */
async function maybeScroll(page, ctx, reason) {
  if (Math.random() > SCROLL_PROBABILITY) return;

  const metrics = await page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
  })).catch(() => null);
  const maxScroll = metrics ? Math.max(0, metrics.scrollHeight - metrics.innerHeight) : 0;
  if (maxScroll < SCROLL_MIN_MOVE_PX) {
    ctx.recorder.record('scroll-skipped', { reason, maxScroll, cause: 'step-not-scrollable' });
    return;
  }

  const bursts = randInt(1, 2);
  for (let i = 0; i < bursts; i += 1) {
    const before = await page.evaluate(() => window.scrollY).catch(() => 0);
    // Turn around near the bottom instead of wheeling against the end of the page.
    const down = before > maxScroll * 0.6 ? false : Math.random() < 0.75;
    const amount = randInt(SCROLL_MIN_PX, Math.max(SCROLL_MIN_PX, Math.min(SCROLL_MAX_PX, maxScroll)));
    await page.mouse.wheel(0, down ? amount : -amount).catch(() => {});
    await sleep(randInt(120, 420));
    const scrollPosition = await page.evaluate(() => window.scrollY).catch(() => null);
    ctx.recorder.record('scroll-action', {
      direction: down ? 'down' : 'up',
      amount,
      scrollPosition,
      maxScroll,
      movedPx: scrollPosition === null ? null : scrollPosition - before,
      reason,
    });
  }
}

/**
 * Drive the weight step's slider to a target value with real key events.
 *
 * The weight control is an angularjs-slider: a `<span role="slider">`, not an
 * `<input>`. readStep only reports input/select/textarea, so this control was
 * invisible to the runner and weight was never set - every submission took the
 * slider's default of 160 regardless of what --weight said.
 *
 * It is driven from the keyboard rather than by assigning the Angular model,
 * because the whole point of the harness is that the page receives the same
 * events a person would produce. The key deltas are measured at runtime instead
 * of assumed: press once, read aria-valuenow, learn the step. Returns what the
 * slider actually ended up on, which is what the report records.
 */
async function setWeightSlider(page, ctx, targetValue) {
  const slider = await firstVisible(page.locator('[role=slider]'));
  if (!slider) return null;

  const read = async () => {
    const now = await slider.getAttribute('aria-valuenow').catch(() => null);
    return now === null ? null : Number(now);
  };
  const bounds = {
    min: Number(await slider.getAttribute('aria-valuemin').catch(() => null)),
    max: Number(await slider.getAttribute('aria-valuemax').catch(() => null)),
  };
  const start = await read();
  if (start === null || !Number.isFinite(start)) return null;

  const target = clamp(Number(targetValue), bounds.min || 0, bounds.max || Number(targetValue));
  ctx.recorder.record('field-start', {
    field: 'weight', control: 'slider', valueFrom: start, valueTarget: target,
    min: bounds.min, max: bounds.max,
  });

  await slider.click().catch(() => {});

  // Calibrate: what does one arrow press move, and one page press?
  const calibrate = async (key) => {
    const before = await read();
    await page.keyboard.press(key).catch(() => {});
    await sleep(60);
    const after = await read();
    return (after === null || before === null) ? 0 : after - before;
  };
  const arrowStep = Math.abs(await calibrate('ArrowRight')) || 1;
  const pageStep = Math.abs(await calibrate('PageUp')) || arrowStep;

  let current = await read();
  let presses = 0;
  const MAX_PRESSES = Number(process.env.BEHAVIOR_SLIDER_MAX_PRESSES || 120);
  while (current !== null && current !== target && presses < MAX_PRESSES) {
    const gap = target - current;
    const usePage = Math.abs(gap) >= pageStep && pageStep > arrowStep;
    const key = gap > 0
      ? (usePage ? 'PageUp' : 'ArrowRight')
      : (usePage ? 'PageDown' : 'ArrowLeft');
    await page.keyboard.press(key).catch(() => {});
    presses += 1;
    await sleep(clamp(charDelayMs(ctx.typingCpm) / 2, 15, 160));
    const next = await read();
    if (next === current) break; // hit an end stop; do not spin
    current = next;
  }

  ctx.recorder.record('field-complete', {
    field: 'weight', control: 'slider', valueLength: String(current).length,
    valueReached: current, valueTarget: target, keyPresses: presses,
    arrowStep, pageStep,
  });
  return current;
}

async function waitForStepChange(page, fromHash, maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const now = await page.evaluate(() => location.hash || '#/').catch(() => fromHash);
    if (now !== fromHash) return now;
    await sleep(150);
  }
  return fromHash;
}

const stepShape = (step) => JSON.stringify([
  step.question,
  step.fields.map((f) => f.id || f.name),
  step.choices,
]);

/**
 * Read the current step once the funnel has actually re-rendered it.
 *
 * The hash changes before Angular swaps the view, so reading immediately after
 * a hash change can return the PREVIOUS step's fields and send the harness at
 * elements that are on their way out of the DOM. Production masked this with a
 * flat 2.5s sleep; this waits for the rendered content to change instead, and
 * falls back to whatever is there after settleMs.
 */
async function readSettledStep(page, previous, settleMs) {
  let step = await page.evaluate(core.readStep);
  if (!previous) return step;
  const deadline = Date.now() + settleMs;
  while (Date.now() < deadline && stepShape(step) === stepShape(previous)) {
    await sleep(120);
    step = await page.evaluate(core.readStep);
  }
  return step;
}

/**
 * First matching element that is actually visible.
 *
 * A hash-routed wizard can keep more than one step's controls in the DOM, so
 * `.first()` alone can resolve to a hidden control from a step already left.
 */
async function firstVisible(locator) {
  const count = await locator.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const candidate = locator.nth(i);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return null;
}

/**
 * Remaining pause budget, spread over the steps still expected.
 *
 * Measured against the session clock (funnel page load), not the run clock.
 * The funnel's redirect chain costs ~9s before its page exists, and charging
 * that to the session target left short cohorts with almost no budget.
 *
 * The budget is what is left for *pausing*, so it has to hold back the work
 * still to come. Dividing the remaining wall clock by the remaining steps
 * over-allocates every time, because those steps also spend time typing,
 * clicking and waiting for the view to swap. Measured: a medium run had
 * 78.6 - 24.98 = 53.62s of room and paused 69.11s, overshooting its target by
 * exactly the 15.49s difference.
 *
 * Two costs are therefore reserved:
 *   * per-step overhead - clicks, view settling, network - as the running mean
 *     of what the steps so far actually cost outside pauses and typing;
 *   * typing - projected from the characters still to be entered at this run's
 *     own baseline speed. This one matters because the contact step is last and
 *     carries most of the typing, so a running average alone under-reserves
 *     right up until the burst it needs to pay for.
 */
function stepBudgetMs(ctx, stepsRemaining) {
  const elapsed = ctx.sessionElapsed();
  const overheadSoFar = Math.max(0, elapsed - ctx.pausedMs - ctx.typedMs);
  const perStepOverhead = ctx.stepsEntered >= 3
    ? overheadSoFar / ctx.stepsEntered
    : STEP_OVERHEAD_MS;
  const typingReserve = (ctx.charsRemaining / Math.max(1, ctx.typingCpm)) * 60000;
  const reserve = (perStepOverhead * stepsRemaining) + typingReserve;

  const remaining = ctx.targetMs - SUBMIT_RESERVE_MS - elapsed - reserve;
  if (remaining <= 0) return 0;
  const mean = remaining / Math.max(1, stepsRemaining);
  return clamp(mean * randFloat(0.45, 1.55), PAUSE_MIN_MS, Math.min(PAUSE_MAX_MS, remaining));
}

// --------------------------------------------------------------------------
// One run.
// --------------------------------------------------------------------------

const liveBrowsers = new Set();

async function runOnce(options) {
  const {
    runId, cohort, index, lead, location, credentials, targetDurationSec,
    reportDir, batchId, offline,
  } = options;

  const recorder = new Recorder();
  const profile = FIELD_ORDER_PROFILES[Math.floor(Math.random() * FIELD_ORDER_PROFILES.length)];
  // Short sessions get a faster baseline typist, long sessions a slower one;
  // both are drawn at random inside the configured range.
  const cohortBias = { short: [0.55, 1], medium: [0.25, 0.85], long: [0, 0.6] }[cohort] || [0, 1];
  const typingCpm = Math.round(
    TYPING_CPM_MIN + randFloat(cohortBias[0], cohortBias[1]) * (TYPING_CPM_MAX - TYPING_CPM_MIN),
  );

  const ctx = {
    recorder,
    targetMs: targetDurationSec * 1000,
    typingCpm,
    entryMode: options.entryMode,
    fieldOrder: [],
    // Offset of the funnel page load within the run timeline. The duration
    // target applies to the session on the form, so the budget is spent
    // against this clock rather than the run's.
    sessionStartMs: 0,
    sessionElapsed() { return Math.max(0, recorder.elapsed() - ctx.sessionStartMs); },
    // Bookkeeping the pause budget reserves against, so it never allocates time
    // that the remaining work is already going to spend.
    pausedMs: 0,
    typedMs: 0,
    stepsEntered: 0,
    charsRemaining: plannedTypingChars(lead),
  };

  const record = {
    runId,
    test_run_id: runId,
    automatedTest: true,
    batchId,
    cohort,
    runIndex: index,
    startedAt: new Date().toISOString(),
    targetDurationSec: Math.round(targetDurationSec * 100) / 100,
    actualDurationSec: null,
    totalRunSec: null,
    durationRangeSec: COHORT_RANGES[cohort],
    offlineSelfTest: !!offline,
    browser: { headless: process.env.HEADLESS !== 'false', userAgent: null, executablePath: null },
    interactionModel: {
      entryMode: options.entryMode,
      fieldOrderProfile: profile.name,
      typingCharsPerMinute: options.entryMode === 'fill' ? null : typingCpm,
      keyTelemetry: options.telemetryKeys,
      scrollProbability: SCROLL_PROBABILITY,
      pauseBoundsMs: [PAUSE_MIN_MS, PAUSE_MAX_MS],
    },
    proxy: { host: offline ? null : core.PROXY_HOST, port: offline ? null : core.PROXY_PORT, ip: null, country: null, state: null, city: null, isp: null, targeting: null, matchesZip: null },
    leadLocation: { zip: location.zip, city: location.city, state: location.state, stateName: location.stateName },
    trustedForm: { available: null, availableAtMs: null, certificateUrl: null, certificateId: null, captureFile: null, captureEventCount: 0, signals: {}, observedSignalKeys: [] },
    interactionSummary: {},
    fieldOrder: [],
    events: [],
    submission: { timestamp: null, success: false, response: null, finalUrl: null },
    error: null,
  };

  const wallStart = Date.now();
  let browser = null;
  let context = null;
  let capturedEvents = null;

  try {
    let proxySelection = null;
    if (!offline) {
      proxySelection = await core.selectResidentialSession({
        host: core.PROXY_HOST,
        port: core.PROXY_PORT,
        username: credentials.username,
        basePassword: credentials.basePassword,
        location,
      });
      record.proxy.targeting = proxySelection.tier;
    }

    const executablePath = core.resolveBrowserPath();
    record.browser.executablePath = executablePath;

    // A completely fresh browser process per run: no shared cookies,
    // localStorage, cache or IPRoyal sticky session between runs.
    browser = await chromium.launch({
      executablePath,
      headless: process.env.HEADLESS !== 'false',
      args: core.LAUNCH_ARGS,
      proxy: offline ? undefined : {
        server: 'http://' + core.PROXY_HOST + ':' + core.PROXY_PORT,
        username: credentials.username,
        password: proxySelection.password,
      },
    });
    liveBrowsers.add(browser);

    context = await browser.newContext({ locale: 'en-US', timezoneId: 'America/Chicago' });
    await context.addInitScript(PAGE_INSTRUMENTATION, { redactKeys: options.telemetryKeys !== 'raw' });
    const page = await context.newPage();
    page.setDefaultTimeout(45000);

    capturedEvents = core.attachTrustedFormCapture(page);

    // Residential IP validation, before touching the funnel.
    if (!offline) {
      await page.goto(core.IP_CHECK_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const observedIp = (await page.locator('body').innerText()).trim();
      const observedGeo = await core.lookupIpGeo(observedIp);
      record.proxy.ip = observedIp;
      if (observedGeo) {
        record.proxy.country = observedGeo.country;
        record.proxy.state = observedGeo.regionName;
        record.proxy.city = observedGeo.city;
        record.proxy.isp = observedGeo.isp;
        const cityMatch = core.normalizeProxyToken(observedGeo.city) === core.normalizeProxyToken(location.city);
        const stateMatch = core.normalizeProxyToken(observedGeo.regionName) === core.normalizeProxyToken(location.stateName);
        record.proxy.matchesZip = cityMatch && stateMatch ? 'city+state' : stateMatch ? 'state-only' : 'no';
      }
      record.proxyGeoRaw = observedGeo || null;
      console.log('    egress IP ' + observedIp + ' -> '
        + (observedGeo ? observedGeo.city + ', ' + observedGeo.regionName : 'unknown')
        + ' (' + record.proxy.matchesZip + ')');
    }

    // t0: everything in the timeline is relative to the funnel page load.
    recorder.start(Date.now());
    record.timelineOrigin = new Date(recorder.t0).toISOString();
    recorder.record('navigation-start', { url: core.TARGET_URL });
    await page.goto(core.TARGET_URL, { waitUntil: 'networkidle', timeout: 90000 });
    recorder.record('page-load', { url: page.url() });
    // The session clock starts here: the funnel page now exists, and so does
    // TrustedForm's script on it.
    ctx.sessionStartMs = recorder.elapsed();
    record.browser.userAgent = await page.evaluate(() => navigator.userAgent).catch(() => null);

    // TrustedForm availability, measured rather than assumed.
    try {
      await page.waitForFunction(
        () => !!document.querySelector('input[name=xxTrustedFormCertUrl]')
          || !!document.querySelector('script[src*="trustedform" i]')
          || typeof window.TrustedForm !== 'undefined',
        { timeout: TF_AVAILABLE_TIMEOUT_MS },
      );
      record.trustedForm.available = true;
      record.trustedForm.availableAtMs = recorder.elapsed();
      recorder.record('trustedform-available', { elapsedAtDetection: record.trustedForm.availableAtMs });
    } catch {
      record.trustedForm.available = false;
      recorder.record('trustedform-unavailable', { timeoutMs: TF_AVAILABLE_TIMEOUT_MS });
    }

    // The batch harness supplies per-record qualification answers; the CLI
    // harness falls back to the shared defaults, unchanged.
    const answers = options.answers || core.buildAnswers();
    let firstInteractionRecorded = false;
    let submitted = false;

    let previousStep = null;
    for (let step = 1; step <= MAX_STEPS; step += 1) {
      const s = await readSettledStep(page, previousStep, STEP_SETTLE_MAX_MS);
      previousStep = s;
      recorder.record('step-enter', {
        hash: s.hash, question: s.question || null, fieldCount: s.fields.length,
      });
      ctx.stepsEntered += 1;

      const plans = s.fields.map((f) => core.planField(f, lead)).filter(Boolean);
      const ordered = profile.order(plans);

      // A step can carry a slider instead of an input (weight). It is not in
      // `plans`, because planField only maps real form controls.
      //
      // The slider is driven only in `type` mode. It has no fill() equivalent -
      // it is not an input - so the only way to move it is the keyboard, and
      // doing that in the `fill` arm would emit key events into the very
      // control arm that exists to show fill() emits none. Skipping it there
      // also matches what the production runner does, which never set weight
      // at all because no input existed to fill.
      if (lead.weight !== undefined && lead.weight !== null) {
        if (ctx.entryMode === 'fill') {
          const present = await firstVisible(page.locator('[role=slider]'));
          if (present) {
            recorder.record('field-skipped', {
              field: 'weight', control: 'slider', reason: 'entry-mode=fill emits no key events',
            });
          }
        } else {
          const reached = await setWeightSlider(page, ctx, lead.weight);
          if (reached !== null && reached !== undefined) {
            record.weightSubmitted = reached;
            ctx.fieldOrder.push('weight');
          }
        }
      }
      const stepsRemaining = Math.max(1, EXPECTED_STEPS - step + 1);
      const budget = stepBudgetMs(ctx, stepsRemaining);
      // Distribute this step's slice of the session budget across its actual
      // interactions instead of sleeping once for the whole session.
      const shares = ordered.length ? splitBudget(budget * 0.6, ordered.length) : [];
      const advanceBudget = ordered.length ? budget * 0.4 : budget;

      for (let i = 0; i < ordered.length; i += 1) {
        const plan = ordered[i];
        if (!firstInteractionRecorded) {
          recorder.record('first-interaction', { selector: plan.selector, field: plan.key });
          firstInteractionRecorded = true;
        }
        ctx.fieldOrder.push(plan.key);
        if (plan.kind === 'select') await selectValue(page, plan, ctx);
        else await typeValue(page, plan, ctx);
        // Leaving the field produces the blur the page (and TrustedForm) sees.
        if (ctx.entryMode !== 'fill' && Math.random() < 0.5) {
          await page.keyboard.press('Tab').catch(() => {});
          recorder.record('tab-out', { field: plan.key });
        }
        await pause(ctx, shares[i] ?? PAUSE_MIN_MS, 'after-field:' + plan.key);
      }

      await maybeScroll(page, ctx, 'step:' + s.hash);
      await recorder.drain(page);

      if (core.isFinalStep(s.fields)) {
        // Reviewing the completed form before submitting is the last legitimate
        // pause in the session, so it also absorbs whatever is left of the
        // target. Predicting the reserve exactly is fragile in both directions -
        // under-reserving overshot by ~16%, over-reserving undershot by ~15% -
        // and closing the gap here corrects for whichever way the estimate went,
        // without inventing an interaction that did not happen. If the session
        // has already passed its target there is nothing to absorb and this
        // falls back to the ordinary minimum pause.
        const toTarget = ctx.targetMs - SUBMIT_RESERVE_MS - ctx.sessionElapsed();
        const reviewMs = clamp(Math.max(advanceBudget, toTarget), PAUSE_MIN_MS, FINAL_REVIEW_MAX_MS);
        await pause(ctx, reviewMs, 'final-review');
        recorder.record('final-review', {
          hash: s.hash,
          fieldsCompleted: ctx.fieldOrder.length,
          absorbedRemainderMs: Math.max(0, Math.round(toTarget)),
        });
        await maybeScroll(page, ctx, 'final-review');

        const certUrl = await core.waitForTrustedFormCert(page).catch(() => null);
        record.trustedForm.certificateUrl = certUrl;
        record.trustedForm.certificateId = core.certIdFromUrl(certUrl);
        recorder.record('trustedform-certificate', { present: !!certUrl });
        if (!certUrl) throw new Error('TrustedForm never populated a certificate URL on ' + s.hash);

        const submit = await firstVisible(page.getByText('Submit', { exact: true }));
        if (!submit) throw new Error('Submit control not found on ' + s.hash);

        await recorder.drain(page);
        // Read the pre-click URL BEFORE clicking: click() resolves after the
        // navigation has already committed, so comparing against a URL sampled
        // afterwards never detects the change and every run pays the full
        // response timeout.
        const beforeUrl = page.url();
        const submitAt = Date.now();
        record.submission.timestamp = new Date(submitAt).toISOString();
        recorder.record('submit', { hash: s.hash });
        await submit.click();
        submitted = true;

        const deadline = Date.now() + RESPONSE_WAIT_MS;
        while (page.url() === beforeUrl && Date.now() < deadline) {
          await sleep(200);
        }
        const finalUrl = page.url();
        const body = await page.evaluate(() => document.body.innerText)
          .then((t) => t.replace(/\s+/g, ' ').trim())
          .catch(() => '');
        const stillOnForm = /verify-information/.test(finalUrl)
          && await page.locator(core.CSS_ID('email')).isVisible().catch(() => false);

        recorder.record('response', { url: finalUrl, changed: finalUrl !== beforeUrl });
        record.submission.finalUrl = finalUrl;
        record.submission.response = body.slice(0, 260);
        record.submission.success = !stillOnForm;
        await recorder.drain(page);
        if (stillOnForm) throw new Error('Funnel did not advance past the contact step: ' + record.submission.response);
        break;
      }

      await pause(ctx, Math.max(advanceBudget, PAUSE_MIN_MS), 'pre-advance:' + s.hash);

      let clicked = null;
      const next = await firstVisible(page.locator('a.btn-next'));
      if (next) {
        await next.click().catch(() => {});
        clicked = 'btn-next';
      } else {
        const wanted = answers[s.hash];
        const pick = (wanted && s.choices.find((c) => c.toLowerCase() === String(wanted).toLowerCase()))
          || (wanted && s.choices.find((c) => c.toLowerCase().startsWith(String(wanted).toLowerCase())))
          || s.choices[0];
        const control = pick ? await firstVisible(page.getByText(pick, { exact: true })) : null;
        if (control) {
          if (!firstInteractionRecorded) {
            recorder.record('first-interaction', { choice: pick });
            firstInteractionRecorded = true;
          }
          await control.click().catch(() => {});
          clicked = pick;
        }
      }
      if (!clicked) throw new Error('No control to advance step ' + s.hash);
      recorder.record('advance', { hash: s.hash, control: clicked });

      const after = await waitForStepChange(page, s.hash, STEP_SETTLE_MAX_MS);
      if (after === s.hash) throw new Error('Funnel stalled at ' + s.hash + ' (validation rejected the answer?)');
      await recorder.drain(page);
    }

    if (!submitted) throw new Error('Never reached the contact step; nothing was submitted.');
  } catch (error) {
    record.error = error.message;
    console.log('    run failed: ' + error.message);
  } finally {
    if (context) {
      recorder.record('context-close', {});
      await context.close().catch(() => {});
    }
    if (browser) {
      await browser.close().catch(() => {});
      liveBrowsers.delete(browser);
      recorder.record('browser-close', {});
    }
  }

  // The session duration is page load -> submit click, which is the window
  // TrustedForm certifies. Measured, not assumed, from the timeline itself.
  //
  // It deliberately excludes two spans that are not part of the session on the
  // form, and which are reported separately instead of being folded in:
  //   * navigationSec - the funnel's own multi-redirect load, before its page
  //     (and TrustedForm's script) exists. Measured at 9.2s on the live funnel.
  //   * responseWaitSec - waiting for the post-submit navigation, which happens
  //     after the certificate is already issued.
  // Counting either inflated the reported session by ~14s and made every short
  // cohort target look unreachable when it was not.
  const firstAt = (type) => {
    const e = recorder.events.find((x) => x.eventType === type);
    return e ? e.elapsedMs : null;
  };
  const loadAt = firstAt('page-load');
  const submitAt = firstAt('submit');
  const responseAt = firstAt('response');

  record.navigationSec = loadAt === null ? null : Math.round(loadAt / 10) / 100;
  record.responseWaitSec = (submitAt === null || responseAt === null)
    ? null
    : Math.round((responseAt - submitAt) / 10) / 100;
  if (loadAt !== null && submitAt !== null) {
    record.actualDurationSec = Math.round((submitAt - loadAt) / 10) / 100;
  } else if (record.actualDurationSec === null && recorder.t0 !== null) {
    // Never reached Submit: fall back to whatever session did elapse.
    const end = responseAt === null ? recorder.elapsed() : responseAt;
    record.actualDurationSec = loadAt === null
      ? Math.round(end / 10) / 100
      : Math.round((end - loadAt) / 10) / 100;
  }
  record.totalRunSec = Math.round((Date.now() - wallStart) / 10) / 100;
  record.finishedAt = new Date().toISOString();

  // How much of the session was deliberate waiting, and how much is the funnel's
  // own irreducible cost (typing, clicks, view swaps, network). A cohort range
  // whose upper bound is below unpausedSec cannot be hit no matter how the
  // pauses are distributed; the report says so rather than faking the number.
  const pausedMs = recorder.events
    .filter((e) => e.eventType === 'pause')
    .reduce((total, e) => total + (e.durationMs || 0), 0);
  const pauseSlots = recorder.events.filter((e) => e.eventType === 'pause').length;
  record.pausedSec = Math.round(pausedMs / 10) / 100;
  record.unpausedSec = typeof record.actualDurationSec === 'number'
    ? Math.round((record.actualDurationSec - record.pausedSec) * 100) / 100
    : null;
  // Even a fully spent budget still leaves PAUSE_MIN_MS at each interaction, so
  // the shortest session this model can produce is the funnel's own cost plus
  // those minimums. A target below that is not reachable, and is reported as
  // such rather than being quietly missed.
  record.minimumSessionSec = typeof record.unpausedSec === 'number'
    ? Math.round((record.unpausedSec + (pauseSlots * PAUSE_MIN_MS) / 1000) * 100) / 100
    : null;
  record.durationOverTarget = typeof record.actualDurationSec === 'number'
    && record.actualDurationSec > record.targetDurationSec;
  record.targetUnreachable = typeof record.minimumSessionSec === 'number'
    && record.minimumSessionSec > record.targetDurationSec;

  // One capture file per run; nothing is ever overwritten.
  if (capturedEvents) {
    const capturesDir = path.join(reportDir, 'captures');
    fs.mkdirSync(capturesDir, { recursive: true });
    const capturePath = path.join(capturesDir, runId + '.json');

    // Snapshot once, then use that same snapshot for both the capture file and
    // the signal extraction. The listeners push asynchronously (a response body
    // is read with an await), so reading the live array twice leaves a window in
    // which a late TrustedForm event lands between the two, and the reported
    // signal would not be supported by the saved capture.
    const captureSnapshot = capturedEvents.slice();

    core.writeCapture(capturePath, {
      certUrl: record.trustedForm.certificateUrl,
      observedIp: record.proxy.ip,
      observedGeo: record.proxyGeoRaw || null,
      finalUrl: record.submission.finalUrl,
      events: captureSnapshot,
    });
    record.trustedForm.captureFile = capturePath;
    record.trustedForm.captureEventCount = captureSnapshot.length;

    const extracted = reporting.extractTrustedFormSignals(captureSnapshot);
    record.trustedForm.signals = extracted.signals;
    record.trustedForm.signalSeries = extracted.series;
    record.trustedForm.signalPolicy = extracted.policy;
    record.trustedForm.observedSignalKeys = extracted.observedKeys;
    record.trustedForm.signalPayloadCount = extracted.sourceCount;
  }
  delete record.proxyGeoRaw;

  record.interactionSummary = recorder.summary();
  record.fieldOrder = ctx.fieldOrder;
  record.events = recorder.timeline();
  return record;
}

// --------------------------------------------------------------------------
// Batch driver.
// --------------------------------------------------------------------------

function usage() {
  return [
    'Authorized TrustedForm behavioral test harness (requires --test-mode).',
    '',
    'Usage:',
    '  node scripts/behavioralTestRunner.js --test-mode --cohort short --count 5 \\',
    '    --zip 07302 --dob 07/09/1982 --address "88 Morgan St" \\',
    '    --fname Dana --lname TestLead --email dana.testlead@example.com --phone 5513326220',
    '',
    'Options:',
    '  --test-mode              Required. Without it the harness refuses to run.',
    '  --cohort <name>          short | medium | long | all   (default: short)',
    '  --count <n>              Runs per cohort, executed sequentially (default: 1)',
    '  --duration-range <a-b>   Override the selected cohort range, in seconds',
    '  --report-dir <path>      Report output directory (default: test-reports/)',
    '  --telemetry-keys <mode>  redacted (default) | raw',
    '  --entry-mode <mode>      type (default) | fill',
    '                           type: real per-character key events.',
    '                           fill: value assignment, as the production runner',
    '                           does. Emits no key events at all -- this is the',
    '                           control arm for the wpm/kpm measurement.',
    '  --offline-selftest       Drive a loopback mock funnel with no proxy. Refuses',
    '                           any non-loopback PRODUCTION_FUNNEL_URL. Reports are',
    '                           stamped offlineSelfTest:true.',
    '',
    'Lead values fall back to the TEST_* environment variables; no test data is',
    'hard-coded in this repository.',
  ].join('\n');
}

function isLoopbackUrl(value) {
  try {
    const { hostname } = new URL(value);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
  } catch {
    return false;
  }
}

async function main() {
  if (hasFlag('help')) {
    console.log(usage());
    return;
  }
  if (!hasFlag('test-mode')) {
    console.error('Refusing to run: the behavioral harness requires --test-mode.');
    console.error('');
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  const offline = hasFlag('offline-selftest');
  if (offline && !isLoopbackUrl(core.TARGET_URL)) {
    throw new Error('--offline-selftest requires PRODUCTION_FUNNEL_URL to be a loopback address; got ' + core.TARGET_URL);
  }

  const cohortArg = String(arg('cohort', 'short')).toLowerCase();
  const cohorts = cohortArg === 'all' ? Object.keys(COHORT_RANGES) : [cohortArg];
  for (const c of cohorts) {
    if (!COHORT_RANGES[c]) throw new Error('Unknown cohort "' + c + '". Use short, medium, long or all.');
  }

  const rangeOverride = arg('duration-range', null);
  if (rangeOverride) {
    if (cohorts.length !== 1) throw new Error('--duration-range applies to a single --cohort, not "all".');
    COHORT_RANGES[cohorts[0]] = parseRange(rangeOverride, null);
  }

  const count = Math.max(1, Number(arg('count', 1)));
  const telemetryKeys = String(arg('telemetry-keys', process.env.BEHAVIOR_TELEMETRY_KEYS || 'redacted')).toLowerCase();
  if (!['redacted', 'raw'].includes(telemetryKeys)) {
    throw new Error('--telemetry-keys must be "redacted" or "raw".');
  }
  const entryMode = String(arg('entry-mode', process.env.BEHAVIOR_ENTRY_MODE || 'type')).toLowerCase();
  if (!['type', 'fill'].includes(entryMode)) {
    throw new Error('--entry-mode must be "type" or "fill".');
  }
  const reportDir = path.resolve(arg('report-dir', process.env.BEHAVIOR_REPORT_DIR || 'test-reports'));

  const credentials = offline ? {} : {
    username: required('IPROYAL_PROXY_USERNAME', process.env.IPROYAL_PROXY_USERNAME),
    basePassword: required('IPROYAL_PROXY_PASSWORD', process.env.IPROYAL_PROXY_PASSWORD),
  };

  const zip = required('--zip', arg('zip', process.env.TEST_ZIP));
  const location = core.getZipTarget(zip);
  const lead = core.buildLead(location);

  const batchId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex');

  console.log('===== TRUSTEDFORM BEHAVIORAL TEST HARNESS (AUTHORIZED TEST) =====');
  console.log('batch:        ' + batchId);
  console.log('target:       ' + core.TARGET_URL);
  console.log('zip:          ' + location.zip + ' -> ' + location.city + ', ' + location.state);
  console.log('cohorts:      ' + cohorts.map((c) => c + ' ' + COHORT_RANGES[c].join('-') + 's').join(', '));
  console.log('runs/cohort:  ' + count);
  console.log('report dir:   ' + reportDir);
  console.log('key telemetry:' + telemetryKeys);
  console.log('entry mode:   ' + entryMode
    + (entryMode === 'fill' ? '  (value assignment: emits NO key events)' : '  (real key events)'));
  console.log('proxy:        ' + (offline ? 'DISABLED (offline self-test)' : core.PROXY_HOST + ':' + core.PROXY_PORT));
  console.log('headless:     ' + (process.env.HEADLESS !== 'false'));
  console.log('');

  if (!offline) {
    const probe = await core.preflightProxy({
      host: core.PROXY_HOST, port: core.PROXY_PORT,
      username: credentials.username, basePassword: credentials.basePassword,
      location, ipCheckUrl: core.IP_CHECK_URL,
    });
    console.log('IPRoyal CONNECT preflight: HTTP ' + probe.statusCode + ' (tunnel established)');
    console.log('');
  }

  const records = [];
  for (const cohort of cohorts) {
    const [lo, hi] = COHORT_RANGES[cohort];
    for (let i = 1; i <= count; i += 1) {
      // Each run independently draws its own target duration from the range.
      const targetDurationSec = Math.round(randFloat(lo, hi) * 10) / 10;
      const runId = batchId + '-' + cohort + '-' + String(i).padStart(2, '0');
      console.log('[' + cohort + ' ' + i + '/' + count + '] ' + runId
        + '  target ' + targetDurationSec + 's');
      const record = await runOnce({
        runId, cohort, index: i, lead, location, credentials, targetDurationSec,
        reportDir, batchId, offline, telemetryKeys, entryMode,
      });
      records.push(record);
      console.log('    actual ' + record.actualDurationSec + 's'
        + ' (paused ' + record.pausedSec + 's, funnel floor ' + record.unpausedSec
        + 's, min session ' + record.minimumSessionSec + 's)'
        + '  keystrokes ' + record.interactionSummary.keystrokeCount
        + '  events ' + record.interactionSummary.eventCount
        + '  cert ' + (record.trustedForm.certificateId || 'none')
        + '  success ' + record.submission.success);
      if (record.targetUnreachable) {
        console.log('    NOTE: the shortest session this funnel allows is '
          + record.minimumSessionSec + 's (funnel cost ' + record.unpausedSec
          + 's + minimum pauses), above this run\'s ' + record.targetDurationSec
          + 's target. Pauses collapsed to their minimum; the target was not reachable.');
      }
      console.log('');
      // Sequential by construction: nothing overlaps, and each run starts cold.
      if (BETWEEN_RUNS_MS > 0) await sleep(BETWEEN_RUNS_MS);
    }
  }

  const { jsonPath, csvPath, runsDir, summaries } = reporting.writeReports({ reportDir, batchId, records });

  console.log('===== AGGREGATE SUMMARY =====');
  console.log(reporting.formatSummary(summaries));
  console.log('');
  console.log('JSON report:      ' + jsonPath);
  console.log('CSV report:       ' + csvPath);
  console.log('Per-run JSON:     ' + runsDir);
  console.log('TrustedForm caps: ' + path.join(reportDir, 'captures'));
  console.log('');
  console.log('Browser contexts still open: ' + liveBrowsers.size);
  if (os.platform() === 'linux') {
    console.log('(check for orphans with: pgrep -fa "' + path.basename(core.resolveBrowserPath()) + '")');
  }

  if (records.some((r) => r.error)) process.exitCode = 1;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    for (const browser of liveBrowsers) await browser.close().catch(() => {});
    process.exit(130);
  });
}

// Run as a CLI when invoked directly. When required as a module (by the batch
// CSV harness) nothing executes: runOnce is shared so the batch layer drives
// this exact proven browser -> proxy -> form -> TrustedForm -> capture path
// rather than a second copy of it.
if (require.main === module) {
  main().catch((error) => {
    console.error('ERROR: ' + error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  runOnce,
  liveBrowsers,
  COHORT_RANGES,
  FIELD_ORDER_PROFILES,
  parseRange,
  plannedTypingChars,
  setWeightSlider,
};
