'use strict';
//
// Residential proxy vendors, behind one interface.
//
// The ZIP -> closest-residential-IP process in funnelCore.js is unchanged by
// which vendor is in use: it still walks a narrowest-first tier ladder, probes
// candidate sticky sessions over plain HTTP, verifies each egress IP against
// ip-api, and hands the browser the session it verified. The only thing that
// differs between vendors is how targeting is *encoded*, and that is the whole
// of what lives here.
//
// The vendors disagree about which half of the auth pair carries it:
//
//   Geonode   username suffix   user-type-residential-country-US-city-jerseycity-... / pass
//   Shifter   username suffix   customer-user-country-us-city-jersey_city-...        / pass
//   IPRoyal   password suffix   user / pass_country-us_city-jerseycity_...
//
// So buildCredentials returns BOTH halves and every call site must use both.
// Passing a static username alongside a Geonode or Shifter targeting password
// sends an untargeted username, and the run then succeeds with a wrong-city IP
// - the worst failure mode available here, because nothing reports an error.

// --------------------------------------------------------------------------
// Geonode (primary)
// --------------------------------------------------------------------------

// Geonode location tokens carry no separator at all: the documented examples
// are "city-newyork" and "state-california". Doc pages disagree with each other
// about the casing of place names, so they are folded to lowercase here; the
// country code is documented as an uppercase ISO 3166-1 alpha-2 value and is
// emitted that way below.
//
// This is byte-for-byte what iproyalToken does today and is still its own
// function, for the same reason shifterToken is: the vendors resolve these
// slugs against different pools, and sharing one function is how one of them
// silently starts receiving the other's rules the first time either changes.
function geonodeToken(value) {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// strict-on refuses rather than letting the gateway substitute a nearby IP.
// Geonode documents strict as its default, but the flag is emitted explicitly
// anyway so the ladder's intent does not depend on that default holding - and
// so the country floor can say strict-off, which it must: the floor exists to
// always complete, and inheriting a strict default there would turn the last
// rung into one more way for a run to fail outright.
// Set GEONODE_STRICT_TARGETING=false to let the gateway broaden on every rung.
const GEONODE_STRICT = String(process.env.GEONODE_STRICT_TARGETING || 'true').toLowerCase() !== 'false';

// Same three rungs as the other two ladders, with one vendor-specific twist:
// Geonode refuses a state and a city in the same username ("You cannot target
// both state and city at the same time"), so the top rung is country+city with
// no state beside it. That is the shape IPRoyal's ladder already has, arrived
// at for an unrelated reason - Shifter is the odd one out in sending all three.
const GEONODE_TIERS = [
  { name: 'city (Geonode country+city, strict)', state: false, city: true, strict: GEONODE_STRICT },
  { name: 'state only', state: true, city: false, strict: GEONODE_STRICT },
  { name: 'country only', state: false, city: false, strict: false },
];

const geonode = {
  id: 'geonode',
  host: process.env.GEONODE_PROXY_HOST || 'proxy.geonode.io',
  // Geonode splits its ports by session type rather than by protocol alone:
  // HTTP rotating is 9000-9010 and HTTP sticky is 10000-10900. The rotating
  // range hands out a fresh IP per request, which would show TrustedForm
  // several source IPs inside one funnel run, so the default is a sticky port.
  port: Number(process.env.GEONODE_PROXY_PORT || 10000),
  usernameEnv: 'GEONODE_PROXY_USERNAME',
  passwordEnv: 'GEONODE_PROXY_PASSWORD',
  sessionAttempts: Number(process.env.GEONODE_SESSION_ATTEMPTS || 8),
  // Minutes, not seconds. Geonode's own default is 10 with an accepted range of
  // 3 to 1440; a funnel run outlives 10 minutes, so this is never omitted when
  // a session id is sent.
  sessionLifetimeMinutes: Number(process.env.GEONODE_SESSION_LIFETIME_MINUTES || 30),
  tiers: GEONODE_TIERS,
  normalizeToken: geonodeToken,

  buildCredentials({ username, password, location, session, tier = GEONODE_TIERS[0] }) {
    // type-residential is always sent. The sticky port pins the session type,
    // not the IP pool, so an account that also carries datacenter or ISP IPs
    // will otherwise serve them here without anything saying so.
    const flags = ['type-residential', 'country-US'];
    if (tier.state) flags.push('state-' + geonodeToken(location.stateName));
    if (tier.city) flags.push('city-' + geonodeToken(location.city));
    flags.push(tier.strict ? 'strict-on' : 'strict-off');
    // lifetime only means anything alongside a session id, so the two are
    // emitted together or not at all. Pinning one peer for the whole run is the
    // point: Geonode otherwise rotates and TrustedForm would observe several
    // different source IPs in one session.
    if (session) {
      flags.push('session-' + session, 'lifetime-' + geonode.sessionLifetimeMinutes);
    }
    return { username: [username, ...flags].join('-'), password };
  },

  // Geonode publishes its own status codes instead of reusing the usual proxy
  // ones, and they are numerically unrelated to the other two vendors': an
  // out-of-peers answer is 465 here, not Shifter's 503/502/404 or IPRoyal's
  // 402.
  //
  // Verified against proxy.geonode.io:10000 on 2026-09-04, and unlike Shifter
  // this gateway matched its own docs: a bad slug ("city-jersey_city") is a
  // 403, a strict miss is a 465, and a wrong password is a 407. The remaining
  // codes below are still documented-only.
  describeFailure(probe) {
    if (probe.statusCode === 407) {
      return 'Geonode returned 407 Authentication Failure: check GEONODE_PROXY_USERNAME / GEONODE_PROXY_PASSWORD, or whether this machine\'s IP still needs to be whitelisted in the Geonode dashboard.';
    }
    if (probe.statusCode === 403) {
      return 'Geonode returned 403 Invalid Request Configuration: a targeting flag in the username is malformed or unsupported. The two likeliest causes are a state and a city sent together (Geonode accepts one or the other, never both) and a place name that is not in Geonode\'s own locations list.';
    }
    if (probe.statusCode === 465) {
      return 'Geonode returned 465 No Proxies Available: no residential IPs matched the requested targeting. Broaden the target, or set GEONODE_STRICT_TARGETING=false to let the gateway widen the pool.';
    }
    if (probe.statusCode === 466) {
      return 'Geonode returned 466 Bandwidth Exhausted: the plan\'s traffic is used up. Top up or upgrade the Geonode residential plan.';
    }
    if (probe.statusCode === 467) {
      return 'Geonode returned 467 Session Bandwidth Limit Reached: this sticky session hit its own bandwidth limit, which cannot be raised until the session expires. Start a new session.';
    }
    if (probe.statusCode === 411) {
      return 'Geonode returned 411 Account Blocked: the account has been suspended. No change to the targeting here will help - contact Geonode support.';
    }
    if (probe.statusCode === 464) {
      return 'Geonode returned 464 Connection Blocked: Geonode policy refuses the destination host, IP or port. This is about where the request is going, not about the targeting.';
    }
    if (probe.statusCode === 500 || (probe.statusCode >= 517 && probe.statusCode <= 569)) {
      return `Geonode returned HTTP ${probe.statusCode}: a Geonode-side error rather than a configuration problem. Retry; if every probe returns it, contact Geonode support.`;
    }
    if (probe.statusCode) {
      return `Geonode returned HTTP ${probe.statusCode} ${probe.statusMessage || ''}`.trim();
    }
    return `Could not reach the Geonode proxy: ${probe.error}`;
  },
};

// --------------------------------------------------------------------------
// IPRoyal
// --------------------------------------------------------------------------

// IPRoyal location tokens are lowercase alphanumeric with NO separator:
// "_city-losangeles" resolves, "_city-los-angeles" is refused outright.
// Verified against geo.iproyal.com:12321 on 2026-08-31.
function iproyalToken(value) {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// IPRoyal documents targeting as country + city with no state token, and that
// lands more accurately than adding one. Widen only if a tier has no peers.
const IPROYAL_TIERS = [
  { name: 'city (IPRoyal country+city form)', state: false, city: true },
  { name: 'state only', state: true, city: false },
  { name: 'country only', state: false, city: false },
];

const iproyal = {
  id: 'iproyal',
  host: process.env.IPROYAL_PROXY_HOST || 'geo.iproyal.com',
  port: Number(process.env.IPROYAL_PROXY_PORT || 12321),
  usernameEnv: 'IPROYAL_PROXY_USERNAME',
  passwordEnv: 'IPROYAL_PROXY_PASSWORD',
  sessionAttempts: Number(process.env.IPROYAL_SESSION_ATTEMPTS || 8),
  sessionLifetimeMinutes: Number(process.env.IPROYAL_SESSION_LIFETIME_MINUTES || 30),
  tiers: IPROYAL_TIERS,
  normalizeToken: iproyalToken,

  buildCredentials({ username, password, location, session, tier = IPROYAL_TIERS[0] }) {
    const tokens = [password, 'country-us'];
    if (tier.state) tokens.push('state-' + iproyalToken(location.stateName));
    if (tier.city) tokens.push('city-' + iproyalToken(location.city));
    // Pin one peer for the whole run; IPRoyal otherwise rotates per request and
    // TrustedForm would observe several different source IPs in one session.
    if (session) {
      tokens.push('session-' + session, 'lifetime-' + iproyal.sessionLifetimeMinutes + 'm');
    }
    return { username, password: tokens.join('_') };
  },

  describeFailure(probe) {
    if (probe.statusCode === 402) {
      return 'IPRoyal returned 402 Payment Required: the credentials are accepted but the account has no remaining balance/traffic. Top up the IPRoyal residential plan.';
    }
    if (probe.statusCode === 407) {
      return 'IPRoyal returned 407 Proxy Authentication Required: check IPROYAL_PROXY_USERNAME / IPROYAL_PROXY_PASSWORD.';
    }
    if (probe.statusCode) {
      return `IPRoyal returned HTTP ${probe.statusCode} ${probe.statusMessage || ''}`.trim();
    }
    return `Could not reach the IPRoyal proxy: ${probe.error}`;
  },
};

// --------------------------------------------------------------------------
// Shifter
// --------------------------------------------------------------------------

// Shifter city and region names use underscores for spaces, NOT IPRoyal's
// bare concatenation. Deliberately not shared with iproyalToken: the two
// vendors want different strings for the same place, and folding them into one
// function is how one vendor silently starts receiving the other's slugs.
//
// Measured against p.shifter.io:443 on 2026-09-02: "city-los_angeles" lands in
// Los Angeles, while IPRoyal's "city-losangeles" is accepted and then answered
// with Burbank - a mismatch with no error, which is why this is its own function.
function shifterToken(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// strict-true disables the gateway's default broadening. Without it a probe
// burns a request returning an IP that was never going to match; with it the
// gateway refuses, fetchThroughProxy reports not-ok, and the existing attempt
// loop widens to the next tier on an honest signal. Set SHIFTER_STRICT_TARGETING
// to "false" to fall back to the broadening behavior.
const SHIFTER_STRICT = String(process.env.SHIFTER_STRICT_TARGETING || 'true').toLowerCase() !== 'false';

// One-for-one with the IPRoyal ladder: exact match, state-only, then a
// non-strict country floor that always completes.
const SHIFTER_TIERS = [
  { name: 'city (Shifter country+region+city, strict)', region: true, city: true, strict: SHIFTER_STRICT },
  { name: 'state only', region: true, city: false, strict: SHIFTER_STRICT },
  { name: 'country only', region: false, city: false, strict: false },
];

const shifter = {
  id: 'shifter',
  host: process.env.SHIFTER_PROXY_HOST || 'p.shifter.io',
  port: Number(process.env.SHIFTER_PROXY_PORT || 443),
  usernameEnv: 'SHIFTER_PROXY_USERNAME',
  passwordEnv: 'SHIFTER_PROXY_PASSWORD',
  sessionAttempts: Number(process.env.SHIFTER_SESSION_ATTEMPTS || 8),
  // Seconds, not minutes. The gateway's own default is 120s, which expires
  // part-way through a funnel run, so this is never omitted when a sid is sent.
  sessionTtlSeconds: Number(process.env.SHIFTER_SESSION_TTL_SECONDS || 1800),
  tiers: SHIFTER_TIERS,
  normalizeToken: shifterToken,

  buildCredentials({ username, password, location, session, tier = SHIFTER_TIERS[0] }) {
    const flags = ['country-us'];
    if (tier.region) flags.push('region-' + shifterToken(location.stateName));
    if (tier.city) flags.push('city-' + shifterToken(location.city));
    if (tier.strict) flags.push('strict-true');
    // ttl is only valid alongside sid, so both are emitted together or not at all.
    if (session) flags.push('sid-' + session, 'ttl-' + shifter.sessionTtlSeconds);
    return { username: [username, ...flags].join('-'), password };
  },

  // Status codes below are what p.shifter.io:443 actually returned on
  // 2026-09-02, which is not what the published docs describe. The docs say an
  // unknown flag is a 407 and a strict miss is a 502; measured, an unknown flag
  // is a 400 and a strict miss is a 503, a 502 or a 404 depending on which part
  // of the filter came up empty. All of them are handled the same way by the
  // tier ladder - they just need to read correctly in a log.
  describeFailure(probe) {
    if (probe.statusCode === 407) {
      return 'Shifter returned 407 Proxy Authentication Required: check SHIFTER_PROXY_USERNAME / SHIFTER_PROXY_PASSWORD. (Measured: 407 is credentials only; a bad targeting flag comes back as 400.)';
    }
    if (probe.statusCode === 400) {
      return 'Shifter returned 400 Bad Request: an unknown or malformed targeting flag is in the username. A bad city/region slug is the likeliest cause - Shifter wants underscores ("city-jersey_city"), not IPRoyal\'s bare form ("city-jerseycity"). A single 400 mid-ladder can also be transient; one on every probe is not.';
    }
    if (probe.statusCode === 404 || probe.statusCode === 502 || probe.statusCode === 503) {
      return `Shifter returned HTTP ${probe.statusCode}: no residential IPs matched the requested targeting. Broaden the target or unset SHIFTER_STRICT_TARGETING to let the gateway widen the pool.`;
    }
    if (probe.statusCode === 509) {
      return 'Shifter returned 509 Bandwidth Limit Exceeded: the plan\'s traffic is used up. Enable Extra Traffic or top up the Shifter plan.';
    }
    if (probe.statusCode) {
      return `Shifter returned HTTP ${probe.statusCode} ${probe.statusMessage || ''}`.trim();
    }
    return `Could not reach the Shifter proxy: ${probe.error}`;
  },
};

// --------------------------------------------------------------------------

const PROVIDERS = { geonode, shifter, iproyal };
const DEFAULT_PROVIDER = 'geonode';

/**
 * Resolve the active provider. An unrecognised value is a hard error rather
 * than a silent fall back to the default: quietly running the whole batch on
 * the wrong vendor is not a failure anyone would notice in time.
 */
function resolveProvider(id) {
  const requested = id === undefined ? process.env.PROXY_PROVIDER : id;
  const key = String(requested || DEFAULT_PROVIDER).trim().toLowerCase();
  const provider = PROVIDERS[key];
  if (!provider) {
    throw new Error('Unknown PROXY_PROVIDER "' + requested + '". Supported: '
      + Object.keys(PROVIDERS).join(', ') + '.');
  }
  return provider;
}

module.exports = {
  PROVIDERS, DEFAULT_PROVIDER, resolveProvider,
  geonode, shifter, iproyal,
  geonodeToken, shifterToken, iproyalToken,
};
