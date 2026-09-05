import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const directory = 'infra/oci-zero-spend'

async function source(name: string): Promise<string> {
  return readFile(`${directory}/${name}`, 'utf8')
}

function variableBlock(text: string, name: string): string {
  const marker = `variable "${name}"`
  const start = text.indexOf(marker)
  assert.notEqual(start, -1, `missing ${marker}`)
  const next = text.indexOf('\nvariable "', start + marker.length)
  return text.slice(start, next === -1 ? text.length : next)
}

test('OCI reference fails closed before declaring any resource', async () => {
  const variables = await source('variables.tf')
  const main = await source('main.tf')

  for (const name of [
    'deployment_enabled',
    'enable_compute',
    'enable_object_storage',
    'home_region_verified',
    'always_free_account_state_verified',
    'chicago_a1_capacity_verified',
    'assign_public_ipv4',
    'enable_public_https',
  ]) {
    assert.match(variableBlock(variables, name), /default\s+=\s+false/u, `${name} must default false`)
  }

  assert.match(variableBlock(variables, 'zero_spend_acknowledgement'), /default\s+=\s+""/u)
  assert.match(variableBlock(variables, 'verified_existing_a1_ocpus'), /default\s+=\s+2\b/u)
  assert.match(variableBlock(variables, 'verified_existing_a1_memory_gb'), /default\s+=\s+12\b/u)
  assert.match(variableBlock(variables, 'verified_existing_block_storage_gb'), /default\s+=\s+200\b/u)
  assert.match(variableBlock(variables, 'verified_existing_object_storage_bytes'), /default\s+=\s+20000000000\b/u)

  const resourceHeaders = [...main.matchAll(/resource\s+"(oci_[^"]+)"\s+"([^"]+)"\s+\{/gu)]
  assert.ok(resourceHeaders.length >= 10, 'expected a concrete but disabled OCI reference')
  for (const match of resourceHeaders) {
    const bodyStart = match.index ?? 0
    const opening = main.slice(bodyStart, bodyStart + 260)
    assert.match(
      opening,
      /\n\s+(?:count|for_each)\s+=\s+/u,
      `${match[1]}.${match[2]} must be gated before any cloud request`,
    )
  }

  assert.match(main, /count\s+=\s+var\.deployment_enabled\s+&&\s+\(var\.enable_compute\s+\|\|\s+var\.enable_object_storage\)/u)
  assert.match(main, /zero_spend_acknowledgement\s+==\s+"I_VERIFIED_CURRENT_OCI_USAGE_AND_ALWAYS_FREE_ELIGIBILITY"/u)
})

test('OCI compute stays within the current conservative Always Free envelope', async () => {
  const main = await source('main.tf')
  const variables = await source('variables.tf')

  assert.match(main, /a1_ocpus\s+=\s+1\b/u)
  assert.match(main, /a1_memory_gb\s+=\s+6\b/u)
  assert.match(main, /boot_volume_size_gb\s+=\s+50\b/u)
  assert.match(main, /a1_ocpu_limit\s+=\s+2\b/u)
  assert.match(main, /a1_memory_limit_gb\s+=\s+12\b/u)
  assert.match(main, /block_storage_limit_gb\s+=\s+200\b/u)
  assert.match(main, /shape\s+=\s+"VM\.Standard\.A1\.Flex"/u)

  assert.match(main, /verified_existing_a1_ocpus\s+\+\s+local\.a1_ocpus\s+<=\s+local\.a1_ocpu_limit/u)
  assert.match(main, /verified_existing_a1_memory_gb\s+\+\s+local\.a1_memory_gb\s+<=\s+local\.a1_memory_limit_gb/u)
  assert.match(main, /verified_existing_block_storage_gb\s+\+\s+local\.boot_volume_size_gb\s+<=\s+local\.block_storage_limit_gb/u)
  assert.match(main, /verified_existing_object_storage_bytes\s+\+\s+var\.object_storage_reserved_bytes\s+<=\s+local\.object_storage_limit_bytes/u)

  assert.match(variableBlock(variables, 'region'), /default\s+=\s+"us-chicago-1"/u)
  assert.match(variableBlock(variables, 'region'), /var\.region\s+==\s+"us-chicago-1"/u)
  assert.match(main, /var\.chicago_a1_capacity_verified/u)
  assert.doesNotMatch(main, /fault_domain/u)
})

test('OCI reference excludes paid families, broad SSH, secrets, and quota mutation', async () => {
  const files = await Promise.all([
    source('providers.tf'),
    source('variables.tf'),
    source('main.tf'),
    source('outputs.tf'),
  ])
  const hcl = files.join('\n')

  for (const prohibited of [
    /oci_database_/u,
    /oci_redis_/u,
    /oci_load_balancer_/u,
    /oci_core_nat_gateway/u,
    /resource\s+"oci_core_volume"/u,
    /resource\s+"oci_core_public_ip"/u,
    /oci_containerengine_/u,
    /oci_limits_quota/u,
    /tenancy_ocid\s*=/u,
    /user_ocid\s*=/u,
    /fingerprint\s*=/u,
    /private_key(?:_path)?\s*=/u,
  ]) {
    assert.doesNotMatch(hcl, prohibited)
  }

  assert.match(variableBlock(await source('variables.tf'), 'ssh_ingress_cidrs'), /cidr\s+!=\s+"0\.0\.0\.0\/0"/u)
  assert.match(hcl, /versioning\s+=\s+"Disabled"/u)
  assert.match(hcl, /access_type\s+=\s+"NoPublicAccess"/u)
  assert.match(hcl, /are_legacy_imds_endpoints_disabled\s+=\s+true/u)
  assert.match(hcl, /is_pv_encryption_in_transit_enabled\s+=\s+true/u)

  const gitignore = await readFile('.gitignore', 'utf8')
  for (const ignored of ['.oci/', '**/.terraform/', '*.tfstate', '*.tfplan', 'terraform.tfvars', '*.auto.tfvars']) {
    assert.ok(gitignore.includes(ignored), `sensitive infrastructure output must be ignored: ${ignored}`)
  }
})

test('OCI provider, license boundary, and unapplied limitations are documented', async () => {
  const versions = await source('versions.tf')
  const tofuTests = await source('zero-spend.tftest.hcl')
  const readme = await source('README.md')
  const toolchain = JSON.parse(await readFile('infra/toolchain-dependencies.json', 'utf8')) as {
    dependencies: Array<Record<string, unknown>>
  }

  assert.match(versions, /source\s+=\s+"oracle\/oci"/u)
  assert.match(versions, /version\s+=\s+"= 8\.21\.0"/u)
  assert.match(tofuTests, /mock_provider\s+"oci"/u)
  assert.match(tofuTests, /length\(oci_core_instance\.linerecall\)\s+==\s+0/u)
  assert.match(tofuTests, /expect_failures\s+=\s+\[terraform_data\.zero_spend_guard\[0\]\]/u)
  assert.ok(toolchain.dependencies.some((dependency) => (
    dependency.identifier === 'registry.opentofu.org/oracle/oci'
      && dependency.license === 'MPL-2.0'
      && dependency.declarationPath === 'infra/oci-zero-spend/versions.tf'
      && dependency.providerLockStatus === 'generated-and-reviewed-no-apply'
  )))

  for (const required of [
    'unapplied reference',
    'Out of capacity',
    'FIDO',
    'A quota does not prove host capacity',
    'OpenTofu is not installed',
    'Do not run `plan`',
    'cannot enforce the byte total',
  ]) {
    assert.ok(readme.includes(required), `README must preserve limitation: ${required}`)
  }
})
