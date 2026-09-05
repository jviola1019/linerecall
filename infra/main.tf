locals {
  prefix = "${var.name}-${var.environment}"
  tags = {
    Application      = var.name
    Environment      = var.environment
    ManagedBy        = "OpenTofu"
    DataClass        = "private"
  }
  secret_names = [
    "DATABASE_URL", "AUTH_DATABASE_URL", "BETTER_AUTH_SECRET", "REDIS_URL", "DATABASE_SSL_CA_PEM"
  ]
}

data "aws_caller_identity" "current" {}

resource "aws_kms_key" "application" {
  description             = "${local.prefix} application and object encryption"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy = jsonencode({ Version="2012-10-17", Statement=[
    { Sid="EnableAccountAdministration", Effect="Allow", Principal={AWS="arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"}, Action="kms:*", Resource="*" },
    { Sid="AllowCloudWatchLogs", Effect="Allow", Principal={Service="logs.${var.aws_region}.amazonaws.com"}, Action=["kms:Encrypt*","kms:Decrypt*","kms:ReEncrypt*","kms:GenerateDataKey*","kms:Describe*"], Resource="*", Condition={ArnLike={"kms:EncryptionContext:aws:logs:arn"="arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/ecs/${local.prefix}/*"}} }
  ] })
}
resource "aws_kms_alias" "application" { name = "alias/${local.prefix}-application"
target_key_id = aws_kms_key.application.key_id }

resource "aws_s3_bucket" "private" {
  bucket = "${local.prefix}-private-${data.aws_caller_identity.current.account_id}"
}
resource "aws_s3_bucket_public_access_block" "private" {
  bucket = aws_s3_bucket.private.id
  block_public_acls = true
block_public_policy = true
ignore_public_acls = true
restrict_public_buckets = true
}
resource "aws_s3_bucket_versioning" "private" { bucket = aws_s3_bucket.private.id
versioning_configuration { status = "Enabled" } }
resource "aws_s3_bucket_server_side_encryption_configuration" "private" {
  bucket = aws_s3_bucket.private.id
  rule { bucket_key_enabled = true
apply_server_side_encryption_by_default { kms_master_key_id = aws_kms_key.application.arn
sse_algorithm = "aws:kms" } }
}
resource "aws_s3_bucket_lifecycle_configuration" "private" {
  depends_on = [aws_s3_bucket_versioning.private]
  bucket = aws_s3_bucket.private.id
  rule {
    id = "expire-private-imports"
status = "Enabled"
filter { prefix = "private/imports/" }
    expiration { days = 7 }
noncurrent_version_expiration { noncurrent_days = 7 }
  }
}

resource "aws_s3_bucket" "catalog" {
  bucket              = "${local.prefix}-catalog-${data.aws_caller_identity.current.account_id}"
  object_lock_enabled = true
}
resource "aws_s3_bucket_public_access_block" "catalog" {
  bucket                  = aws_s3_bucket.catalog.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_versioning" "catalog" {
  bucket = aws_s3_bucket.catalog.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "catalog" {
  bucket = aws_s3_bucket.catalog.id
  rule {
    bucket_key_enabled = true
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.application.arn
      sse_algorithm     = "aws:kms"
    }
  }
}
resource "aws_s3_bucket_object_lock_configuration" "catalog" {
  bucket = aws_s3_bucket.catalog.id
  rule { default_retention {
    mode = "GOVERNANCE"
    days = 35
  } }
}

resource "aws_security_group" "database" { name = "${local.prefix}-database"
vpc_id = var.vpc_id
egress { from_port = 0
to_port = 0
protocol = "-1"
cidr_blocks = ["0.0.0.0/0"] } }
resource "aws_security_group" "api" { name = "${local.prefix}-api"
vpc_id = var.vpc_id
egress { from_port = 0
to_port = 0
protocol = "-1"
cidr_blocks = ["0.0.0.0/0"] } }
resource "aws_vpc_security_group_ingress_rule" "api" { security_group_id = aws_security_group.api.id
referenced_security_group_id = var.api_security_group_ingress_id
from_port = 4100
to_port = 4100
ip_protocol = "tcp" }
resource "aws_vpc_security_group_ingress_rule" "postgres" { security_group_id = aws_security_group.database.id
referenced_security_group_id = aws_security_group.api.id
from_port = 5432
to_port = 5432
ip_protocol = "tcp" }
resource "aws_vpc_security_group_ingress_rule" "redis" { security_group_id = aws_security_group.database.id
referenced_security_group_id = aws_security_group.api.id
from_port = 6379
to_port = 6379
ip_protocol = "tcp" }

