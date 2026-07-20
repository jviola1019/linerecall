# LineRecall security policy

LineRecall is designed as an offline-first, self-contained application. It has
no telemetry, API keys, user accounts, runtime chess-data API calls, or remote
code. Search, move sequences, PGN, progress imports, opening names, and embedded
snapshot bytes are treated as untrusted.

## Supported version

No public production version has been released. The repository currently
contains development code and audit scaffolding; it must not be represented as
security-certified or shippable unless `dist/SHIPPABLE.json` was created by a
complete passing release audit.

## Reporting a vulnerability

Report vulnerabilities privately through the repository's GitHub Security
Advisory form. Do not include real credentials, sensitive progress exports, or
third-party personal data in a public issue.

Include the affected commit, browser/OS, reproduction steps, impact, and a
minimal non-sensitive proof. The release owner should acknowledge the report,
triage severity, and agree on coordinated disclosure before publication. No
response-time promise is made before a staffed security process exists.

## Enforced build controls

- Runtime source is checked for raw-HTML sinks, dynamic code, dynamic scripts,
  client network APIs, telemetry SDKs, executable URLs, and browser storage
  outside the approved `ProgressRepository` strategy.
- The final HTML is checked for external subresources/network APIs and a 10 MiB
  size ceiling. Its CSP contains hashes for every embedded script/style and
  denies all network connections.
- The opening snapshot must appear exactly once in an inert `application/json`
  script container. The build escapes raw-text delimiters, and the artifact
  audit parses the container and verifies its version plus all 500 partitions.
- A high-signal credential scan redacts candidate values from its report.
- Production dependencies are audited for high/critical vulnerabilities;
  dependency and source licenses are checked against an explicit allowlist.
- A CycloneDX SBOM records software, shipped data, and excluded audit tools.
- Failed or missing automated/manual evidence leaves `dist/linerecall.html` and
  its shippable marker absent; the separately named candidate remains available
  for diagnosis.
- `npm run security:source-snapshot` inventories and hashes the connected API,
  migrations, hosted client, infrastructure, security/release tooling, tests,
  package locks, and build policy. Completed security and connected-staging
  evidence must record that manifest's `treeSha256` as
  `sourceSnapshotSha256`; any source-byte change invalidates the review. A
  `not_run` record remains a blocker and is not promoted by generating a hash.

The CSP meta tag protects the downloaded document, but `frame-ancestors` is not
enforced from a meta-delivered CSP. Hosted responses are therefore generated
from the exact hardened bytes through `config/hosting-policy.json` and the
build-bound `hosting-manifest.json`. The response policy adds anti-framing,
MIME, referrer, permissions, cross-origin, and HTTPS headers; the release audit
rejects a stale body/header pair. Translation to an actual provider and
public-edge verification remain deployment responsibilities described in
`docs/HOSTED_DEPLOYMENT.md`.
