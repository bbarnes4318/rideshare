# TrustedForm residential-IP testing

The existing `/api-proxy/` endpoint cannot change the IP TrustedForm observes because TrustedForm's script executes in the visitor browser. The test runner therefore launches the actual browser through IPRoyal before opening `quotes.nationallifecoverage.org`.

## How the ZIP is mapped

1. The submitted five-digit ZIP is resolved locally with the existing `zipcodes` package.
2. Its city and state are used as IPRoyal residential routing constraints.
3. The browser verifies its public egress IP through `ipv4.icanhazip.com`.
4. The same browser session opens the quote page, allowing TrustedForm to run through that residential connection.
5. The runner waits until `#xxTrustedFormCertUrl` contains the real TrustedForm certificate URL before clicking **See My Rates**.

IPRoyal's documented router syntax uses `_country-`, `_state-`, and `_city-` targeting keys. Its public documentation does not document a ZIP targeting key, so city/state targeting is used as the closest supported location match. citeturn123905search3turn123905search7

## Setup

Use Node.js 18+ and an installed Chrome/Chromium binary. Install dependencies with:

```bash
npm install
```

Set the variables from `.env.residential-proxy.example` in the process environment. Never commit the real IPRoyal credentials.

## Run

```bash
npm run submit:proxy -- \
  --zip 00000 \
  --dob 01/01/1970 \
  --address "123 Main St" \
  --fname Test \
  --lname Lead \
  --email test@example.com \
  --phone 5555555555
```

Replace the example test data with the authorized test record supplied for the ActiveProspect assessment.

The runner prints:

- the ZIP-derived city/state and centroid
- the browser's observed residential egress IP
- the TrustedForm certificate URL
- the form response

The proxy credentials are intentionally kept out of source control. IPRoyal documents `geo.iproyal.com:12321` for HTTP/HTTPS residential proxy connections and password-based location targeting. citeturn123905search7turn123905search6

## Why the browser must be proxied

TrustedForm's certificate records the network source of the browser that runs
`api.trustedform.com/trustedform.js`. That observation happens client-side, so it
cannot be influenced by `X-Forwarded-For`, `X-Real-IP`, any other request header,
a JavaScript-assigned value, or a post-hoc database edit. The only way for
TrustedForm to see a residential IP is for the browser process itself to egress
through the residential proxy, which is what this runner does: Chromium is
launched with IPRoyal configured as its HTTP proxy, so the page load, the
TrustedForm script, its pings, and the `/api-proxy/` POST all share that egress.

Nginx still sets `X-Real-IP` / `X-Forwarded-For` on the reverse-proxy hop. Those
are ordinary reverse-proxy headers used by the Express rate limiter and are
unrelated to what TrustedForm observes.

## ZIP targeting is approximate, by design

IPRoyal's residential router exposes country, state, and city targeting keys in
the password. It does not expose a ZIP key in this implementation. The runner
therefore resolves ZIP -> city/state with the `zipcodes` package and targets the
city/state. **The egress IP is city/state-accurate, not ZIP-accurate.** The ZIP
centroid latitude/longitude is printed for reference only; it is not sent to
IPRoyal.

`zipcodes` reports the two-letter state code (`TN`), while IPRoyal expects the
spelled-out name, so the runner maps it through `zipcodes.states.abbr`
(`TN` -> `tennessee`) before building the password.

## Preflight diagnostics

`scripts/proxyDiagnostics.js` issues a raw HTTP `CONNECT` to the proxy before
Chromium is launched. This separates proxy/account faults from browser faults:

| CONNECT status | Meaning |
| --- | --- |
| `200` | Tunnel established; proxy usable |
| `407` | Credentials rejected - check `IPROYAL_PROXY_USERNAME` / `IPROYAL_PROXY_PASSWORD` |
| `402` | Credentials accepted but the IPRoyal account has no remaining balance/traffic |

## Runner behaviour notes

- `#date_of_birth` is an `<input type="date">`. Playwright's `fill()` only accepts
  `YYYY-MM-DD` on that control, so the CLI's `--dob MM/DD/YYYY` is converted
  before filling. The page's own submit handler still emits `MM/DD/YYYY` in the
  `/api-proxy/` payload, which is unchanged.
- `#weight` is an `<input type="range">`; it is set by assigning `value` and
  dispatching `input` + `change` so the readout and `FormData` both update.
- `#response-message` is always present in the DOM but empty, so the runner waits
  for non-empty text rather than for visibility alone.
- Chromium runs with `--no-sandbox --disable-dev-shm-usage --disable-gpu` and a
  capped renderer count, and the browser is always closed in a `finally` block so
  no orphan Chrome processes are left on the shared-CPU host.
- The runner exits non-zero on any failure.
