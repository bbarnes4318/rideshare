# Batch CSV test harness

`scripts/batchCsvRunner.js` runs the authorized ActiveProspect experiment across
a CSV of test records. For each row it drives the **proven** browser path that
already exists in this repository — it does not reimplement or replace it:

```
fresh browser context
  → IPRoyal residential proxy, geo-selected from that row's ZIP
  → the real funnel at quotes.nationallifecoverage.org
  → TrustedForm initializes normally
  → the real form completed with real browser events
  → the real form submitted
  → the actual certificate and the actual observed IP recorded
```

It calls `behavioralTestRunner.runOnce()`, the same function the behavioural
harness uses, so every row also carries the full behavioural experiment:
randomized session duration from a cohort range, randomized within-step field
order, bounded pauses and scrolling, and the complete keystroke/focus/blur/
input/scroll timeline. See [behavioral-testing.md](behavioral-testing.md).

Requires `--test-mode`. Without it the harness exits 2 and does nothing.

## Input

Case-sensitive headers:

```
First_Name,Last_Name,Gender,Age,Address,City,State,Zip,Phone,Email,DOB
```

A worked example is in [`test/fixtures/sample-leads.csv`](../test/fixtures/sample-leads.csv).

### Sanitization

| field | rule |
|---|---|
| `DOB` | standardized to `MM/DD/YYYY`, zero-padded. Accepts `M/D/YYYY`, `MM/DD/YYYY`, `YYYY-MM-DD`, and `-`/`.` separators. |
| `Phone` | reduced to 10 digits; a leading US `1` is dropped. |
| `Gender` | lowercased to `male`/`female` for routing; anything else passes through lowercased. |
| `Zip` | first 5 digits. |

Two inputs are **rejected rather than guessed**, because guessing produces a
plausible wrong answer instead of an error:

- **Two-digit years.** `4/15/85` could be 1985 or 2085. The row is rejected.
- **Phone numbers that are not 10 digits.** Truncating a long number yields a
  valid-looking number belonging to somebody else.

Rejected rows are listed with their line number and reason, and are never
submitted. Every other row proceeds.

## Measured constraint: the live form rejects reserved 555 numbers

`test/fixtures/sample-leads.csv` uses numbers in the reserved `555-01xx` range,
which is the correct choice for test data because those numbers are guaranteed
never to be assigned to anyone. **The live funnel rejects them**, measured:

```
run failed: Funnel did not advance past the contact step:
  ... Please enter a valid phone number ...
```

That row still produced a TrustedForm certificate, because TrustedForm issues
one when the page loads, but no lead was submitted.

This is a real constraint on the experiment rather than a bug to route around:
**a submission this funnel accepts necessarily carries a phone number that could
belong to a real person.** A guaranteed-fictional number cannot be submitted.
Whoever runs a live batch has to decide what number to use, and that is not a
decision the harness should make silently — so it makes none. Rows the funnel
rejects are reported and excluded from the business CSV.

## Rejected submissions never reach the business CSV

TrustedForm issues a certificate on page load, so a row the funnel *rejected*
still has a real certificate attached. Writing that row into the business CSV
would make a lead that does not exist look identical to one that does. Only
submissions the funnel accepted are written; every row, accepted or not, stays
in the forensic record with the reason. The summary prints what was omitted.

## The test-record gate

Each submission produces a real TrustedForm certificate, which is consent
evidence about the person it names. The harness therefore **refuses by default
to submit rows that do not look like synthetic or authorized test data.**

A row is recognized as test data by either:

- a reserved email domain — `example.com` / `.net` / `.org`, or `.test`,
  `.invalid`, `.localhost` (RFC 2606 / RFC 6761 — these can never receive mail); or
- a test marker in the name: `test`, `testlead`, `donotcontact`, `qa`, `sample`,
  `synthetic`.

Rows failing both are listed and the batch stops with exit code 3.
`--allow-non-test-records` overrides this for authorized records; the override
is recorded per row in the forensic output as `recognizedAsTestRecord: false`.

## Generated qualification variables

The form asks qualification questions the source CSV does not carry. Those are
generated to fixed distributions. **They are experimental input variables, not
assertions about a real person**, and every one is recorded in that row's
forensic record alongside the note saying so.

