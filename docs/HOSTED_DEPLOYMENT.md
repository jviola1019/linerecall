# Downloaded-artifact hosting, versioning, and rollback

This document governs the immutable self-contained `linerecall.html` route.
The connected frontend/API deployment is separately defined by `server/` and
`infra/`; it uses authenticated API routes, cookies, PostgreSQL, Redis, and
provider adapters and therefore requires its own staging headers, origin,
privacy, authentication, and operational evidence. Do not apply the static
artifact's `connect-src 'none'` policy to the connected frontend, and do not
weaken the downloaded artifact to accommodate the connected service.

## Current deployment status

No production host is enabled. The retained app-wire-v2 candidate is
review-only, `dist/linerecall.html` is intentionally absent, and accounts,
magic links, passkeys, cloud sync, personal imports, shares, and provider
connections are disabled in the static build. The connected service has local
implementation and test boundaries, but it has not passed real credentialed
staging, backup/restore, deletion, quota, provider, or assistive-technology
review. Chess.com integration remains off.

GitHub Pages is a no-cost candidate for publishing static bytes, but it does
not provide repository-controlled arbitrary response headers for a Pages site.
LineRecall's required exact response CSP, `frame-ancestors`, HSTS,
anti-framing, permissions, cache-class, COOP, and CORP contract therefore
cannot be proven or applied there through the repository workflow. A CSP meta
element inside the HTML does not implement the full response-header contract;
in particular, `frame-ancestors` is a response-header requirement. Pages must
not be described as a production host for the audited route unless the policy
is changed through qualified review or GitHub adds a verified exact-header
mechanism. The downloaded file remains the guaranteed offline surface.

No paid hosting, database, runner, storage, or edge product may be enabled.
The AWS and OCI configurations are unapplied reference infrastructure only.
Only `en-US` is enabled; the other six planned locales remain release-gated.

The downloaded `linerecall.html` is protected by its embedded hash-only CSP.
A hosted release has an additional threat surface: clickjacking, content-type
confusion, referrer leakage, unused browser capabilities, stale CDN bytes, and
edge-side HTML injection. The production host must translate the generated
`build/candidate/hosting-manifest.json` literally. It must not hand-maintain a
second CSP.

The manifest is generated only after CSP hardening and contains the exact
SHA-256 and byte length of the audited HTML. `npm run hosting:audit` recomputes
the manifest from the candidate and fails if the HTML, embedded CSP, response
CSP, route, cache class, or required headers differ. This follows OWASP's
guidance that response-header delivery is preferred for CSP and is required for
the full feature set, including `frame-ancestors`:

- [OWASP Content Security Policy Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html)
- [OWASP HTTP Security Response Headers Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Headers_Cheat_Sheet.html)

## Required deployment contract

1. Serve only over HTTPS. Redirect HTTP before serving the application. The
   response policy includes a one-year, host-scoped HSTS directive. Do not add
   `includeSubDomains` or `preload` without separately confirming every affected
   hostname is permanently HTTPS-capable.
2. Publish the exact audited bytes at the manifest's content-addressed route
   first. Its `Cache-Control` is `public, max-age=31536000, immutable`.
3. Make `/linerecall.html` an atomic alias to those same bytes. Its
   `Cache-Control` is `no-store, max-age=0, must-revalidate`, so an update cannot
   leave users on a stale mutable entry point.
4. Apply every header in the selected manifest route, including the exact
   `Content-Security-Policy`, `frame-ancestors 'none'`, `X-Frame-Options: DENY`,
   `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, the empty
   `Permissions-Policy` allowlists, COOP/CORP, and HSTS.
5. Disable host/CDN HTML rewriting, script injection, analytics injection,
   automatic minification, and edge personalization. Any byte change invalidates
   the CSP hashes and the audited receipt. Transfer compression is allowed only
   when decoding produces the exact receipt bytes.
6. Do not add cookies, authentication, telemetry, a service worker, or runtime
   API calls to the immutable downloaded-artifact route. Connected application
   routes must be separate and must not rewrite these bytes. Set the same
   privacy/MIME/framing headers on artifact redirects and error responses where
   the platform permits it.

`config/hosting-policy.json` is provider-neutral on purpose. A platform adapter
may convert its generated manifest to a CDN, object-store, reverse-proxy, or
static-host configuration, but the adapter must be tested against the deployed
response rather than assumed correct.

GitHub Pages is not currently such an adapter because the required exact
response headers cannot be configured. A successful Pages upload or a matching
body SHA-256 alone does not satisfy this contract.

## Deployment verification

Before changing the public alias:

```text
npm run artifact:harden
npm run hosting:manifest
npm run hosting:audit
npm run test:e2e
```

Then retrieve the immutable URL and alias without accepting a cached response.
Verify the downloaded SHA-256, byte length, `Content-Type`, exact response CSP,
anti-framing headers, cache class, and all other manifest headers. Confirm that
the host returns neither `Set-Cookie` nor injected markup and that the browser
makes no subresource request after the document navigation. A successful local
test is not evidence that a production CDN applied the configuration; retain a
dated header/body capture from the real origin and public edge.

## Versioning and rollback

- Never replace bytes at an existing content-addressed route. A changed file is
  a new release with a new SHA route and new manifest.
- Retain the last two independently audited HTML receipts at minimum, subject to
  the organization's incident-retention policy.
- Roll back by atomically repointing the mutable alias to the exact prior audited
  bytes and prior matching header manifest. Do not rebuild an old source tree or
  mix an old HTML body with a new CSP.
- After rollback, repeat public-edge hash/header, offline, session-memory, JSON
  export/import, and basic drill/puzzle smoke tests. Record the rollback reason,
  previous and restored SHA-256 values, operator, and time.
- The artifact does not persist to browser storage. Cloud and supported Claude
  Artifact storage remain behind `ProgressRepository`; before any incompatible
  event/settings migration, prove deterministic backward replay and export in
  staging or block rollout. Never silently merge conflicting legacy state.

Only bytes with a passing `dist/SHIPPABLE.json` may be described as a production
release. The candidate manifest supports staging and audit; it does not override
the unresolved manual assistive-technology, legal, or trademark gates.
