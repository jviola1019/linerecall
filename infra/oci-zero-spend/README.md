# OCI zero-spend reference

This directory is an **unapplied reference**, not a deployment recipe or a claim that Oracle has capacity. Every resource switch defaults to `false`, current-usage variables default to the full documented allowance, and the acknowledgement is empty. With the defaults, the configuration declares zero resources.

It is intentionally blocked today:

- the tenancy is recorded as `us-chicago-1`, where A1 launch attempts returned `Out of capacity`;
- the Console also reported an active compartment quota policy consuming the regional A1 core and memory allowance;
- OCI sign-in is blocked by the user's malfunctioning FIDO authenticator;
- no OCI API key, profile, compartment OCID, image OCID, or SSH key has been supplied;
- no connected LineRecall staging audit has passed.

Do not work around FIDO, do not share a password, session token, private key, recovery code, or OCI config, and do not upgrade the account. Restore account access through Oracle's supported recovery process first. This project never needs the user's credentials in source control or chat.

## What this reference can declare

When every guard is deliberately satisfied, the configuration can declare:

- one `VM.Standard.A1.Flex` instance fixed at 1 OCPU and 6 GB memory;
- one 50 GB Oracle-managed encrypted boot volume, created with the instance;
- one VCN and subnet with default-deny ingress;
- optional restricted SSH, optional TCP 443, and no public IPv4 by default;
- one optional empty, private, non-versioned Object Storage bucket.

There is no database, Redis, load balancer, NAT gateway, reserved public IP, additional block volume, backup schedule, outbound email, DNS, or paid shape. The application and connected account service are not installed. The AWS reference remains a separate, unapplied production architecture and is not a zero-spend alternative.

Shielded and confidential-compute options are not asserted here. Oracle permits only supported shape/image/platform combinations, and the pinned provider's documented `platform_config` types do not establish an A1-compatible setting for this selected Ubuntu image. In-transit boot-volume encryption and legacy metadata endpoint disabling are encoded, but boot attestation remains an explicit security limitation. Before any compute plan, verify A1/image support from the current Console/provider schema and add a separately tested setting; do not guess at an incompatible platform type.

The optional bucket is not a production storage claim. OpenTofu can record a byte budget but cannot enforce the byte total or stop a later application or console user from exceeding it. Keep it disabled until an independently tested uploader, deletion policy, usage alarm, and current tenancy usage check exist.

## Current official ceilings encoded conservatively

Oracle's June 29, 2026 Free Tier documentation describes A1 Always Free as 1,500 OCPU-hours and 9,000 GB-hours per month, equivalent for an Always Free tenancy to 2 OCPUs and 12 GB memory. Oracle's Always Free resource page currently describes 200 GB total boot plus block storage, five volume backups, and 20 GB combined Object/Archive Storage. Eligibility is limited to the tenancy home region. The Console and current terms are authoritative; these numbers are not a billing guarantee.

The module uses a smaller 1-OCPU/6-GB instance and a 50-GB boot volume. It also requires the operator to enter current tenancy-wide usage, then blocks the plan if the proposed total would cross those ceilings. Defaults assume every allowance is already consumed, so omission fails closed.

Official references:

- <https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm>
- <https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm>
- <https://docs.oracle.com/en-us/iaas/Content/dev/terraform/configuring.htm>
- <https://docs.oracle.com/en-us/iaas/Content/dev/terraform/home.htm>
- <https://registry.terraform.io/providers/oracle/oci/8.21.0>

Always Free A1 instances can be reclaimed as idle when Oracle's documented seven-day CPU, network, and A1-memory criteria are all met. Artificial traffic or compute solely to evade reclamation is prohibited by this architecture. A service that cannot remain legitimately active is not suitable for this host.

## Capacity and quota are separate failures

An `Out of capacity` response means the selected availability domain currently has no host capacity for that shape. A quota does not prove host capacity, and a compartment quota cannot create it. The configuration intentionally omits `fault_domain`, following Oracle's guidance to avoid pinning one after a capacity failure.

The earlier quota policy began by setting compute quotas to zero and the later launch errors named that policy's `standard-a1-*-regional-count` limits. This repository does not manage tenancy quota policies. After FIDO recovery, inspect Governance & Administration → Limits, Quotas and Usage and the named policy in the Console. Have a tenancy administrator correct or remove it through a separately reviewed change. Do not paste speculative quota statements into the Console, and never change the root compartment merely to bypass a guard.

The `chicago_a1_capacity_verified` flag records a fresh manual observation; it does not reserve capacity. If Chicago remains full, leave compute disabled. Waiting is the only no-spend action represented here. A paid shape or another region is outside scope.

## Authentication boundary

The provider reads an operator-owned named profile from the normal OCI config location. The repository contains no tenancy/user OCIDs, fingerprints, API private keys, security tokens, or passwords. `.oci`, `.terraform`, state, plans, key files, and environment files are ignored.

Once supported account recovery is complete, create a dedicated least-privilege automation identity and API key through OCI's documented process. Keep the private key outside this workspace. Do not use a browser session token. A future IAM policy review must restrict the identity to the dedicated LineRecall compartment and the exact resource families in this module.

## Offline validation performed here

The repository test suite checks that:

- creation is disabled by default;
- every OCI resource is gated by the master switch and a service switch;
- only the fixed A1 shape, 1 OCPU, 6 GB memory, and 50 GB boot volume appear;
- usage defaults fail closed and total-use preconditions exist;
- public IPv4, HTTPS, SSH, object storage, and versioning are off by default;
- unrestricted SSH, fault-domain pinning, quota resources, paid service families, and credential fields are absent;
- the exact OCI provider is recorded in the license/SBOM toolchain boundary.

OpenTofu is not installed system-wide. For this audit, a portable OpenTofu 1.12.4 Windows archive was downloaded from the official release, verified against SHA-256 `16a8d272e368c8e4fdb5c665fb9dbb4bc89b505cf32895bc4d81c21dfd6beda9`, and kept under the ignored `.cache` directory. It formatted the module, initialized only the pinned provider with `-backend=false`, generated the committed provider lock, and returned `Success! The configuration is valid.` No OCI credential was read, no OCI API was called, and no cloud-backed plan or apply was run.

Repeat the offline checks before a future review:

```powershell
Set-Location infra/oci-zero-spend
tofu fmt -check -recursive
tofu init -backend=false
tofu validate
```

`init` downloads the pinned provider and must not contact OCI or create resources. Review any lock-file change. Do not run `plan` while FIDO/account recovery, quota review, current-usage review, and Chicago capacity remain unresolved.

## Gates before any future plan

1. Recover OCI access through Oracle support and replace the broken FIDO factor.
2. Confirm `us-chicago-1` is still the home region and the account is Always Free only.
3. Review the active quota policy and current tenancy-wide A1, boot/block, and object-storage usage.
4. Confirm A1 capacity without selecting a paid shape or pinning a fault domain.
5. Select the current Canonical Ubuntu 24.04 Minimal **aarch64** image from Chicago.
6. Create a dedicated compartment, least-privilege identity, API key, and SSH key outside the repository.
7. Recheck the committed `infra/oci-zero-spend/.terraform.lock.hcl` against the selected OpenTofu/provider release and review any change.
8. Run formatting, validation, security/license scans, and a saved plan with all resource switches still false.
9. Obtain a second review of the cost assumptions and plan. Enabling flags is a separate, explicit change.

Even after these gates, A1 capacity can disappear between a check and launch. A failed capacity attempt must leave the configuration disabled; it is not permission to select `VM.Standard.A2.Flex`, another paid shape, or another region.