resource "aws_db_subnet_group" "main" { name = local.prefix
subnet_ids = var.private_subnet_ids }
resource "aws_db_instance" "postgres" {
  identifier = local.prefix
engine = "postgres"
engine_version = "18"
instance_class = var.environment == "production" ? "db.r7g.large" : "db.t4g.medium"
  allocated_storage = 100
max_allocated_storage = 1000
storage_type = "gp3"
storage_encrypted = true
kms_key_id = aws_kms_key.application.arn
  db_name = var.database_name
username = var.database_username
password = var.database_password # secret-scan: allow - runtime sensitive variable reference, not a credential value
port = 5432
  multi_az = true
publicly_accessible = false
db_subnet_group_name = aws_db_subnet_group.main.name
vpc_security_group_ids = [aws_security_group.database.id]
  backup_retention_period = 35
backup_window = "05:00-06:00"
maintenance_window = "sun:06:00-sun:07:00"
  deletion_protection = true
skip_final_snapshot = false
final_snapshot_identifier = "${local.prefix}-final"
copy_tags_to_snapshot = true
  auto_minor_version_upgrade = true
performance_insights_enabled = true
performance_insights_kms_key_id = aws_kms_key.application.arn
}

resource "aws_elasticache_subnet_group" "main" { name = local.prefix
subnet_ids = var.private_subnet_ids }
resource "aws_elasticache_replication_group" "redis" {
  replication_group_id = local.prefix
description = "LineRecall disposable coordination and rate limits"
engine = "redis"
engine_version = "8.0"
  node_type = var.environment == "production" ? "cache.r7g.large" : "cache.t4g.small"
num_cache_clusters = 2
automatic_failover_enabled = true
multi_az_enabled = true
  subnet_group_name = aws_elasticache_subnet_group.main.name
security_group_ids = [aws_security_group.database.id]
  at_rest_encryption_enabled = true
transit_encryption_enabled = true
auth_token = var.redis_auth_token
kms_key_id = aws_kms_key.application.arn
  snapshot_retention_limit = 0
apply_immediately = false
}

resource "aws_cloudwatch_log_group" "api" { name = "/ecs/${local.prefix}/api"
retention_in_days = 30
kms_key_id = aws_kms_key.application.arn }
resource "aws_cloudwatch_log_group" "dispatcher" { name = "/ecs/${local.prefix}/dispatcher"
retention_in_days = 30
kms_key_id = aws_kms_key.application.arn }
resource "aws_ecs_cluster" "main" { name = local.prefix
setting { name = "containerInsights"
value = "enabled" } }

