# Zero-cost connected staging and manual evidence

This runbook separates work that can be completed at no monetary cost from
release gates that still require an account owner, physical devices, external
credentials, or a qualified reviewer. It does not weaken the release contract
and it does not authorize a paid tier, metered overage, public development
server, or production claim.

## Current boundary

The public repository can verify source and bounded fixtures at no charge. The
CI job is configured to run PostgreSQL 18 and Redis as ephemeral service
containers and test:

- PostgreSQL major version 18.
- The runtime role is a non-owner, non-superuser, `NOBYPASSRLS` login.
- Every user-owned table both enables and forces row-level security.
- A single reused pool connection cannot carry one tenant into another.
- A missing `app.user_id` fails closed.
- The authentication role has no grants on application tables.
- The exact-token share function exposes only the selected immutable revision.
- Redis applies the distributed counter atomically across repeated requests.

This is real dependency testing, not connected-staging evidence. The runner and
its databases are destroyed after the job; no email, passkey, OAuth, durable
backup, public edge, or physical-device workflow is exercised.

GitHub documents that standard runners for public repositories are free and
that `ubuntu-latest` currently supplies 4 CPU cores, 16 GB RAM, and 14 GB SSD.
It also documents a six-hour job limit and first-class PostgreSQL/Redis service
containers. Those limits are suitable for this gate, not the 87.2 GB corpus:

