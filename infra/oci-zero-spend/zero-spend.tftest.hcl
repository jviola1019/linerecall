mock_provider "oci" {}

run "disabled_by_default" {
  command = plan

  assert {
    condition     = length(terraform_data.zero_spend_guard) == 0
    error_message = "The master guard must not enter a default plan."
  }

  assert {
    condition     = length(oci_core_instance.linerecall) == 0
    error_message = "Compute must not enter a default plan."
  }

  assert {
    condition     = length(oci_objectstorage_bucket.evidence) == 0
    error_message = "Object Storage must not enter a default plan."
  }
}
run "compute_requires_acknowledgement" {
  command = plan

  variables {
    deployment_enabled                 = true
    enable_compute                     = true
    home_region_verified               = true
    always_free_account_state_verified = true
    chicago_a1_capacity_verified       = true
    compartment_ocid                   = "ocid1.compartment.oc1..test"
    availability_domain                = "test:US-CHICAGO-1-AD-1"
    ubuntu_image_ocid                  = "ocid1.image.oc1..test"
    ssh_public_key                     = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestOnlyPublicKey LineRecall-test"
    verified_existing_a1_ocpus         = 0
    verified_existing_a1_memory_gb     = 0
    verified_existing_block_storage_gb = 0
  }

  expect_failures = [terraform_data.zero_spend_guard[0]]
}

run "compute_rejects_consumed_allowance" {
  command = plan

  variables {
    deployment_enabled                 = true
    enable_compute                     = true
    zero_spend_acknowledgement         = "I_VERIFIED_CURRENT_OCI_USAGE_AND_ALWAYS_FREE_ELIGIBILITY"
    home_region_verified               = true
    always_free_account_state_verified = true
    chicago_a1_capacity_verified       = true
    compartment_ocid                   = "ocid1.compartment.oc1..test"
    availability_domain                = "test:US-CHICAGO-1-AD-1"
    ubuntu_image_ocid                  = "ocid1.image.oc1..test"
    ssh_public_key                     = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestOnlyPublicKey LineRecall-test"
  }

  expect_failures = [oci_core_instance.linerecall[0]]
}
