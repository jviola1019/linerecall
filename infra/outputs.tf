output "private_bucket" { value = aws_s3_bucket.private.id }
output "catalog_bucket" { value = aws_s3_bucket.catalog.id }
output "application_kms_key_arn" { value = aws_kms_key.application.arn }
output "database_endpoint" { value = aws_db_instance.postgres.address
sensitive = true }
output "redis_endpoint" { value = aws_elasticache_replication_group.redis.primary_endpoint_address
sensitive = true }
output "api_security_group_id" { value = aws_security_group.api.id }
output "api_task_role_arn" { value = aws_iam_role.api.arn }
output "worker_task_role_arns" { value = { for name, role in aws_iam_role.worker : name => role.arn } }
output "ecs_cluster_arn" { value = aws_ecs_cluster.main.arn }
output "batch_queue_arn" { value = aws_batch_job_queue.workers.arn }
output "batch_job_definition_arns" { value = { for name, definition in aws_batch_job_definition.worker : name => definition.arn } }