- [GitHub-hosted runner specifications](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- [GitHub Actions limits](https://docs.github.com/en/actions/reference/limits)
- [Containerized services](https://docs.github.com/en/actions/tutorials/use-containerized-services)

## No-cost option matrix

| Surface | No-cost use | What it can prove | What it cannot prove | Status |
| --- | --- | --- | --- | --- |
| Public GitHub Actions | Standard runner plus pinned PostgreSQL/Redis images | Migrations, forced RLS, pooled isolation, Redis coordination, application tests | Persistence, public HTTPS, passkeys, email, provider OAuth, recovery | Implemented; automated input only |
| GitHub Codespaces personal allowance | Short-lived interactive staging | HTTPS browser sessions, real containers, desktop/manual testing | Durable production, full corpus, guaranteed remaining allowance | Optional; owner must create and inspect quota |
| Local machine plus a Quick Tunnel | Temporary HTTPS from a built staging surface | Physical-phone browser and assistive-technology sessions | Stable RP ID, stable OAuth redirect, SLA, production hosting | Optional; not configured |
| Separate Neon Free project | PostgreSQL 18 TLS/RLS and short restore exercises | External database path and credential separation | 35-day PITR, Multi-AZ/SLA, Redis, API compute, object storage | Account/credential action required |
| Cloudflare Pages Free | Static immutable artifact with `_headers` | Exact static response headers and public-edge body/header capture | Connected API, PostgreSQL, private sync | Candidate only; no account/project configured |
| GitHub Pages | Static bytes | Basic public download | Repository-controlled exact response-header policy | Rejected by the current hosting contract |
| Supabase Free | Small PostgreSQL project | General database experiments | Locked PostgreSQL 18 target and required recovery posture | Rejected for this release |
| Oracle A1 Always Free | ARM VM if capacity exists | Potential API/container staging | Capacity, account access, and availability | Unavailable in the selected region/account |

### GitHub Codespaces guardrail

Personal GitHub Free accounts currently include 120 core-hours and 15 GB-month
of Codespaces usage. A 2-core codespace therefore has at most about 60 hours of
compute before other use is counted. GitHub states that usage is blocked after
the included quota if no valid payment method and spending limit are present.
If the account has billing enabled, the owner must configure a product budget
with **Stop usage when budget limit is reached** before creating a codespace.
Delete the codespace immediately after evidence export so its storage stops
accruing.

- [Included GitHub product usage](https://docs.github.com/en/billing/reference/product-usage-included)
- [Codespaces included-usage behavior](https://docs.github.com/en/codespaces/troubleshooting/troubleshooting-included-usage)
- [GitHub budgets and hard stops](https://docs.github.com/en/billing/how-tos/set-up-budgets)
- [Codespaces HTTPS port forwarding](https://docs.github.com/en/codespaces/developing-in-a-codespace/forwarding-ports-in-your-codespace)

Codespaces is not approved for the corpus job. Its 15 GB-month allowance is
smaller than the compressed Q2 corpus, never mind bounded deltas and replay.

### Temporary phone access

Cloudflare documents accountless Quick Tunnels for development and testing.
They produce a random `trycloudflare.com` HTTPS hostname, limit concurrent
requests to 200, do not support server-sent events, and have no uptime SLA. A
new hostname changes the WebAuthn relying-party identity and cannot serve as a
stable Lichess redirect. Use one only for a supervised physical-device review,
against a built staging surface, after checking the Cloudflare terms. Never
expose Vite development mode, local admin routes, archives, credentials, or a
database port.

- [Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
- [Cloudflare local tunnel security guidance](https://developers.cloudflare.com/workers/local-development/local-dev-tunnels/)

The repository does not currently provide the required same-origin staging
reverse proxy or a safe local magic-link delivery adapter. Those are engineering
prerequisites before a tunnel can test the complete authentication flow.

### Separate PostgreSQL project

Neon currently advertises a Free plan with no credit card, 0.5 GB storage, 100
CU-hours per project, and six-hour time travel. Its compatibility documentation
supports PostgreSQL 18 but still describes it as preview. This is sufficient for
a disposable external-database exercise, not the required production recovery
contract. The owner must create a separate LineRecall project and transfer its
TLS connection values out of band; an existing unrelated website database must
not be reused.

- [Neon Free plan](https://neon.com/pricing)
- [Neon PostgreSQL compatibility](https://neon.com/docs/reference/compatibility)

No connection string, password, CA, token, or provider identifier belongs in a
commit, issue, PR, screenshot, test attachment, shell transcript, or chat.

### Static hosting after all release gates

Cloudflare Pages Free documents repository-defined `_headers` on static assets,
including CSP and anti-framing headers. It also limits an individual header line
to 2,000 characters and a single static asset to 25 MiB. A future adapter may
translate the generated hosting manifest into `_headers`, then retrieve the
public edge and compare every header and byte digest. This does not authorize a
deployment now, and it does not replace the connected service.

- [Cloudflare Pages custom headers](https://developers.cloudflare.com/pages/configuration/headers/)
- [Cloudflare Pages Free limits](https://developers.cloudflare.com/pages/platform/limits/)

## Staging execution order

1. Bind the run to the exact Git commit, connected-source snapshot SHA-256,
   hardened candidate SHA-256, and production data release ID.
2. Require a promoted production-data manifest. Synthetic fixtures may test
   behavior but cannot be used in a staging pass.
3. Run the public CI dependency gate and retain the run URL and immutable log
   artifact. A passing job is only an automated prerequisite.
4. Create a separate staging environment under the owner account. Confirm the
   zero-dollar hard stop before resources exist.
5. Use PostgreSQL 18 with distinct migration, application, authentication, and
   share-owner roles. Apply Better Auth migrations from the exact pinned CLI,
   then the reviewed application migration order.
6. Verify real TLS, `FORCE ROW LEVEL SECURITY`, non-owner pooled reuse, replay,
   multi-device ordering, quota errors, export, deletion, and credential
   revocation. Retain only redacted, content-addressed evidence.
7. Exercise magic-link delivery, one-time use, five-minute expiry, passkey
   enrollment/authentication/revocation, session rotation, and recent-auth
   account deletion at one stable HTTPS origin.
8. Exercise Redis loss, PostgreSQL loss, email loss, object-store loss, worker
   death, provider 429, cancellation, dead letter, and recovery. A local mock may
   diagnose behavior but cannot prove the corresponding live provider.
9. Perform backup and restore into a clean target, compare row counts and
   cryptographic digests, and record measured RPO/RTO. A six-hour free restore
   window cannot prove the required 35-day production policy.
10. Destroy the staging environment, revoke tokens, remove forwarded ports, and
    verify that no secrets entered retained evidence.

## Manual accessibility evidence at no software cost

NVDA is free, VoiceOver is built into iPhone, and TalkBack is included on
Android. The software cost can therefore be zero when the required physical
hardware is already owned or borrowed:

- [NVDA download and documentation](https://www.nvaccess.org/download/)
- [Apple VoiceOver on iPhone](https://support.apple.com/guide/iphone/turn-on-and-practice-voiceover-iph3e2e415f/ios)
- [Google TalkBack setup](https://support.google.com/accessibility/android/answer/6283677)

For each browser/device combination, retain reviewer identity, date, OS,
browser, assistive-technology version, device model, viewport/orientation,
exact route and steps, expected and observed speech/focus, result, severity,
owner, remediation commit, retest, and attachment digests. Test the entire
matrix in `docs/ACCESSIBILITY_AUDIT.md`, including physical touch, 200%/400%
zoom, keyboard-only, forced colors, reduced motion, text spacing, bottom-sheet
focus, board alternatives, autonomous family transitions, and tactical forced
replies.

Owning the software is not qualification. A named reviewer with appropriate
accessibility competence must approve the WCAG/Section 508 mapping, and
engineering evidence must continue to say “targets WCAG 2.2 AA” rather than
claiming certification. The DOJ likewise describes accessibility obligations
and technical standards; it does not turn an automated scan into ADA approval:

- [WCAG 2.2](https://www.w3.org/TR/WCAG22/)
- [DOJ web accessibility guidance](https://www.ada.gov/resources/web-guidance/)

## Human, legal, and independent-review blockers

The following gates have no honest automatic substitute:

- A chess/editorial reviewer must approve all family decisions and all 3,790
  primary taxonomy assignments. Generated proposals remain proposals.
- Fluent human reviewers must approve each enabled locale. The six non-English
  locales stay disabled; Arabic additionally requires RTL and assistive-
  technology review.
- A qualified accessibility reviewer must approve the mapping and manual
  evidence.
- A qualified legal reviewer must cover trademark, privacy, terms, age
  handling, sharing, licenses, subprocessors, and public representations. A
  free USPTO search is useful preliminary evidence, not clearance or advice:
  [USPTO trademark search resources](https://www.uspto.gov/trademarks).
- An independent security reviewer must assess the exact release source and
  deployed configuration. CodeQL, dependency scans, and this agent's review are
  inputs, not independence.

The owner may recruit competent volunteer or pro-bono reviewers, but the
repository cannot promise their availability or mark their records as passed.
If the necessary reviewer or physical device is unavailable under the no-spend
constraint, the corresponding production gate remains blocked.

## Release evidence discipline

- Never edit a template from `not_run` to `pass` before the exact exercise.
- Never reuse evidence after either the candidate or connected-source digest
  changes.
- Store redacted attachments as immutable SHA-256-addressed receipts and list
  them in the evidence record. Narrative notes alone are not evidence.
- Do not record provider tokens, email addresses, IP addresses, database URLs,
  cookies, passkey credential IDs, personal game data, or raw logs containing
  them.
- A successful zero-cost staging exercise does not satisfy Multi-AZ, 35-day
  PITR, five-minute RPO, two-hour RTO, stable production RP ID, production email
  reputation, or production-provider SLA requirements.

Under the locked no-spend policy, the static offline application can eventually
be released after its data and manual gates pass. The full connected production
service cannot honestly be called production until durable hosting, recovery,
email, key management, object storage, Redis, stable HTTPS, and qualified
reviews are available under an approved operating model.
