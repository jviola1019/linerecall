# Zero-spend GitHub operating boundary

LineRecall's public static path is designed to incur no infrastructure charge.
This is an operating constraint, not a guarantee about future vendor policy.
Review the linked vendor terms before each production release.

## Approved use

- The repository must remain public while it relies on no-cost standard
  GitHub-hosted runners. GitHub currently states that standard runners are free
  for public repositories; larger runners are not free and are prohibited here.
  See [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
  and [runner selection](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job).
- Workflows use only `ubuntu-latest`, set timeouts, cancel superseded runs, and
  retain uploaded audit artifacts for one day. No larger runner, GPU runner,
  paid marketplace action, private package, or metered cloud service is used.
- GitHub's standard public Linux runner currently provides 14 GB of SSD storage
  and enforces a six-hour maximum per job. Those limits are materially smaller
  than the 87,256,474,116-byte Q2 source corpus and do not provide enough time
  or durable storage for the required candidate and exact replays. See the
  [hosted-runner specification](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
  and [Actions limits](https://docs.github.com/en/actions/reference/limits).
- GitHub Pages deployment is disabled. The manual workflow can verify and
  upload a one-day, non-deploying review bundle, but it has no Pages write or
  OIDC permission. Pages cannot apply LineRecall's required exact response
  headers. GitHub documents Pages availability and separate size, bandwidth,
  build, and acceptable-use limits in its
  [Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits).
- The full 87.2 GB corpus and engine campaign do not run on Actions. CI runs
  bounded fixtures, validators, coverage, security checks, and reproducibility
  checks only. Splitting the work into incomplete samples would not satisfy the
  release contract and is not represented as backtest evidence.

## Cost and security controls

- Every third-party action is pinned to a full commit SHA. GitHub recommends
  this as the immutable action reference in its
  [secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use).
- Both CI and the Pages review workflow have read-only repository permission.
  No job receives `pages: write` or OIDC `id-token: write`.
- Pages review is manual and requires a release ID and SHA-256 that match the
  schema-v3 `dist/SHIPPABLE.json`, exact release report, configured gate set,
  source/data/evidence bindings, and trusted release signature. A review
  candidate cannot satisfy the check, and even a verified bundle is not
  deployed.
- The repository excludes raw archives, SQLite databases, generated audit
  receipts, environment files, keys, OCI configuration, caches, and build
  output. The bounded embedded review snapshot is retained only to make source
  tests reproducible and is clearly identified as non-production schema v2.
- A one-dollar or higher billing event is a stop condition. Do not enable a
  larger runner, paid storage, private-repository overage, or a connected host
  without a new written owner decision.

## Remaining release decisions

GitHub Pages' terms and suitability for the intended public educational use
still require qualified legal review. Repository visibility also exposes all
committed source and bounded data, so the secret/license scan and source review
must pass before every push. No Pages environment is enabled while the current
production data, accessibility, localization, security, and legal gates remain
open.

The separate [zero-cost connected-staging and manual-evidence runbook](ZERO_COST_STAGING_AND_MANUAL_EVIDENCE.md)
defines what public CI, Codespaces, temporary device tunnels, a separate free
PostgreSQL project, and static hosting can and cannot prove. None of those paths
silently converts an ephemeral or synthetic check into production evidence.
