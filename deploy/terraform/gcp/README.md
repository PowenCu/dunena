# Dunena — Google Cloud Run Deployment

Terraform module for deploying Dunena on Google Cloud Run with GCS-backed persistence.

## Architecture

- **Cloud Run**: Serverless container execution with auto-scaling
- **GCS Bucket**: Persistent storage for SQLite database and snapshots (mounted via GCS FUSE)
- **Secret Manager** (optional): Secure auth token storage
- **Health Probes**: Liveness (`/health/live`) and startup probes

## Prerequisites

1. [Terraform](https://www.terraform.io/downloads) >= 1.5
2. [Google Cloud CLI](https://cloud.google.com/sdk/docs/install) with authentication
3. A GCP project with billing enabled
4. APIs enabled: Cloud Run, Artifact Registry, Secret Manager

```bash
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  storage.googleapis.com
```

## Quick Start

```bash
cd deploy/terraform/gcp

# Initialize Terraform
terraform init

# Plan the deployment
terraform plan -var="project_id=my-gcp-project"

# Apply
terraform apply -var="project_id=my-gcp-project"
```

## Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `project_id` | (required) | GCP project ID |
| `name` | `dunena` | Resource name prefix |
| `region` | `us-central1` | GCP region |
| `image` | `ghcr.io/powencu/dunena:latest` | Docker image |
| `cpu` | `1` | CPU allocation |
| `memory` | `1Gi` | Memory allocation |
| `max_entries` | `100000` | Maximum cache entries |
| `min_instances` | `0` | Minimum instances |
| `max_instances` | `1` | Maximum instances (keep at 1 for SQLite) |
| `max_concurrency` | `80` | Max concurrent requests per instance |
| `allow_unauthenticated` | `false` | Allow public access |
| `create_registry` | `false` | Create Artifact Registry |
| `auth_token_secret` | `""` | Secret Manager secret name for auth |

## Using with a Custom Image

```bash
# Build and push to Artifact Registry
docker build -f apps/server/Dockerfile -t us-central1-docker.pkg.dev/PROJECT/dunena-repo/dunena:latest .
docker push us-central1-docker.pkg.dev/PROJECT/dunena-repo/dunena:latest

# Deploy with custom image
terraform apply \
  -var="project_id=PROJECT" \
  -var="image=us-central1-docker.pkg.dev/PROJECT/dunena-repo/dunena:latest" \
  -var="create_registry=true"
```

## Auth Token via Secret Manager

```bash
# Create a secret
echo -n "my-secret-token" | gcloud secrets create dunena-auth-token --data-file=-

# Deploy with auth
terraform apply \
  -var="project_id=PROJECT" \
  -var="auth_token_secret=dunena-auth-token"
```

## Outputs

| Output | Description |
|--------|-------------|
| `service_url` | Cloud Run service URL |
| `service_name` | Cloud Run service name |
| `bucket_name` | GCS bucket for data |
| `bucket_url` | GCS bucket URL |

## Important Notes

- **Single instance**: SQLite requires single-writer, so `max_instances` should be `1`. For horizontal scaling, enable the clustering feature (P3).
- **Cold starts**: Cloud Run may have cold starts if `min_instances=0`. Set to `1` for always-on.
- **GCS FUSE**: The data volume is mounted via GCS FUSE, which may have higher latency than local disk. For latency-sensitive workloads, consider using Cloud Run with Persistent Disks (in preview).
