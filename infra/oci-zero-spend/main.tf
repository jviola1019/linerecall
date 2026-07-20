locals {
  a1_ocpus                   = 1
  a1_memory_gb               = 6
  boot_volume_size_gb        = 50
  a1_ocpu_limit              = 2
  a1_memory_limit_gb         = 12
  block_storage_limit_gb     = 200
  object_storage_limit_bytes = 20000000000

  compute_enabled = var.deployment_enabled && var.enable_compute
  bucket_enabled  = var.deployment_enabled && var.enable_object_storage

  common_tags = {
    Application = "linerecall"
    Environment = "zero-spend-reference"
    ManagedBy   = "OpenTofu"
    SpendPolicy = "always-free-only"
  }
}

resource "terraform_data" "zero_spend_guard" {
  count = var.deployment_enabled && (var.enable_compute || var.enable_object_storage) ? 1 : 0

  input = {
    region                 = var.region
    compute_enabled        = var.enable_compute
    object_storage_enabled = var.enable_object_storage
    guard_version          = 1
  }

  lifecycle {
    precondition {
      condition     = var.zero_spend_acknowledgement == "I_VERIFIED_CURRENT_OCI_USAGE_AND_ALWAYS_FREE_ELIGIBILITY"
      error_message = "Resource planning is blocked until current tenancy usage and Always Free eligibility are explicitly acknowledged."
    }

    precondition {
      condition     = var.home_region_verified && var.region == "us-chicago-1"
      error_message = "Resource planning is blocked until us-chicago-1 is freshly verified as the tenancy home region."
    }

    precondition {
      condition     = var.always_free_account_state_verified
      error_message = "Resource planning is blocked until the account and each selected resource are confirmed Always Free eligible in the Console."
    }

    precondition {
      condition     = !var.enable_compute || var.chicago_a1_capacity_verified
      error_message = "A1 compute remains blocked because Chicago host capacity has not been freshly verified. Quota availability is not host capacity."
    }

    precondition {
      condition     = can(regex("^ocid1\\.compartment\\.oc1\\..+", var.compartment_ocid))
      error_message = "A dedicated compartment OCID is required. Root-compartment deployment is outside this reference."
    }
  }
}

resource "oci_core_vcn" "linerecall" {
  count = local.compute_enabled ? 1 : 0

  compartment_id = var.compartment_ocid
  cidr_blocks    = [var.vcn_cidr]
  display_name   = "linerecall-zero-spend"
  dns_label      = "linerecall"
  freeform_tags  = local.common_tags

  depends_on = [terraform_data.zero_spend_guard]
}

resource "oci_core_internet_gateway" "linerecall" {
  count = local.compute_enabled && var.assign_public_ipv4 ? 1 : 0

  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.linerecall[0].id
  display_name   = "linerecall-egress"
  enabled        = true
  freeform_tags  = local.common_tags
}

resource "oci_core_route_table" "linerecall" {
  count = local.compute_enabled && var.assign_public_ipv4 ? 1 : 0

  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.linerecall[0].id
  display_name   = "linerecall-public-route"
  freeform_tags  = local.common_tags

  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.linerecall[0].id
  }
}

resource "oci_core_security_list" "linerecall" {
  count = local.compute_enabled ? 1 : 0

  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.linerecall[0].id
  display_name   = "linerecall-subnet-default-deny-ingress"
  freeform_tags  = local.common_tags

  egress_security_rules {
    destination = "0.0.0.0/0"
    protocol    = "all"
  }
}

resource "oci_core_subnet" "linerecall" {
  count = local.compute_enabled ? 1 : 0

  compartment_id             = var.compartment_ocid
  vcn_id                     = oci_core_vcn.linerecall[0].id
  cidr_block                 = var.subnet_cidr
  display_name               = "linerecall-compute"
  dns_label                  = "compute"
  prohibit_public_ip_on_vnic = !var.assign_public_ipv4
  security_list_ids          = [oci_core_security_list.linerecall[0].id]
  route_table_id             = var.assign_public_ipv4 ? oci_core_route_table.linerecall[0].id : null
  freeform_tags              = local.common_tags
}

resource "oci_core_network_security_group" "instance" {
  count = local.compute_enabled ? 1 : 0

  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.linerecall[0].id
  display_name   = "linerecall-instance"
  freeform_tags  = local.common_tags
}

resource "oci_core_network_security_group_security_rule" "egress" {
  count = local.compute_enabled ? 1 : 0

  network_security_group_id = oci_core_network_security_group.instance[0].id
  direction                 = "EGRESS"
  protocol                  = "all"
  destination               = "0.0.0.0/0"
  destination_type          = "CIDR_BLOCK"
  description               = "Package updates and reviewed application destinations"
}

