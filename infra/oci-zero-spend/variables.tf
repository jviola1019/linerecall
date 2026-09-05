variable "deployment_enabled" {
  description = "Master fail-closed switch. False means this configuration declares no managed resources."
  type        = bool
  default     = false
}
variable "enable_compute" {
  description = "Opt in to the single A1 instance and its isolated network after the master switch and guards are satisfied."
  type        = bool
  default     = false
}

variable "enable_object_storage" {
  description = "Opt in to one empty private bucket. This module cannot enforce the byte total of later uploads."
  type        = bool
  default     = false
}

variable "zero_spend_acknowledgement" {
  description = "Exact acknowledgement required before any resource can enter a plan."
  type        = string
  default     = ""
  sensitive   = true

  validation {
    condition = contains([
      "",
      "I_VERIFIED_CURRENT_OCI_USAGE_AND_ALWAYS_FREE_ELIGIBILITY",
    ], var.zero_spend_acknowledgement)
    error_message = "Leave this empty or use the exact reviewed zero-spend acknowledgement."
  }
}

variable "home_region_verified" {
  description = "Set only after the OCI Console confirms that us-chicago-1 is still the tenancy home region."
  type        = bool
  default     = false
}

variable "always_free_account_state_verified" {
  description = "Set only after the Console shows the account and selected resources as Always Free eligible."
  type        = bool
  default     = false
}

variable "chicago_a1_capacity_verified" {
  description = "Set only after a fresh capacity check succeeds. A quota does not prove host capacity."
  type        = bool
  default     = false
}

variable "region" {
  description = "The user's recorded OCI home region. This reference intentionally refuses another region."
  type        = string
  default     = "us-chicago-1"

  validation {
    condition     = var.region == "us-chicago-1"
    error_message = "This zero-spend reference is restricted to the recorded home region us-chicago-1."
  }
}

variable "oci_config_profile" {
  description = "Profile name in the operator-owned OCI config file. No credential material belongs in this repository."
  type        = string
  default     = "DEFAULT"

  validation {
    condition     = can(regex("^[A-Za-z0-9_-]{1,64}$", var.oci_config_profile))
    error_message = "Use a simple OCI config profile name."
  }
}

variable "compartment_ocid" {
  description = "Dedicated LineRecall compartment OCID, supplied only after console access is restored."
  type        = string
  default     = ""
}

variable "availability_domain" {
  description = "An availability-domain name with freshly confirmed A1 capacity. Do not pin a fault domain."
  type        = string
  default     = ""
}

variable "ubuntu_image_ocid" {
  description = "A current Canonical Ubuntu 24.04 Minimal aarch64 platform-image OCID from us-chicago-1."
  type        = string
  default     = ""
}

variable "ssh_public_key" {
  description = "A dedicated OpenSSH public key. Never supply a private key."
  type        = string
  default     = ""
}

variable "verified_existing_a1_ocpus" {
  description = "Current tenancy-wide A1 OCPUs observed in Limits, Quotas and Usage. The fail-closed default assumes all 2 are used."
  type        = number
  default     = 2

  validation {
    condition     = var.verified_existing_a1_ocpus >= 0 && var.verified_existing_a1_ocpus <= 2
    error_message = "The verified existing A1 OCPU total must be between 0 and 2."
  }
}

variable "verified_existing_a1_memory_gb" {
  description = "Current tenancy-wide A1 memory observed in Limits, Quotas and Usage. The fail-closed default assumes all 12 GB are used."
  type        = number
  default     = 12

  validation {
    condition     = var.verified_existing_a1_memory_gb >= 0 && var.verified_existing_a1_memory_gb <= 12
    error_message = "The verified existing A1 memory total must be between 0 and 12 GB."
  }
}

variable "verified_existing_block_storage_gb" {
  description = "Current boot plus block-volume usage. The fail-closed default assumes the full 200 GB allowance is used."
  type        = number
  default     = 200

  validation {
    condition     = var.verified_existing_block_storage_gb >= 0 && var.verified_existing_block_storage_gb <= 200
    error_message = "The verified existing block-storage total must be between 0 and 200 GB."
  }
}

variable "verified_existing_object_storage_bytes" {
  description = "Current combined object/archive usage. The fail-closed default assumes the documented 20 GB allowance is used."
  type        = number
  default     = 20000000000

  validation {
    condition     = var.verified_existing_object_storage_bytes >= 0 && var.verified_existing_object_storage_bytes <= 20000000000
    error_message = "The verified existing object-storage total must be between 0 and 20,000,000,000 bytes."
  }
}

variable "object_storage_reserved_bytes" {
  description = "Operator-enforced application upload budget. Terraform records but cannot enforce this cap on later API writes."
  type        = number
  default     = 0

  validation {
    condition     = var.object_storage_reserved_bytes >= 0 && var.object_storage_reserved_bytes <= 20000000000
    error_message = "The reserved object-storage budget must be between 0 and 20,000,000,000 bytes."
  }
}

variable "assign_public_ipv4" {
  description = "Assign an ephemeral public IPv4 address to the instance. False by default."
  type        = bool
  default     = false
}

variable "enable_public_https" {
  description = "Allow TCP 443 through the network security group. This does not install or configure TLS."
  type        = bool
  default     = false
}

variable "https_source_cidr" {
  description = "IPv4 source permitted to reach TCP 443 when public HTTPS is explicitly enabled."
  type        = string
  default     = "0.0.0.0/0"

  validation {
    condition     = can(cidrnetmask(var.https_source_cidr))
    error_message = "https_source_cidr must be a valid IPv4 CIDR."
  }
}

variable "ssh_ingress_cidrs" {
  description = "Explicit operator IPv4 CIDRs allowed to reach SSH. Empty by default; never use 0.0.0.0/0."
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for cidr in var.ssh_ingress_cidrs :
      can(cidrnetmask(cidr)) && cidr != "0.0.0.0/0"
    ])
    error_message = "Every SSH source must be a valid restricted IPv4 CIDR; 0.0.0.0/0 is prohibited."
  }
}

variable "vcn_cidr" {
  description = "Private IPv4 range for the dedicated VCN."
  type        = string
  default     = "10.41.0.0/16"

  validation {
    condition     = can(cidrnetmask(var.vcn_cidr))
    error_message = "vcn_cidr must be a valid IPv4 CIDR."
  }
}

variable "subnet_cidr" {
  description = "IPv4 range for the single compute subnet."
  type        = string
  default     = "10.41.10.0/24"

  validation {
    condition     = can(cidrnetmask(var.subnet_cidr))
    error_message = "subnet_cidr must be a valid IPv4 CIDR."
  }
}

variable "object_storage_namespace" {
  description = "Tenancy Object Storage namespace. Required only when the optional empty bucket is enabled."
  type        = string
  default     = ""
}

variable "bucket_name" {
  description = "Private bucket name used only when object storage is explicitly enabled."
  type        = string
  default     = "linerecall-evidence"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{2,62}$", var.bucket_name))
    error_message = "Use a lowercase, hyphenated bucket name between 3 and 63 characters."
  }
}
