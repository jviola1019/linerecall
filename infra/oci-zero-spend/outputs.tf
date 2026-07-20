output "resource_creation_enabled" {
  description = "True only when the master switch and at least one explicit service switch are enabled."
  value       = var.deployment_enabled && (var.enable_compute || var.enable_object_storage)
}
output "always_free_assumptions" {
  description = "Static ceilings used by this reference. Console usage and current Oracle terms remain authoritative."
  value = {
    region                       = var.region
    shape                        = "VM.Standard.A1.Flex"
    instance_ocpus               = local.a1_ocpus
    instance_memory_gb           = local.a1_memory_gb
    boot_volume_gb               = local.boot_volume_size_gb
    tenancy_a1_ocpu_ceiling      = local.a1_ocpu_limit
    tenancy_a1_memory_gb_ceiling = local.a1_memory_limit_gb
    block_storage_gb_ceiling     = local.block_storage_limit_gb
    object_storage_byte_ceiling  = local.object_storage_limit_bytes
  }
}

output "instance_id" {
  description = "Created instance OCID, or null while the reference is disabled."
  value       = try(oci_core_instance.linerecall[0].id, null)
}

output "instance_public_ip" {
  description = "Ephemeral public address, or null when public IPv4 is disabled."
  value       = try(oci_core_instance.linerecall[0].public_ip, null)
}

output "private_bucket_name" {
  description = "Created private bucket name, or null while object storage is disabled."
  value       = try(oci_objectstorage_bucket.evidence[0].name, null)
}

output "object_storage_enforcement_warning" {
  description = "A permanent reminder that infrastructure cannot cap bytes written later by an application."
  value       = var.enable_object_storage ? "The reserved byte budget is declarative; enforce and monitor actual application writes separately." : null
}