resource "oci_core_network_security_group_security_rule" "https" {
  count = local.compute_enabled && var.enable_public_https ? 1 : 0

  network_security_group_id = oci_core_network_security_group.instance[0].id
  direction                 = "INGRESS"
  protocol                  = "6"
  source                    = var.https_source_cidr
  source_type               = "CIDR_BLOCK"
  description               = "Explicit HTTPS ingress"

  tcp_options {
    destination_port_range {
      min = 443
      max = 443
    }
  }

  lifecycle {
    precondition {
      condition     = var.assign_public_ipv4
      error_message = "Public HTTPS ingress requires explicit public IPv4 assignment."
    }
  }
}

resource "oci_core_network_security_group_security_rule" "ssh" {
  for_each = local.compute_enabled ? toset(var.ssh_ingress_cidrs) : toset([])

  network_security_group_id = oci_core_network_security_group.instance[0].id
  direction                 = "INGRESS"
  protocol                  = "6"
  source                    = each.value
  source_type               = "CIDR_BLOCK"
  description               = "Restricted operator SSH ingress"

  tcp_options {
    destination_port_range {
      min = 22
      max = 22
    }
  }

  lifecycle {
    precondition {
      condition     = var.assign_public_ipv4
      error_message = "Direct SSH ingress requires explicit public IPv4 assignment. Prefer OCI Bastion when it is reviewed."
    }
  }
}

resource "oci_core_instance" "linerecall" {
  count = local.compute_enabled ? 1 : 0

  availability_domain = var.availability_domain
  compartment_id      = var.compartment_ocid
  display_name        = "linerecall-a1"
  shape               = "VM.Standard.A1.Flex"
  freeform_tags       = local.common_tags

  shape_config {
    ocpus         = local.a1_ocpus
    memory_in_gbs = local.a1_memory_gb
  }

  create_vnic_details {
    assign_public_ip = var.assign_public_ipv4
    display_name     = "linerecall-primary"
    hostname_label   = "app"
    nsg_ids          = [oci_core_network_security_group.instance[0].id]
    subnet_id        = oci_core_subnet.linerecall[0].id
  }

  source_details {
    source_id               = var.ubuntu_image_ocid
    source_type             = "image"
    boot_volume_size_in_gbs = local.boot_volume_size_gb
    boot_volume_vpus_per_gb = 10
  }

  metadata = {
    ssh_authorized_keys = trimspace(var.ssh_public_key)
  }

  instance_options {
    are_legacy_imds_endpoints_disabled = true
  }

  launch_options {
    boot_volume_type                    = "PARAVIRTUALIZED"
    firmware                            = "UEFI_64"
    is_consistent_volume_naming_enabled = true
    is_pv_encryption_in_transit_enabled = true
    network_type                        = "PARAVIRTUALIZED"
    remote_data_volume_type             = "PARAVIRTUALIZED"
  }

  availability_config {
    recovery_action = "RESTORE_INSTANCE"
  }

  preserve_boot_volume = false

  lifecycle {
    precondition {
      condition     = var.verified_existing_a1_ocpus + local.a1_ocpus <= local.a1_ocpu_limit
      error_message = "This instance would exceed the currently documented 2-OCPU A1 Always Free tenancy total."
    }

    precondition {
      condition     = var.verified_existing_a1_memory_gb + local.a1_memory_gb <= local.a1_memory_limit_gb
      error_message = "This instance would exceed the currently documented 12-GB A1 Always Free tenancy total."
    }

    precondition {
      condition     = var.verified_existing_block_storage_gb + local.boot_volume_size_gb <= local.block_storage_limit_gb
      error_message = "The 50-GB boot volume would exceed the currently documented 200-GB combined boot/block Always Free total."
    }

    precondition {
      condition     = var.availability_domain != ""
      error_message = "Provide an availability domain only after a fresh A1 capacity check. Fault-domain pinning is intentionally unsupported."
    }

    precondition {
      condition     = can(regex("^ocid1\\.image\\.oc1\\..+", var.ubuntu_image_ocid))
      error_message = "Provide the current Ubuntu 24.04 Minimal aarch64 platform-image OCID from us-chicago-1."
    }

    precondition {
      condition     = can(regex("^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp(256|384|521)) ", trimspace(var.ssh_public_key)))
      error_message = "Provide a dedicated OpenSSH public key. Private key material is prohibited."
    }
  }
}

resource "oci_objectstorage_bucket" "evidence" {
  count = local.bucket_enabled ? 1 : 0

  compartment_id = var.compartment_ocid
  namespace      = var.object_storage_namespace
  name           = var.bucket_name
  access_type    = "NoPublicAccess"
  storage_tier   = "Standard"
  versioning     = "Disabled"
  freeform_tags  = local.common_tags

  depends_on = [terraform_data.zero_spend_guard]

  lifecycle {
    precondition {
      condition     = var.object_storage_namespace != ""
      error_message = "The Object Storage namespace is required when the optional private bucket is enabled."
    }

    precondition {
      condition     = var.verified_existing_object_storage_bytes + var.object_storage_reserved_bytes <= local.object_storage_limit_bytes
      error_message = "The declared application budget would exceed the conservative 20,000,000,000-byte Object Storage ceiling."
    }
  }
}
