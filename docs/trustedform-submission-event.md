# The missing TrustedForm submission event

ActiveProspect reported that TrustedForm can see the consent language but
appears to be missing the form submission event, and recommended Consent Tags
with `use_tagged_consent=true`. Those tags were already present. The hypothesis
under test was therefore the submission *mechanism*: that this repository's
`preventDefault()` + `fetch()` handler stops TrustedForm from recording
`form_submitted`.

**It does not.** Measured, on the live page, through the residential proxy:
cancelling the submit event with `preventDefault()` and POSTing with `fetch()`
produces exactly the same TrustedForm submission events as letting the browser
submit the form natively.

The submission event really is missing — but from the **affiliate funnel**, not
from this page, and for a different reason.

## Read this first

`quotes.nationallifecoverage.org` does not serve this repository's
`index.html`. It redirects to a hosted AngularJS funnel at
`/fv3/nationallifecoverage/1051/` owned by the affiliate network. The
certificates ActiveProspect is looking at come from **that** page. See
`docs/behavioral-testing.md` ("Selectors: which ones are real").

## How TrustedForm decides a form was submitted

Read off the SDK the page actually loads,
`cdn.trustedform.com/trustedform-1.12.10.js`. It emits one event code,
`fs` (`EVENT_FORM_SUBMIT`), from two places:

```js
"form" === e ? (Dt(n, "submit", ge), d.V[t] = !0)
             : "button" !== e && "input" !== e && "a" !== e || !jr(n)
               || (Dt(n, "click", Se), d.V[t] = !0)
```

* every `<form>` gets a **`submit`** listener (`ge`), and
* every element matching its submit-role selector list gets a **`click`**
  listener (`Se`), which emits `c`, then `fs`, then `sbc`.

That selector list, verbatim from the same file:

```js
Cr = ["input[data-tf-element-role=submit]", "button[data-tf-element-role=submit]",
      "a[data-tf-element-role=submit]", "button[type=submit]", "input[type=submit]",
      "form button:not([type=reset])", "form input[type=button]", "form input[type=image]"]
```

Two consequences follow, and both were confirmed by measurement.

**`preventDefault()` cannot suppress either path.** `preventDefault()` cancels
the *default action* of an event — the navigation — not its dispatch. Every
listener on the form still runs, TrustedForm's included.

**An `<a>` that is not tagged matches nothing.** It is not a `<form>`, so it
gets no submit listener, and it matches no entry in `Cr` unless it carries
`data-tf-element-role="submit"`. Nothing ever emits `fs`.

## What the affiliate funnel's submit control is

Read off the **live** funnel on 2026-09-09, by walking it to
`#/verify-information` and stopping there (no lead created):

```html
<a class="btn btn-next btn-submit" href="#/verify-information"
   data-ng-click="vm.submitData()" data-submit-btn="">Submit</a>
```

An `<a>`, with no `data-tf-element-role="submit"`, driving an Angular handler.
It matches none of the eight selectors above, so the **click** path never fires.

There *is* a real `<form id="verifyInfoForm" name="vm.verifyInfoForm">` around
the contact fields, so TrustedForm does attach its `submit` listener to it. That
listener never runs either: the anchor is a hash navigation plus
`vm.submitData()`, so nothing ever submits the form. Both of the SDK's two paths
to `fs` are dead — one for want of an attribute, the other for want of a
submission.

Also confirmed live on the same run:

* the loader carries **no `use_tagged_consent`**, so the tagged-consent feature
  ActiveProspect recommended is not enabled on the funnel at all;
* there are **zero `data-tf-element-role` attributes** anywhere on the page,
  contact step included;
* certificates *are* minting normally — the contact step's
  `input[name=xxTrustedFormCertUrl]` was populated.

Decoding an existing production capture's event stream
(`test-reports/short-01-20260901T034929Z-20kz9k.capture.json`):

```
form_submitted              : false
consent language found      : true
consent language metadata   : true
```

which is precisely what ActiveProspect described.

## The A/B test

Same page, same fields, same consent text, same tags, same SDK, same ZIP, same
lead, same proxy provider and city, same runner. The only difference is whether
JavaScript cancels the submit event, selected per page load by
`?submission-mode=native`.

