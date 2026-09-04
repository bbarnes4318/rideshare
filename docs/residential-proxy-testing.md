# TrustedForm residential-IP testing

> For the controlled behavioral study (randomized session durations, interaction
> timelines, cohorts and JSON/CSV reports), see
> [behavioral-testing.md](behavioral-testing.md). It reuses the proxy, ZIP
> routing and TrustedForm capture described here rather than replacing them.

The existing `/api-proxy/` endpoint cannot change the IP TrustedForm observes because TrustedForm's script executes in the visitor browser. The test runner therefore launches the actual browser through a residential proxy before opening `quotes.nationallifecoverage.org`.

**Geonode is the primary provider.** Shifter and IPRoyal both remain fully
supported as selectable fallbacks. Set `PROXY_PROVIDER=geonode` (the default),
`PROXY_PROVIDER=shifter` or `PROXY_PROVIDER=iproyal`; an unrecognised value is a
startup error rather than a silent default, and there is no automatic failover
between them - if the active provider's preflight fails, the run stops with that
provider's message.

## How the ZIP is mapped

This is identical for all three providers; only the credential encoding differs.

1. The submitted five-digit ZIP is resolved locally with the existing `zipcodes` package.
2. Its city and state become residential routing constraints, narrowest tier first.
3. Candidate sticky sessions are probed over plain HTTP and each egress IP is
   checked against ip-api. A city **and** state match is accepted immediately; a
   state-only match is held as a fallback.
4. The browser is launched on the very session that was probed, so TrustedForm
   observes the IP that was verified.
5. The runner waits until `#xxTrustedFormCertUrl` contains the real TrustedForm certificate URL before clicking **See My Rates**.

Neither provider exposes a ZIP targeting key, so city/state targeting is the
closest supported location match.

## Setup

Use Node.js 18+ and an installed Chrome/Chromium binary. Install dependencies with:

```bash
npm install
```

Set the variables from `.env.residential-proxy.example` in the process environment. Never commit the real proxy credentials.

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

The proxy credentials are intentionally kept out of source control. Geonode
serves sticky sessions from `proxy.geonode.io:10000`; Shifter serves everything
from `p.shifter.io:443`; IPRoyal uses `geo.iproyal.com:12321`.

## Why the browser must be proxied

TrustedForm's certificate records the network source of the browser that runs
`api.trustedform.com/trustedform.js`. That observation happens client-side, so it
cannot be influenced by `X-Forwarded-For`, `X-Real-IP`, any other request header,
a JavaScript-assigned value, or a post-hoc database edit. The only way for
TrustedForm to see a residential IP is for the browser process itself to egress
through the residential proxy, which is what this runner does: Chromium is
launched with the residential gateway configured as its HTTP proxy, so the page
load, the TrustedForm script, its pings, and the `/api-proxy/` POST all share
that egress.

Nginx still sets `X-Real-IP` / `X-Forwarded-For` on the reverse-proxy hop. Those
are ordinary reverse-proxy headers used by the Express rate limiter and are
unrelated to what TrustedForm observes.

## ZIP targeting is approximate, by design

Neither router exposes a ZIP key. The runner resolves ZIP -> city/state with the
`zipcodes` package and targets the city/state. **The egress IP is
city/state-accurate, not ZIP-accurate.** The ZIP centroid latitude/longitude is
printed for reference only; it is never sent to the provider.

## Geonode (primary)

Gateway `proxy.geonode.io`. Unlike the other two vendors, **the port selects the
session type**, not just the protocol:

| protocol | rotating | sticky |
| --- | --- | --- |
| HTTP/HTTPS | 9000-9010 | 10000-10900 |
| SOCKS5 | 11000-11010 | 12000-12010 |

The runner defaults to `10000`. A rotating port would hand out a fresh IP per
request, and TrustedForm would observe several source IPs inside one run - the
same reason IPRoyal needs an explicit `session` token. Anything in the sticky
range works if a specific port is wanted; set `GEONODE_PROXY_PORT`.

Credentials come from the Geonode dashboard (Proxies section) as a username /
password pair. The username is the base half of the auth pair and typically
carries a `geonode_` prefix; the endpoint the dashboard shows is the
`hostname:port:username:password` form of the same thing.

### Targeting lives in the username