| field | distribution |
|---|---|
| `military`, `cancer`, `heart disease` | constant `No` |
| `coverage amount` | constant `$25,000 (Funeral Expenses)` |
| `currently insured` | No 90% / Yes 10% |
| `married` | No 50% / Yes 50% |
| `homeowner` | Yes 70% / No 30% |
| `tobacco` | No 95% / Yes 5% |
| `credit score` | uniform over the four tiers the live form offers |
| `height` | weighted by gender, submitted in inches |
| `weight` | male 155–275 lbs, female 120–210 lbs, uniform integer |

`--seed <n>` makes a batch exactly reproducible. `test/unit.js` verifies every
distribution against 40,000 samples.

### The form's vocabulary, not the specification's

The answer strings were read off the live funnel with
`scripts/probeFunnelVocabulary.js`, not assumed. Two differ from the original
specification, and the form wins:

- **Credit score** is four tiers — `700+ Excellent`, `700-640 Good`,
  `640-560 Fair`, `560- Poor` — not the five-tier `Poor (300-579)` scale.
- **Height** is a `<select>` of **inches** as strings, `"55"`–`"83"`. Heights
  specified as `5'10"` are submitted as `"70"`. Both forms are recorded
  (`heightInches` and `heightLabel`).

### The female height table sums to 110%

As specified, the female weights total 110, not 100:

```
15 + 15 + 12 + 10 + 8 + 10 + 10 + 10 + 5 + 5 + 5 + 5 = 110
```

They are used as **relative weights and normalized**, which preserves every
ratio in the specification — `5'4"` stays 15/8 as likely as `5'0"` — while
making the distribution sum to 1. `5'4"` lands at 13.6% rather than 15%. The
normalization is printed at the top of every run and asserted in the unit tests.
The male table sums to exactly 100 and is unaffected.

### Weight is a slider, not an input

The live `#/weight` step has **no input element**. It carries an
angularjs-slider: a `<span role="slider">` with `aria-valuemin="100"`,
`aria-valuemax="400"`, defaulting to `160`. `readStep` only reports
`input`/`select`/`textarea`, so this control was invisible to the runner and
**weight was never set by any earlier run** — every submission took the slider's
default regardless of what `--weight` said.

It is now driven from the keyboard, because that is the only way to move it and
because the harness's premise is that the page receives the events a person
would produce. The key deltas are measured at runtime rather than assumed: press
once, read `aria-valuenow`, learn the step, then close the gap with page and
arrow keys. The value the slider actually reached is recorded as
`weightSubmitted`.

In `--entry-mode fill` the slider is **skipped** and a `field-skipped` event is
recorded. That arm exists to demonstrate that `fill()` emits no key events at
all, and moving a slider by keyboard inside it would contaminate the measurement.

## Running

```bash
node scripts/batchCsvRunner.js --test-mode --input test/fixtures/sample-leads.csv
```

| flag | meaning |
|---|---|
| `--test-mode` | required |
| `--input <file>` | input CSV (required) |
| `--output <file>` | final CSV (default `<report-dir>/leads-<batchId>.csv`) |
| `--report-dir <path>` | forensic output (default `test-reports/`) |
| `--cohort <name>` | `short`, `medium`, `long` or `mixed` (default `mixed`, rotating) |
| `--concurrency <n>` | rows to run at once, 1-8 (default 3, or `BATCH_CONCURRENCY`) |
| `--limit <n>` | process only the first n rows |
| `--seed <n>` | reproduce a batch exactly |
| `--telemetry-keys` | `redacted` (default) or `raw` |
| `--entry-mode` | `type` (default) or `fill` |
| `--dry-run` | sanitize, generate and print. Submits nothing. |
| `--offline-selftest` | drive the loopback mock funnel. No proxy, no live submit. |
| `--allow-non-test-records` | permit rows that do not look like test data |

`--dry-run` and `--help` do not require `playwright-core`, so the pipeline can be
inspected on a machine with no browser installed.

## Concurrency

Rows run **several at a time** - three by default, `--concurrency n` to change
it. A row takes 30-60 seconds whatever else is happening, so a 383-row batch
that took about five hours one-at-a-time takes closer to a hundred minutes at
three, and under an hour at five.

