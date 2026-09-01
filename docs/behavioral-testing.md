# TrustedForm behavioral test harness

`scripts/behavioralTestRunner.js` is a measurement instrument for the authorized
ActiveProspect study. It drives the live production funnel through the existing
IPRoyal residential proxy, with the existing ZIP → location routing and the
existing TrustedForm capture, and records a full interaction timeline so
browser-side telemetry can be correlated with the certificate TrustedForm issues
for the same session.

It requires `--test-mode`. Without that flag it refuses to run.

## What is shared with production, and what is new

The proxy preflight, IPRoyal targeting tiers, sticky-session selection, ZIP
resolution, funnel DOM contract (`readStep`, the field → value mapping, the
answer set, the contact-step test), the TrustedForm certificate wait and the
TrustedForm capture all moved into `scripts/lib/funnelCore.js` in this change.
`scripts/submitProductionFunnel.js` now imports them instead of defining them, so
the harness drives *the same implementation* rather than a copy that can drift.
The production runner's flow is otherwise unchanged.

What the harness adds is on top of that: randomized session durations, randomized
within-step field order, real keystroke entry, bounded pauses and scrolling, a
merged event timeline, per-run capture files, signal extraction and JSON/CSV
reports.

## Selectors: which ones are real

The production hostname does **not** serve this repository's `index.html`. It
redirects to a hosted AngularJS funnel at `/fv3/nationallifecoverage/1051/`.

| | self-hosted `index.html` | production funnel |
|---|---|---|
| ZIP | `#zip` | `#zipCode` |
| flow | one page | 16-step hash-routed wizard |
| gender/insured/credit/… | `#gender`, `#currently_insured`, `#credit_rating`, … | choice `<a>` elements per hash route |
| DOB | `#date_of_birth` | `#birthMonth` select + `#birthDay` / `#birthYear` |
| submit | `#submit-button` | an `<a>` whose exact text is `Submit` |
| response | `#response-message` | a navigation away from `#/verify-information` |
| TrustedForm | `#xxTrustedFormCertUrl` | `input[name=xxTrustedFormCertUrl]` (id `xxTrustedFormCertUrl_0`) |

The harness never hard-codes the first column. It reads the live DOM through the
shared `readStep` and maps whatever fields are present, which is how the
known-good NJ submission worked.

## Running it

```bash
npm run behavior:test -- \
  --test-mode \
  --cohort short --count 5 \
  --zip 07302 \
  --dob 07/09/1982 \
  --address "88 Morgan St" \
  --fname "Dana" \
  --lname "TestLead" \
  --email "dana.testlead@example.com" \
  --phone "5513326220"
```

`--cohort all` runs short, then medium, then long. Runs execute **sequentially**,
each in its own freshly launched browser process and context, with its own
IPRoyal sticky session — no cookies, localStorage, cache or proxy peer is shared
between runs.

Lead values fall back to the `TEST_*` environment variables. No test data is
hard-coded anywhere in the repository or in the production path.

### Options

| flag | meaning |
|---|---|
| `--test-mode` | required |
| `--cohort <short\|medium\|long\|all>` | default `short` |
| `--count <n>` | runs per cohort, default 1 |
| `--duration-range <a-b>` | override the selected cohort's range, in seconds |
| `--report-dir <path>` | default `test-reports/` (gitignored) |
| `--telemetry-keys <redacted\|raw>` | default `redacted` |
| `--entry-mode <type\|fill>` | default `type` — see below |
| `--offline-selftest` | drive a loopback mock funnel with no proxy |

Every constant (pause bounds, typing speed range, scroll probability and bounds,
settle and response timeouts, cohort ranges) is overridable through
`BEHAVIOR_*` environment variables, listed in `.env.residential-proxy.example`.

## Duration randomization

Cohort ranges default to the suggested values and are configurable:

| cohort | default range |
|---|---|
| short | 10–35 s |
| medium | 35–100 s |
| long | 100–240 s |