Like Shifter and unlike IPRoyal, **the password is always sent unmodified** and
every flag is appended to the username with dashes:

```
geonode_USER-type-residential-country-US-city-jerseycity-strict-on-session-<id>-lifetime-30
```

| flag | meaning |
| --- | --- |
| `type-residential` | pin the IP pool to residential |
| `country-US` | ISO 3166-1 alpha-2, uppercase |
| `state-newjersey` | state, **never alongside a city** |
| `city-jerseycity` | city, **never alongside a state** |
| `strict-on` / `strict-off` | refuse, or allow a substitute location |
| `session-<id>` | sticky session id, 1-25 alphanumeric/underscore |
| `lifetime-<min>` | sticky lifetime in minutes; 3 to 1440 |
| `asn-<n>` | ISP/ASN; unused here, and only valid with a country |

`type-residential` is sent on every rung. The sticky port pins the session type,
not the IP pool, so an account that also carries datacenter or ISP IPs would
otherwise serve them here without anything saying so.

### Location tokens carry no separator

Geonode's own examples are `city-newyork` and `state-california`: bare
concatenation, which is **IPRoyal's rule and the exact opposite of Shifter's**.
Sending Shifter's `city-jersey_city` here is a 403. The country code is the one
token documented as uppercase.

### The sticky port pins an IP even with no session flag

Measured on 2026-09-04, and the first thing to know before testing by hand: on a
sticky port, **omitting `-session-` does not mean "no session"** - the port
itself holds one peer. Every request to `:10000` without a session id came back
as the same `174.166.50.198`, including one asking for a city that does not
exist. A hand test written that way looks like the targeting is being honoured
when nothing is being resolved at all. Always send a fresh `-session-` when
probing, which is what the runner does.

With distinct session ids on one port, peers differ as expected, and re-sending
the same id returns the same IP - verified twice on `70.111.76.134`. That is
what lets the browser launch on the very session that was probed.

### State and city are mutually exclusive

This is the one constraint Geonode adds that neither other vendor has: *"You
cannot target both state and city at the same time."* So the ladder's top rung
is country + city with **no state beside it**:

| tier | username flags |
| --- | --- |
| city | `country-US-city-jerseycity-strict-on` |
| state only | `country-US-state-newjersey-strict-on` |
| country only | `country-US-strict-off` |

That is the same shape IPRoyal's ladder has, reached for an unrelated reason -
Shifter is the odd one out in sending country, region and city together. A unit
test asserts no tier ever emits `-state-` and `-city-` in one username.

> Measured 2026-09-04: the live gateway **accepts** state and city together and
> answers correctly (Jersey City, `100.1.101.81`), so the documented prohibition
> is not enforced today. The ladder still sends one or the other - relying on a
> rule the vendor documents against costs nothing here, since the city rung
> already resolves on the first probe.

### The country floor must say `strict-off` explicitly

Geonode's documented default is strict, which is the reverse of Shifter, where
omitting the flag is what produces broadening. So the floor cannot simply leave
the flag off: it sends `strict-off` outright. The floor exists to always
complete, and inheriting a strict default there would turn the last rung into
one more way for the run to fail. `GEONODE_STRICT_TARGETING=false` drops strict
from the city and state tiers too.

On a strict miss Geonode answers `465`, and the body carries its own error
shape - `{"proxy-error":"country-fr-asn-3215 target was not found"}`.

### Status codes are Geonode's own

They are numerically unrelated to the other two vendors', so a code read across
from the Shifter table would be misinterpreted:

| code | meaning |
| --- | --- |
| 403 | malformed/unsupported targeting flag (state+city together, unknown place name) |
| 407 | authentication failure, or this machine's IP is not whitelisted |
| 411 | account blocked |
| 464 | destination host/IP/port refused by policy |
| 465 | no IPs matched the targeting |
| 466 | plan bandwidth exhausted |
| 467 | this session's own bandwidth limit reached |
| 500, 517-569 | Geonode-side error; retry |

Measured against `proxy.geonode.io:10000` on 2026-09-04, and unlike Shifter the
published codes held up:

| sent | got |
| --- | --- |
| `city-jersey_city` (Shifter's underscore form) | `403 Invalid request configuration. Invalid "city"` |
| `city-notarealcityxyz` + `strict-on` | `465 ... target was not found` |
| `city-notarealcityxyz` + `strict-off` | `200`, widened to Bradenton |
| wrong password | `407 Authentication error` |

The `strict-off` row is the one that matters for the ladder: it confirms the
country floor completes rather than erroring, which is the whole reason the
floor sends the flag explicitly.

## Shifter (selectable fallback)

Set `PROXY_PROVIDER=shifter`. One gateway, `p.shifter.io:443`, for HTTP(S) and SOCKS5. Port 443 is a port
number, not an instruction to speak TLS to the proxy: it takes ordinary
plain-HTTP proxy requests, which is why the raw `http.request` CONNECT in
`scripts/proxyDiagnostics.js` works against it unchanged.

### Targeting lives in the username

Shifter is the mirror image of IPRoyal: **the password is always sent
unmodified**, and every flag is appended to the username with dashes.

```
customer-USER-country-us-region-new_jersey-city-jersey_city-strict-true-sid-<id>-ttl-1800
```

| flag | meaning |
| --- | --- |
| `country-<code>` | ISO 3166-1 alpha-2, lowercase |
| `region-<name>` | state/region name, underscores for spaces |
| `city-<name>` | city name, underscores for spaces |
| `strict-true` | refuse rather than silently widen when nothing matches |
| `sid-<id>` | pin a sticky IP |
| `ttl-<seconds>` | sticky lifetime; valid only alongside `sid` |

Flag order does not matter to the gateway; the runner emits them in the order
above so logs are diffable.

**Every call site must use both halves of the returned pair.** Sending a static
account username alongside a targeted password is the one failure mode with no
error attached: the run succeeds and produces an IP from the wrong city.

### Token format (measured, not assumed)

Shifter wants **underscores** between words - the opposite of IPRoyal's bare
concatenation - so the two normalizers are deliberately separate functions.

| token | result |
| --- | --- |
| `city-jersey_city` | Jersey City IPs |
| `city-los_angeles` | Los Angeles IPs |
| `city-winston_salem` | Winston-Salem IPs |
| `city-losangeles` + `strict-true` | **200 OK, Burbank IP** - accepted and quietly wrong |
| `city-jerseycity` + `strict-true` | 200 OK, Jersey City IP - tolerated here, but do not rely on it |

That fourth row is the reason `shifterToken` exists and is tested: an
IPRoyal-style slug is not rejected, it is silently mis-served. `St. Louis` ->
`st_louis` and `Winston-Salem` -> `winston_salem`, with no doubled or trailing
underscores.

`zipcodes` reports the two-letter state code (`NJ`); the region tier maps it
through `zipcodes.states.abbr` (`NJ` -> `NEW JERSEY` -> `new_jersey`).

### The tier ladder

Narrowest first, mirroring the IPRoyal ladder one-for-one:

| tier | username flags |
| --- | --- |
| 1. city | `country-us` + `region-<state>` + `city-<city>` + `strict-true` |
| 2. state only | `country-us` + `region-<state>` + `strict-true` |
| 3. country only | `country-us` |

`strict-true` on tiers 1 and 2 is what makes the ladder honest. Without it the
gateway silently widens, and a probe burns a request on an IP that was never
going to match. With it the gateway refuses, `fetchThroughProxy` reports
not-ok, the attempt loop logs no-usable-egress, and after that tier's attempts
the existing "no peers" branch widens to the next tier - the same control flow
as before, on a real signal. Set `SHIFTER_STRICT_TARGETING=false` to restore
broadening.

The ip-api verification still runs on tiers 1 and 2. Shifter's geo database and
ip-api's do not have to agree, and the forensic record must reflect what ip-api
saw. Measured: `region-new_jersey-city-jersey_city-strict-true` returned three
Jersey City IPs and one Trenton IP across four distinct sids.

### The city vocabulary does not always match

Shifter's city list is its own. Measured on 2026-09-02, with `strict-true`:

| requested city | result |
| --- | --- |
| `city-jersey_city` | 200 |
| `city-chicago` | 200 |
| `city-knoxville` | 200 |
| `city-new_york` | 503 (no peers) |
| `city-st_louis` | 503 (no peers) |
| `city-saint_louis` | **404** - and 404 without `strict-true` too |

`Saint Louis` is exactly what `zipcodes` returns for 63101, so that ZIP falls
straight through to the state tier. That is the ladder working as designed, not
a fault.

### Sticky sessions

`sid-<id>` pins one peer; `ttl-<seconds>` sets its lifetime. **The gateway
default is 120 seconds**, which expires part-way through a funnel run, so the
runner never omits `ttl` when a `sid` is present. `SHIFTER_SESSION_TTL_SECONDS`
defaults to `1800`, matching the 30-minute IPRoyal lifetime it replaces.

Verified: the same sid returned the same IP on both requests; three different
sids returned different IPs. `ttl-1800`, `ttl-3600` and `ttl-86400` were all
accepted, so 1800 is nowhere near a ceiling. `ttl` without `sid` was also
accepted rather than refused, but it is meaningless and the runner does not
send it.

Session ids stay `nlc<random>`, unique per row, which satisfies Shifter's
do-not-share-a-sid-across-concurrent-workflows rule at the batch concurrency of
up to 8.

## IPRoyal (selectable fallback)

Set `PROXY_PROVIDER=iproyal`. Targeting is encoded in the **password**:

```
pass_country-us_city-jerseycity_session-<id>_lifetime-30m
```

IPRoyal location tokens are lowercase alphanumeric with **no separator**. A
hyphen is not ignored - the router refuses the tunnel outright:

| token | result |
| --- | --- |
| `_state-new-york` | no tunnel |
| `_state-newyork` | New York IPs |
| `_city-los-angeles` | no tunnel |
| `_city-losangeles` | Los Angeles IPs |

IPRoyal documents targeting as **country + city**, with no state token. Measured
hit rates show the state token over-constrains the pool:

| targeting | Nashville hit rate |
| --- | --- |
| `_country-us_city-nashville` | 3/4 |
| `_country-us_state-tennessee_city-nashville` | 2/4 |

So its ladder is `country + city`, then `state only`, then `country only`.
IPRoyal names New York City `newyorkcity`; `_city-newyork` has no peers at all
and returns 503.

By default IPRoyal rotates the exit IP **per request**, so one run egressed from
several peers - the browser reported `35.132.117.32` while the `/api-proxy/` POST
arrived from `204.63.10.157`. The runner pins one peer with
`_session-<id>_lifetime-30m` (verified: 3/3 identical IPs with a session, 3/3
different without).

## Preflight diagnostics

`scripts/proxyDiagnostics.js` issues a raw HTTP `CONNECT` to the gateway before
Chromium is launched, on the widest tier, so that a momentarily empty city
cannot be mistaken for a broken account. This separates proxy/account faults
from browser faults. The failure text comes from the active provider, because
the same status code means different things to each of them.

Shifter, measured against `p.shifter.io:443` on 2026-09-02:

| CONNECT status | Meaning |
| --- | --- |
| `200` | Tunnel established; gateway usable |
| `400` | Unknown or malformed targeting flag in the username - usually a bad city/region slug |
| `404` / `502` / `503` | No residential IPs matched the requested targeting; broaden it or unset `SHIFTER_STRICT_TARGETING` |
| `407` | Credentials rejected - check `SHIFTER_PROXY_USERNAME` / `SHIFTER_PROXY_PASSWORD` |
| `509` | Plan bandwidth exhausted; enable Extra Traffic or top up |

> A `400` is not always a bad slug: during a live state-tier run, seven probes
> on an identical, well-formed username returned `200` and the eighth returned
> `400`. Treat a single `400` mid-ladder as transient - the attempt loop already
> does - and a `400` on every probe as a real slug problem.

> Shifter's published documentation says an unknown flag returns `407` and a
> strict miss returns `502`. Neither held in practice: an unknown flag returned
> `400`, and a strict miss returned `503`, `502` or `404` depending on which
> part of the filter came up empty. `407` was returned only for a wrong password
> or an unknown customer. The codes above are the measured ones.

IPRoyal:

| CONNECT status | Meaning |
| --- | --- |
| `200` | Tunnel established; proxy usable |
| `407` | Credentials rejected - check `IPROYAL_PROXY_USERNAME` / `IPROYAL_PROXY_PASSWORD` |
| `402` | Credentials accepted but the IPRoyal account has no remaining balance/traffic |

Shifter has no `402`. A connection refused on Shifter means the legacy
port-based host is being used instead of `p.shifter.io:443`.

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