resource "aws_iam_role" "ecs_execution" { name = "${local.prefix}-ecs-execution"
assume_role_policy = jsonencode({ Version="2012-10-17", Statement=[{ Effect="Allow", Principal={Service="ecs-tasks.amazonaws.com"}, Action="sts:AssumeRole" }] }) }
resource "aws_iam_role_policy_attachment" "ecs_execution" { role = aws_iam_role.ecs_execution.name
policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy" }
resource "aws_iam_role_policy" "ecs_secrets" {
  role = aws_iam_role.ecs_execution.id
  policy = jsonencode({ Version="2012-10-17", Statement=[
    { Effect="Allow", Action=["secretsmanager:GetSecretValue"], Resource=[var.api_secrets_arn] },
    { Effect="Allow", Action=["kms:Decrypt"], Resource=[aws_kms_key.application.arn] }
  ] })
}
resource "aws_iam_role" "api" { name = "${local.prefix}-api"
assume_role_policy = jsonencode({ Version="2012-10-17", Statement=[{ Effect="Allow", Principal={Service="ecs-tasks.amazonaws.com"}, Action="sts:AssumeRole" }] }) }
resource "aws_iam_role_policy" "api" {
  role = aws_iam_role.api.id
  policy = jsonencode({ Version="2012-10-17", Statement=[
    {
      Sid="PrivateImportWrites",
      Effect="Allow",
      Action=["s3:PutObject","s3:DeleteObject","s3:DeleteObjectVersion"],
      Resource="${aws_s3_bucket.private.arn}/private/imports/*"
    },
    {
      Sid="PrivateImportVersionListing",
      Effect="Allow",
      Action=["s3:ListBucketVersions"],
      Resource=aws_s3_bucket.private.arn,
      Condition={StringLike={"s3:prefix"="private/imports/*"}}
    },
    {
      Sid="ApprovedCatalogReads",
      Effect="Allow",
      Action=["s3:GetObject","s3:GetObjectVersion"],
      Resource="${aws_s3_bucket.catalog.arn}/public/*"
    },
    {
      Sid="ProviderTokenEnvelopeEncryption",
      Effect="Allow",
      Action=["kms:Encrypt","kms:Decrypt"],
      Resource=aws_kms_key.application.arn,
      Condition={StringEquals={"kms:EncryptionContext:purpose"="linerecall-provider-token-v1"}}
    },
    {
      Sid="ObjectStoreEnvelopeEncryption",
      Effect="Allow",
      Action=["kms:Encrypt","kms:Decrypt","kms:GenerateDataKey"],
      Resource=aws_kms_key.application.arn,
      Condition={
        StringEquals={"kms:ViaService"="s3.${var.aws_region}.amazonaws.com"},
        StringLike={"kms:EncryptionContext:aws:s3:arn"=[
          "${aws_s3_bucket.private.arn}/private/imports/*",
          "${aws_s3_bucket.catalog.arn}/public/*"
        ]}
      }
    },
    {
      Sid="MagicLinkEmailOnly",
      Effect="Allow",
      Action=["ses:SendEmail"],
      Resource=var.magic_link_identity_arn,
      Condition={StringEquals={"ses:FromAddress"=var.magic_link_from}}
    },
  ] })
}

# The public API can only commit pg-boss jobs in PostgreSQL. A separate,
# non-addressable dispatcher is the sole service allowed to submit Batch work.
resource "aws_iam_role" "dispatcher" {
  name = "${local.prefix}-dispatcher"
  assume_role_policy = jsonencode({ Version="2012-10-17", Statement=[{ Effect="Allow", Principal={Service="ecs-tasks.amazonaws.com"}, Action="sts:AssumeRole" }] })
}
resource "aws_iam_role_policy" "dispatcher" {
  role = aws_iam_role.dispatcher.id
  policy = jsonencode({ Version="2012-10-17", Statement=[{
    Sid="SubmitReviewedWorkerDefinitions",
    Effect="Allow",
    Action=["batch:SubmitJob"],
    Resource=concat(
      [aws_batch_job_queue.workers.arn],
      [for definition in aws_batch_job_definition.worker : definition.arn]
    )
  }] })
}

# Workers deliberately use workload-specific task roles. In particular, no
# worker can send email or recursively submit another Batch job.
resource "aws_iam_role" "worker" {
  for_each = toset(["pgn-import","stockfish","scid","data-refresh"])
  name = "${local.prefix}-worker-${each.key}"
  assume_role_policy = jsonencode({ Version="2012-10-17", Statement=[{ Effect="Allow", Principal={Service="ecs-tasks.amazonaws.com"}, Action="sts:AssumeRole" }] })
}

resource "aws_iam_role_policy" "worker_import" {
  role = aws_iam_role.worker["pgn-import"].id
  policy = jsonencode({ Version="2012-10-17", Statement=[
    {
      Sid="ReadAndDisposeSubmittedImport",
      Effect="Allow",
      Action=["s3:GetObject","s3:GetObjectVersion","s3:DeleteObject"],
      Resource="${aws_s3_bucket.private.arn}/private/imports/*"
    },
    {
      Sid="DecryptSubmittedImport",
      Effect="Allow",
      Action=["kms:Decrypt"],
      Resource=aws_kms_key.application.arn,
      Condition={
        StringEquals={"kms:ViaService"="s3.${var.aws_region}.amazonaws.com"},
        StringLike={"kms:EncryptionContext:aws:s3:arn"="${aws_s3_bucket.private.arn}/private/imports/*"}
      }
    }
  ] })
}

resource "aws_iam_role_policy" "worker_audit" {
  for_each = toset(["stockfish","scid","data-refresh"])
  role = aws_iam_role.worker[each.key].id
  policy = jsonencode({ Version="2012-10-17", Statement=[
    {
      Sid="ReadApprovedAndCandidateEvidence",
      Effect="Allow",
      Action=["s3:GetObject","s3:GetObjectVersion"],
      Resource=[
        "${aws_s3_bucket.catalog.arn}/public/*",
        "${aws_s3_bucket.catalog.arn}/staging/*"
      ]
    },
    {
      Sid="WriteCandidateEvidenceOnly",
      Effect="Allow",
      Action=["s3:PutObject"],
      Resource="${aws_s3_bucket.catalog.arn}/staging/*"
    },
    {
      Sid="CatalogEnvelopeEncryption",
      Effect="Allow",
      Action=["kms:Encrypt","kms:Decrypt","kms:GenerateDataKey"],
      Resource=aws_kms_key.application.arn,
      Condition={
        StringEquals={"kms:ViaService"="s3.${var.aws_region}.amazonaws.com"},
        StringLike={"kms:EncryptionContext:aws:s3:arn"=[
          "${aws_s3_bucket.catalog.arn}/public/*",
          "${aws_s3_bucket.catalog.arn}/staging/*"
        ]}
      }
    }
  ] })
}

resource "aws_ecs_task_definition" "api" {
  family = "${local.prefix}-api"
requires_compatibilities = ["FARGATE"]
network_mode = "awsvpc"
cpu = 1024
memory = 2048
  execution_role_arn = aws_iam_role.ecs_execution.arn
task_role_arn = aws_iam_role.api.arn
  runtime_platform { operating_system_family = "LINUX"
cpu_architecture = "ARM64" }
  container_definitions = jsonencode([{
    name="api", image=var.api_image, essential=true, readonlyRootFilesystem=true, user="10001", portMappings=[{containerPort=4100,protocol="tcp"}],
    environment=[
      {name="NODE_ENV",value="production"},{name="HOST",value="0.0.0.0"},{name="PORT",value="4100"},{name="PUBLIC_ORIGIN",value=var.public_origin},
      {name="SERVICE_ORIGIN",value=var.service_origin},{name="AUTH_MODE",value="better-auth"},{name="TRUST_PROXY",value="true"},{name="AWS_REGION",value=var.aws_region},
      {name="PASSKEY_RP_ID",value=var.passkey_rp_id},{name="PASSKEY_RP_NAME",value="LineRecall"},{name="MAGIC_LINK_FROM",value=var.magic_link_from},
      {name="PRIVATE_OBJECT_BUCKET",value=aws_s3_bucket.private.id},{name="PRIVATE_BUCKET_KMS_KEY_ID",value=aws_kms_key.application.arn},
      {name="PUBLIC_DATA_BUCKET",value=aws_s3_bucket.catalog.id},{name="CATALOG_MANIFEST_KEY",value="public/manifests/current.json"},{name="CATALOG_SIGNING_PUBLIC_KEY_PEM",value=var.catalog_signing_public_key_pem},
      {name="TOKEN_KMS_KEY_ID",value=aws_kms_key.application.arn},{name="LICHESS_CLIENT_ID",value=var.lichess_client_id},{name="EXTERNAL_USER_AGENT",value=var.external_user_agent},
      {name="BATCH_JOB_QUEUE",value=aws_batch_job_queue.workers.arn},{name="BATCH_IMPORT_JOB_DEFINITION",value=aws_batch_job_definition.worker["pgn-import"].arn},
      {name="BATCH_STOCKFISH_JOB_DEFINITION",value=aws_batch_job_definition.worker["stockfish"].arn},{name="BATCH_SCID_JOB_DEFINITION",value=aws_batch_job_definition.worker["scid"].arn},
      {name="BATCH_REFRESH_JOB_DEFINITION",value=aws_batch_job_definition.worker["data-refresh"].arn}
    ],
    secrets=[for name in local.secret_names : {name=name,valueFrom="${var.api_secrets_arn}:${name}::"}],
    healthCheck={command=["CMD-SHELL","node -e \"fetch('http://127.0.0.1:4100/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""],interval=30,timeout=5,retries=3,startPeriod=20},
    logConfiguration={logDriver="awslogs",options={"awslogs-group"=aws_cloudwatch_log_group.api.name,"awslogs-region"=var.aws_region,"awslogs-stream-prefix"="api"}}
  }])
}
resource "aws_ecs_service" "api" {
  name="api"
cluster=aws_ecs_cluster.main.id
task_definition=aws_ecs_task_definition.api.arn
desired_count=2
launch_type="FARGATE"
platform_version="LATEST"
  deployment_minimum_healthy_percent=100
deployment_maximum_percent=200
health_check_grace_period_seconds=30
enable_execute_command=false
  network_configuration { subnets=var.private_subnet_ids
security_groups=[aws_security_group.api.id]
assign_public_ip=false }
  load_balancer { target_group_arn=var.alb_target_group_arn
container_name="api"
container_port=4100 }
  deployment_circuit_breaker { enable=true
rollback=true }
}

resource "aws_ecs_task_definition" "dispatcher" {
  family = "${local.prefix}-dispatcher"
  requires_compatibilities = ["FARGATE"]
  network_mode = "awsvpc"
  cpu = 512
  memory = 1024
  execution_role_arn = aws_iam_role.ecs_execution.arn
  task_role_arn = aws_iam_role.dispatcher.arn
  runtime_platform { operating_system_family = "LINUX"
  cpu_architecture = "ARM64" }
  container_definitions = jsonencode([{
    name="dispatcher", image=var.api_image, essential=true, readonlyRootFilesystem=true, user="10001",
    command=["node","dist/jobs/dispatcher.js"],
    environment=[
      {name="AWS_REGION",value=var.aws_region},
      {name="BATCH_JOB_QUEUE",value=aws_batch_job_queue.workers.arn},
      {name="BATCH_IMPORT_JOB_DEFINITION",value=aws_batch_job_definition.worker["pgn-import"].arn},
      {name="BATCH_STOCKFISH_JOB_DEFINITION",value=aws_batch_job_definition.worker["stockfish"].arn},
      {name="BATCH_SCID_JOB_DEFINITION",value=aws_batch_job_definition.worker["scid"].arn},
      {name="BATCH_REFRESH_JOB_DEFINITION",value=aws_batch_job_definition.worker["data-refresh"].arn}
    ],
    secrets=[
      {name="DATABASE_URL",valueFrom="${var.api_secrets_arn}:DATABASE_URL::"},
      {name="DATABASE_SSL_CA_PEM",valueFrom="${var.api_secrets_arn}:DATABASE_SSL_CA_PEM::"}
    ],
    logConfiguration={logDriver="awslogs",options={"awslogs-group"=aws_cloudwatch_log_group.dispatcher.name,"awslogs-region"=var.aws_region,"awslogs-stream-prefix"="dispatcher"}
  }])
}
resource "aws_ecs_service" "dispatcher" {
  name="dispatcher"
  cluster=aws_ecs_cluster.main.id
  task_definition=aws_ecs_task_definition.dispatcher.arn
  desired_count=2
  launch_type="FARGATE"
  platform_version="LATEST"
  deployment_minimum_healthy_percent=100
  deployment_maximum_percent=200
  enable_execute_command=false
  network_configuration { subnets=var.private_subnet_ids
  security_groups=[aws_security_group.api.id]
  assign_public_ip=false }
  deployment_circuit_breaker { enable=true
  rollback=true }
}

resource "aws_batch_compute_environment" "workers" {
  compute_environment_name = "${local.prefix}-workers"
type = "MANAGED"
  compute_resources { type="FARGATE"
max_vcpus=256
subnets=var.private_subnet_ids
security_group_ids=[aws_security_group.api.id] }
}
resource "aws_batch_job_queue" "workers" { name="${local.prefix}-workers"
state="ENABLED"
priority=10
compute_environment_order { order=1
compute_environment=aws_batch_compute_environment.workers.arn } }
resource "aws_batch_job_definition" "worker" {
  for_each = toset(["pgn-import","stockfish","scid","data-refresh"])
  name="${local.prefix}-${each.key}"
type="container"
platform_capabilities=["FARGATE"]
timeout { attempt_duration_seconds=3600 }
retry_strategy { attempts=3 }
  container_properties=jsonencode({image=var.worker_image,command=["worker",each.key,"Ref::jobId","Ref::objectKey"],resourceRequirements=[{type="VCPU",value="2"},{type="MEMORY",value="4096"}],networkConfiguration={assignPublicIp="DISABLED"},fargatePlatformConfiguration={platformVersion="LATEST"},executionRoleArn=aws_iam_role.ecs_execution.arn,jobRoleArn=aws_iam_role.worker[each.key].arn,readonlyRootFilesystem=true})
}

resource "aws_cloudwatch_metric_alarm" "api_tasks" {
  alarm_name="${local.prefix}-api-task-count"
comparison_operator="LessThanThreshold"
evaluation_periods=2
metric_name="RunningTaskCount"
namespace="ECS/ContainerInsights"
period=60
statistic="Minimum"
threshold=2
treat_missing_data="breaching"
  dimensions={ClusterName=aws_ecs_cluster.main.name,ServiceName=aws_ecs_service.api.name}
alarm_actions=[var.alert_topic_arn]
}