Nothing about an individual row changes. Each still gets its own browser
process, its own IPRoyal sticky session and its own certificate, and still
closes fully when it is done; no cookies, storage or proxy peer is shared
between rows, concurrent or not. That isolation is exactly what makes them safe
to overlap.

What the ceiling is really about is memory: a concurrent row is a full Chromium
process, so budget ~600MB each and leave the host its own headroom. On the
8GB/4-vCPU server the harness runs on, 3-4 is comfortable and the dashboard will
not offer more than `BATCH_MAX_CONCURRENCY` (4 unless an operator raises it).
Past that the host starts swapping, which stretches the very session durations
the experiment exists to measure.

Two details worth knowing:

- **Starts are staggered** by `BEHAVIOR_BETWEEN_RUNS_MS` (3s by default), so N
  browsers never open the funnel on the same tick.
- **Order is preserved.** Rows finish out of order - a `long` cohort row takes
  three minutes while two `short` ones come and go - but the business CSV, the
  forensic record and the progress table are all written in input order, so a
  batch reads the same as its input file however it was scheduled. A seeded
  batch (`--seed`) also reproduces identically at any concurrency.

## Output

### 1. The business CSV

Exactly these headers, in this order:

```
firstName,lastName,phone,email,address,city,state,zipCode,birthdate,gender,ipAddress,trustedFormURL,datePosted
```

- `ipAddress` — the egress IP the browser was **observed** to have, not the one
  requested from IPRoyal. Where the two differ, both are kept in the forensic
  record (`proxy.ip` versus the selected session).
- `trustedFormURL` — the certificate that browser session actually produced.
- `datePosted` — execution date as `MM/DD/YYYY`.

**Nothing here is fabricated.** If a run produced no certificate or no observed
IP, the field is left empty rather than filled in.

### 2. The forensic record

- `runs/<runId>.json` — the full record: source row, generated qualification
  values, proxy IP and geo result, target vs actual duration, interaction
  counts, field order, scroll events, keystroke timeline, TrustedForm
  certificate, decoded signals, submission result, errors.
- `captures/<runId>.json` — the raw TrustedForm capture for that row.
- `behavioral-<batchId>.json` — the batch roll-up.

The CSV is the convenient business output; the JSON and captures are the QA and
forensic record.

### 3. The dashboard's Submissions page

Every row the funnel accepts is also stored in the `submissions` collection as
the run settles, so it appears on the dashboard's Submissions page alongside
organic form posts. Rows the funnel rejected are not stored, which is the rule
the business CSV already follows, so the page and the CSV never disagree about
which leads exist.

Batch rows carry `source: 'batch'` and the batch id they came from, and the page
shows them with a small `batch` marker. `GET /api/submissions?source=batch` (or
`?source=form`) filters to one or the other.

They are stored with what the run observed - the egress IP, the certificate, the
geolocation, the elapsed time and the qualification answers actually submitted.
Where a run produced no IP, certificate or user agent, the field reads `unknown`
rather than a plausible-looking value, and a lead with no real certificate does
not earn the certificate's share of the quality score.

Storing a row can never fail a batch: the funnel has already taken the
submission and issued the certificate by that point, so a database problem is
logged, counted in the batch summary (`rows on Submissions page:`) and otherwise
ignored.

### Importing batches that ran before this existed

Batches run before the runner stored its rows left their leads on disk only.
Import them with:

```bash
node scripts/backfillBatchSubmissions.js --dry-run   # report, write nothing
node scripts/backfillBatchSubmissions.js             # import every batch found
node scripts/backfillBatchSubmissions.js --batch <id>
```

It prefers `behavioral-<batchId>.json`, and falls back to a batch's `leads.csv`
for one that was interrupted before its forensic record was written - that
source has no qualification answers or user agent, and those stay unset rather
than being re-drawn. Re-running is a no-op: one document per batch row is
enforced by a unique index.

## Verification

```bash
npm run test:unit      # 38 checks, distributions verified over 40k samples
npm run test:offline   # the behavioural harness against the mock funnel
```

The mock funnel in `test/mock-funnel/` mirrors the live form's height `<select>`
of inches and its keyboard-driven weight slider, so the offline suite exercises
the same controls the live run does.