| | AJAX (control) | NATIVE |
|---|---|---|
| mechanism | `preventDefault()` → `fetch()` JSON | browser POSTs `action="/api-proxy/"` |
| certificate | `31a46ac36d1a884f895f1b25c145999c740ff127` | `5e91f3642e1da46c6587eb0c3faa58d9835fd93e` |
| `form_submitted` | **true** (2 events, @5333ms, @5355ms) | **true** (2 events, @5336ms, @5338ms) |
| consent language found | true | true |
| tagged consent match | true | true |
| submit below consent | true | true |
| POST reached `/api-proxy/` | yes, `application/json` | yes, `application/x-www-form-urlencoded` |

Two `fs` events per run, in both variants: one from the click path
(`[.., "fs", 552, false, [566]]`, element 552 being the submit button) and one
from the form-submit path (`[.., "fs", 168, true]`, element 168 being the form).
Instrumenting the page confirms the second one is emitted by a TrustedForm
listener that runs **after** `handleSubmit` has already called
`preventDefault()`.

Reproduce with:

```bash
node scripts/submitWithResidentialProxy.js --submission-mode ajax   --capture ajax.capture.json
node scripts/submitWithResidentialProxy.js --submission-mode native --capture native.capture.json
npm run tf:analyze -- ajax.capture.json native.capture.json
```

## The measurement trap this test walked into

The first pair of runs reported `form_submitted: false` for AJAX and
`not available` for native, which looks like a result and is not one. Both
captures stopped at page-load events; the SDK never flushed another batch.

The cause was in the harness, not the page. The runner began filling fields a
few hundred milliseconds after `domcontentloaded`, while the TrustedForm SDK
was still loading. `scripts/submitWithResidentialProxy.js --probe-listeners`
showed TrustedForm's submit listener registering *and firing* in those runs
while nothing reached the wire. Waiting for the certificate before touching a
field — which is also what a real visitor does — produced complete streams: 18
captured TrustedForm exchanges became 32, and `fs` appeared in both variants.

Extending the settle window to 60 seconds did not help, the residential proxy
was not responsible, and neither was the fill method; each was ruled out with
its own run before the runner was changed. **A capture that ends at page load
is a broken instrument, not a negative result.** `/events POSTs decoded` in the
analyzer output is the check: if it is 3 and every offset is under 100 ms, the
session was never recorded and the run must be repeated.

## What this changes in the code

* `index.html` picks its submission mechanism from `?submission-mode`, default
  `ajax` — production behaviour, unchanged. The form now also carries a real
  `method="POST" action="/api-proxy/"`, which the AJAX path cancels and the
  native path uses.
* The Basic credential that `index.html` used to `btoa()` into every page is
  gone. `/api-proxy/` never verified it; it was only forwarded to
  `ORIGINAL_API_URL`. `middleware/formHandler.js` now supplies it from
  `ORIGINAL_API_AUTH`, or `ORIGINAL_API_USERNAME` / `ORIGINAL_API_PASSWORD`.
  A native browser form POST cannot set a request header, so this had to move
  regardless. **The old credential is in this repository's git history and
  should be rotated.**
* `/api-proxy/` answers a form-encoded POST with a small confirmation document
  and a JSON POST with JSON, so both variants share the one endpoint. The
  confirmation page loads no TrustedForm: a second SDK session there would open
  a second certificate for the same lead.
* `scripts/lib/tfEvents.js` decodes the event stream, which
  `scripts/lib/reporting.js` never opened — it flattened the JSON envelope but
  not the deflated, base64-encoded `body` inside it, where every submission
  signal lives. The existing `wpm`/`kpm` extraction is untouched.

## What still has to happen

The fix belongs on the affiliate funnel, and this repository cannot deploy it.
Either change is sufficient on its own:

* **add `data-tf-element-role="submit"`** to the
  `<a ... data-submit-btn>Submit</a>` control. `a[data-tf-element-role=submit]`
  is already in the SDK's selector list, so this needs no other change. This is
  the smaller ask.
* **or** have `vm.submitData()` submit `#verifyInfoForm` (e.g.
  `form.requestSubmit()`) instead of only navigating, so the `submit` listener
  TrustedForm has already attached to that form actually fires.

Separately, and independently of the submission event, their loader is missing
`use_tagged_consent=true` and the page carries no `data-tf-element-role`
attributes at all — so the Consent Tags ActiveProspect asked for are not
implemented on the funnel either.

Hand them the table above and the decoded capture. The claim is not "your funnel
might be misconfigured" but "your Submit control matches none of the eight
selectors your own SDK uses, nothing ever submits `#verifyInfoForm`, and here is
the event stream showing `cl` present and `fs` absent".
