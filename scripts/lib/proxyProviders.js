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
// The two vendors put it in opposite halves of the auth pair:
//
//   IPRoyal   password suffix   user / pass_country-us_city-jerseycity_...
//   Shifter   username suffix   customer-user-country-us-city-jersey_city-... / pass
//
// So buildCredentials returns BOTH halves and every call site must use both.
// Passing a static username alongside a Shifter targeting password sends an
// untargeted username, and the run then succeeds with a wrong-city IP - the
// worst failure mode available here, because nothing reports an error.

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

const PROVIDERS = { shifter, iproyal };
const DEFAULT_PROVIDER = 'shifter';

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

module.exports = { PROVIDERS, DEFAULT_PROVIDER, resolveProvider, shifter, iproyal, shifterToken, iproyalToken };