Each run **independently** draws its own target from the range — no two runs are
forced onto the same duration. The target is then spent across the actual
workflow rather than in one sleep: at each step the harness recomputes the
remaining budget against elapsed time, splits its share randomly across that
step's field entries and its pre-advance pause, and clamps each pause to the
configured bounds. A step that ran long shrinks the pauses that follow; a step
that ran short grows them.

Every run reports:

- `targetDurationSec` — what was drawn
- `actualDurationSec` — the session on the form: funnel page load → Submit click
- `navigationSec` — the funnel's redirect chain, before its page existed
- `responseWaitSec` — waiting for the post-submit navigation
- `pausedSec` — how much of the session was deliberate waiting
- `unpausedSec` — the funnel's own cost (typing, clicks, view swaps, network)
- `minimumSessionSec` — `unpausedSec` plus the minimum pause at each interaction
- `targetUnreachable` — true when `minimumSessionSec` exceeded the target

### What the session window is, and what it is not

`actualDurationSec` is measured from the **funnel page load to the Submit
click**, because that is the window TrustedForm certifies. Two spans that are
not part of the session on the form are measured and reported separately rather
than folded in:

- the funnel's own multi-redirect load, which measured **9.2 s** live and
  happens before its page — and TrustedForm's script — exists at all;
- the post-submit navigation wait, which happens after the certificate has
  already been issued.

Both the reported duration and the pause budget run on this session clock.
Charging the 9.2 s navigation against the session target inflated the reported
session by roughly 14 s, left short-cohort runs with almost no budget so every
pause collapsed to its minimum, and made reachable targets report as
unreachable. Measured on the same live run: 37.49 s reported against a 20 s
target became 23.60 s once the window was corrected.

**The actual duration is the number that matters, and it is never adjusted to
match the target.** A cohort range whose upper bound is below
`minimumSessionSec` cannot be hit however the pauses are distributed; the run is
flagged rather than quietly missed, so the ranges can be recalibrated against
measured data.

## Interaction timeline

Two sources are merged into one timeline with a shared origin (the funnel page
load):

1. **Page-side** capture-phase listeners installed via `addInitScript` before any
   page script runs — the same `focus`, `blur`, `input`, `change`, `keydown`,
   `keyup`, `click` and `scroll` events TrustedForm's own script observes. They
   only read: no `preventDefault`, no `stopPropagation`, no value is touched.
2. **Driver-side** records the page cannot see: `navigation-start`, `page-load`,
   `trustedform-available`, `first-interaction`, `step-enter`, `field-start`,
   `field-complete`, `tab-out`, `pause`, `scroll-action`, `advance`,
   `final-review`, `trustedform-certificate`, `submit`, `response`,
   `context-close`, `browser-close`.

Every event carries `timestamp` (ISO), `elapsedMs` and `eventType`, plus
`selector`, `field`, `valueLength`, `scrollPosition`, `key`, `direction`,
`amount`, `durationMs` and `reason` where they apply.

### Keystroke redaction

Recording the literal character of every key would let a report reconstruct an
email address, a phone number or a street address. By default the harness records
the *class* of a printable key — `<alpha>`, `<digit>`, `<punct>`, `<space>` —
and the literal key only for structural keys that carry no field content (`Tab`,
`Backspace`, `Enter`, arrows). `valueLength` is recorded so timing and length can
still be correlated. `--telemetry-keys raw` opts into literal characters for a
controlled run with synthetic data.

The offline self-test asserts that no lead value appears anywhere in a report.

## Field order

The production funnel's **step** order is fixed by the application: it is a
hash-routed wizard, and reordering steps would produce an invalid submission.
What legitimately varies is the order in which fields *within* a step are
completed. One profile is drawn per run from `dom-order`, `reverse-dom`,
`shuffled`, `identity-first`, `contact-first` and `address-first`. The profile
name and the actual sequence of fields touched are both recorded.

## Scrolling

