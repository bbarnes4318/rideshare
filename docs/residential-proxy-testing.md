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
