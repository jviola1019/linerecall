variable "name" { type = string
default = "linerecall" }
variable "environment" { type = string
validation { condition = contains(["staging", "production"], var.environment)
error_message = "Use staging or production." } }
variable "aws_region" { type = string
default = "us-east-1" }
variable "vpc_id" { type = string }
variable "private_subnet_ids" { type = list(string)
validation { condition = length(var.private_subnet_ids) >= 2
error_message = "At least two private subnets are required." } }
variable "api_security_group_ingress_id" { type = string
description = "Security group allowed to reach the API (normally the ALB SG)." }
variable "alb_target_group_arn" { type = string }
variable "api_image" { type = string
description = "Immutable API image reference pinned by sha256 digest."
validation { condition = strcontains(var.api_image, "@sha256:")
error_message = "api_image must be digest-pinned." } }
variable "worker_image" { type = string
description = "Immutable worker image reference pinned by sha256 digest."
validation { condition = strcontains(var.worker_image, "@sha256:")
error_message = "worker_image must be digest-pinned." } }
variable "api_secrets_arn" { type = string
description = "Secrets Manager JSON containing DATABASE_URL, AUTH_DATABASE_URL, BETTER_AUTH_SECRET and Redis auth material." }
variable "public_origin" { type = string }
variable "service_origin" { type = string }
variable "passkey_rp_id" { type = string }
variable "magic_link_from" { type = string }
variable "magic_link_identity_arn" {
  type = string
  description = "Verified SES identity ARN authorized to send LineRecall magic links."
  validation {
    condition = can(regex("^arn:aws:ses:[a-z0-9-]+:[0-9]{12}:identity/", var.magic_link_identity_arn))
    error_message = "magic_link_identity_arn must identify one verified SES identity."
  }
}
variable "lichess_client_id" { type = string
sensitive = true }
variable "external_user_agent" { type = string }
variable "catalog_signing_public_key_pem" { type = string }
variable "database_name" { type = string
default = "linerecall" }
variable "database_username" { type = string
default = "linerecall_admin" }
variable "database_password" { type = string
sensitive = true }
variable "redis_auth_token" { type = string
sensitive = true }
variable "alert_topic_arn" { type = string }