Bounded: 0–2 wheel bursts per step, each 120–700 px, roughly 3:1 down to up.
Each burst records direction, amount, the resulting `scrollY` and `movedPx`;
the page-side listener records the observed scroll independently.

Scrolling only happens where the step can actually scroll. Measured live, 13 of
the funnel's 16 steps fit the viewport, so wheel events there move nothing:
sending them anyway filled the timeline with scroll-actions whose
`scrollPosition` never changed, which reads as scrolling that did not happen.
A step with less than 40 px of overflow records `scroll-skipped` instead, so an
unscrollable step is explicit in the report rather than silently absent.

## TrustedForm capture and signal extraction

Each run writes its own capture to `<report-dir>/captures/<runId>.json`, using
the same listeners as the production runner's `--capture`. Nothing is ever
overwritten, and each run is associated with exactly one certificate.

Extraction flattens every TrustedForm request payload and response body the
browser exchanged, and reports the values under the key names TrustedForm
actually used. Policy is **last observed**, not first: TrustedForm's script pings
from page load onwards, so the earliest payload of any session predates all
interaction and reads zero for anything cumulative. `signalSeries` keeps the full
ordered progression, including those leading zeros, so nothing is hidden by the
choice.

A signal the capture never contained is reported as `null` — never `0`, never a
guess. A signal the capture reported as `0` is reported as `0`. Nothing is
inferred or derived.

Retrieving the certificate's own contents from ActiveProspect requires claiming
it through their API, which is a billable action against the certificate. The
harness does not do that. Signals come only from what the browser observed.

## The wpm = 0 / kpm = 0 finding

The previous successful run reported `wpm: 0` and `kpm: 0` while typed values
still appeared in the session recording as timestamped events. Those two facts
are consistent, and the harness now measures the mechanism directly.

The production runner enters values with Playwright's `locator.fill()`. `fill()`
assigns the element's `value` and dispatches a single `input` event. It emits **no
`keydown`, `keypress` or `keyup` at all.** A listener that counts key events
therefore counts zero for a filled field, and any rate derived from that count is
zero — while the value still lands correctly and the change is still observable
as a timestamped `input` event, which is exactly what was seen.

`--entry-mode` makes this the experiment's independent variable:

- `--entry-mode fill` — the production behavior, the control arm.
- `--entry-mode type` (default) — a real click to focus, then one character at a
  time through the keyboard, producing genuine key events.

Measured in the offline self-test, against a listener counting the same `keydown`
events on the same funnel, same cohort, same lead:

| entry mode | harness keystroke count | page-side kpm |
|---|---|---|
| `type` | 77 | 110 |
| `fill` | 0 | 0 |

Both arms submitted successfully and both produced `input` events with
timestamps.

**What this does and does not establish.** It establishes that the zero is a
property of how the automation entered the values, not evidence that TrustedForm
failed to observe the session. It does **not** establish anything about
TrustedForm's internal implementation, which is not inspectable from here.

### Confirmed against real TrustedForm

The offline numbers above came from a local stand-in listener. The same
comparison has since been run through the IPRoyal proxy against the live funnel,
and the values below are read out of the real `/certs/<id>/update` payloads in
each run's own capture file — TrustedForm's own numbers, not ours:

| entry method | typing baseline | TrustedForm `wpm` | TrustedForm `kpm` | certificate |
|---|---|---|---|---|
| `fill()` (production runner) | — | **0** | **0** | `87e7cb57…` |
| `keyboard.type()` | ~370 cpm | 84.31 | 416.76 | `3601087b…` |
| `keyboard.type()` | ~830 cpm | 210.94 | 1100.17 | `633ce6bf…` |
| `keyboard.type()` | ~1330 cpm | 325.07 | 1577.67 | `d2e7367d…` |

The two fastest rows were rehearsal runs that stopped before Submit, so they
generated a certificate but no lead; the certificate and its `/update` payload
are unaffected by that.

Two things follow, both measured rather than assumed:

1. The zero was real and correctly reported. TrustedForm counted the key events
   the session actually contained, and `fill()` produces none.
2. TrustedForm's `kpm` tracks the **actual inter-key interval**, measured over
   the intervals in which typing occurred rather than over the whole session,
   and `wpm ≈ kpm / 5` (the conventional five-character word) across all three
   typed rows.

**The two fastest rows are faster than any human types.** That is recorded as a
finding, not tuned away: at 60 ms per character the harness reports a typing rate
no person produces, and TrustedForm reports it faithfully. Only the ~370 cpm row
(≈74 wpm) is a rate a fast human touch-typist could produce.

Three cohorts is a demonstration, not a controlled study — **no causal claim is
made from this sample size.**

## Live cohort results

One run per cohort against the live funnel, from the deployed commit. Same lead,
same ZIP, each in its own browser, context and IPRoyal sticky session.

| cohort | range | target | **actual** | floor | paused | proxy IP | geo | certificate | submit |
|---|---|---|---|---|---|---|---|---|---|
| short | 10–35 s | 11.2 s | **22.93 s** | 17.70 s | 5.23 s | 96.240.6.112 | Jersey City, NJ | `3019736906c1…` | success |
| medium | 35–100 s | 78.6 s | **94.09 s** | 24.98 s | 69.11 s | 72.68.117.141 | Jersey City, NJ | `dc8171792880…` | success |
| long | 100–240 s | 152.6 s | **161.45 s** | 21.35 s | 140.10 s | 100.35.215.150 | Jersey City, NJ | `8e625be04ea7…` | success |

Every run resolved to Jersey City, NJ on a Verizon residential IP, matching the
submitted ZIP on city **and** state, and produced its own distinct certificate
and capture file.

### What TrustedForm reported for each

| cohort | our typing baseline | our keystrokes | TF `kpm` | TF `wpm` | session | `nav_webdriver` |
|---|---|---|---|---|---|---|
| short | 442 cpm | 81 | 560.1 | 117.2 | 22.93 s | `true` |
| medium | 233 cpm | 82 | 306.3 | 63.4 | 94.09 s | `true` |
| long | 296 cpm | 83 | 385.0 | 76.4 | 161.45 s | `true` |

Two observations, offered as observations and nothing more:

- **`kpm` tracks typing rate, not session length.** The long run lasted 7× the
  short run and typed one more character, yet reported a *lower* `kpm`. Ordering
  by `kpm` reproduces the ordering by typing baseline (442 > 296 > 233), not by
  duration. Across all three, TF `kpm` came out ≈1.3× the configured baseline,
  and `wpm ≈ kpm / 4.8`.
- **A longer session did not change what was recorded about the client.**
  `nav_webdriver` was `true` in all three, as it was in the original NJ capture.

**Three runs is a demonstration, not a study.** These are single observations per
cohort, from one ZIP on one day; nothing here supports a causal claim, and no
conclusion should be drawn about how any of these signals are scored.

### Target adherence

Each run overshot its target: +11.7 s (short), +15.5 s (medium), +8.9 s (long).
The short target of 11.2 s was below the measured floor and was correctly
flagged `targetUnreachable`; the other two were reachable and still overshot by
10–20%, because the budget is divided across the steps still expected without
reserving for the work between pauses. `actualDurationSec` is reported as
measured and is never adjusted toward the target.

## User agent

Headless runs report `HeadlessChrome/<version>` because the browser really is
headless Chromium. The harness records `browser.userAgent` and `browser.headless`
exactly as observed and **does not modify the user-agent string**. To test a
headed browser as an experimental variable, set `HEADLESS=false` and run with a
display; the report will show whatever that browser reports.

Changing the user-agent string would not make automated interaction human, and
this harness makes no such claim. Randomized timing is a variable being measured,
not a claim about defeating any control.

### The user agent is not the strongest automation signal in the capture

Decoding a live capture shows the user-agent string is not what TrustedForm is
relying on. Its payloads carry, among others:

| signal | observed value |
|---|---|
| `nav_webdriver` | `true` |
| `browser_width` × `browser_height` | 1280 × 720 |
| `screen_width` × `screen_height` | 1280 × 720 |
| `nav_max_touch_points` | 0 |
| `nav_hw_conc` | 4 |
| `nav_dev_mem` | 8 |
| `win_dpr` | 1 |
| `mobile` | `false` |

`navigator.webdriver` is `true` in every run, which is exactly what that property
is specified to report for a browser under automation. It is present in the
known-good NJ capture too, alongside the certificate that run produced. These
values are recorded as observed; the harness does not alter any of them, and no
attempt is made to suppress or falsify this or any other signal.

## Reports

`<report-dir>/` contains:

- `behavioral-<batchId>.json` — the batch: aggregate summary plus every run record
- `behavioral-<batchId>.csv` — one flat row per run, for Excel
- `runs/<runId>.json` — one file per run
- `captures/<runId>.json` — that run's raw TrustedForm capture

Each run record carries `automatedTest: true` and `test_run_id`. The funnel is a
third-party hosted application with no field for a test marker, and the
submission data model is deliberately unchanged, so the labelling lives in the
reports and captures rather than in the submitted lead.

CSV columns: `runId, cohort, targetDurationSec, actualDurationSec, proxyIp,
proxyCity, proxyState, zip, city, state, trustedFormCertificate,
trustedFormCertificateId, wpm, kpm, interactionCount, keystrokeCount, focusCount,
blurCount, scrollCount, pauseCount, submitTimestamp, success`. The event arrays
stay in JSON.

The aggregate summary reports, per cohort: runs, min/max/mean/median actual
duration, successful submissions, TrustedForm certificates, runs with non-zero
wpm and kpm, mean funnel floor and mean minimum session, and how many targets
were unreachable.

## Residential IP validation

Before each run, in order: a fresh browser context is started behind the IPRoyal
proxy, `PROXY_IP_CHECK_URL` is visited to read the browser's actual public IP,
that IP is geolocated, and the result is compared to the ZIP's city and state.
The observed IP, city, state, ISP, the targeting tier IPRoyal actually honoured
and the match level (`city+state`, `state-only`, `no`) all go into the record.

The **browser** egresses through the proxy. No IP header is set, spoofed or
forwarded — TrustedForm's script runs client-side, so headers could not affect
what it observes anyway.

IPRoyal documents country and city targeting; it does not offer ZIP-level
targeting. `07302` therefore targets Jersey City, NJ, and the harness records the
IP and geo it actually got rather than claiming ZIP-level precision. IPRoyal
silently widens the pool when a city has no available peers, which is why the
tier actually used is recorded per run.

## Testing the harness itself

```bash
npm run test:unit      # pure logic: ZIP resolution, proxy passwords, field
                       # planning, signal extraction, CSV, aggregation
npm run test:offline   # end-to-end against a loopback mock funnel, no network
npm test               # both
```

`test/mock-funnel/server.js` is a loopback stand-in reproducing the shapes the
harness depends on — hash-routed steps with an Angular-like render lag, choice
links, `a.btn-next`, the field ids, the hidden TrustedForm input, an exact-text
`Submit` control and a `/trustedform/` ping endpoint. It is **not** TrustedForm
and **not** the production funnel. `--offline-selftest` refuses any non-loopback
`PRODUCTION_FUNNEL_URL`, and every report it produces is stamped
`offlineSelfTest: true`, so an offline run can never be mistaken for a real one.

The offline self-test verifies the `--test-mode` gate, the loopback guard,
sequential execution, per-run isolation, duration randomization and measurement,
real key events, redaction, that no lead value leaks into a report, timeline
completeness and ordering, bounded scrolling, field-order profiles, one distinct
capture and certificate per run, signal extraction and its last-observed policy,
the fill-versus-type measurement, JSON and CSV output, the aggregate summary and
that no Chromium processes are orphaned.
