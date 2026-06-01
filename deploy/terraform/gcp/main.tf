# ── Dunena Terraform Module: Google Cloud Run ────────────────
# Deploys Dunena on Cloud Run with Persistent Disk for SQLite.

terraform {
  required_version = ">= 1.5"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# ── Artifact Registry ───────────────────────────────────────
# Optional: create a registry if pushing custom images.

resource "google_artifact_registry_repository" "dunena" {
  count         = var.create_registry ? 1 : 0
  location      = var.region
  repository_id = "${var.name}-repo"
  format        = "DOCKER"
  description   = "Dunena container images"
}

# ── Cloud Run Service ───────────────────────────────────────

resource "google_cloud_run_v2_service" "dunena" {
  name     = var.name
  location = var.region

  template {
    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    containers {
      image = var.image

      ports {
        container_port = 3000
      }

      resources {
        limits = {
          cpu    = var.cpu
          memory = var.memory
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      env {
        name  = "DUNENA_PORT"
        value = "3000"
      }
      env {
        name  = "DUNENA_HOST"
        value = "0.0.0.0"
      }
      env {
        name  = "DUNENA_MAX_ENTRIES"
        value = tostring(var.max_entries)
      }
      env {
        name  = "DUNENA_DB"
        value = "true"
      }
      env {
        name  = "DUNENA_DB_PATH"
        value = "/var/lib/dunena/dunena.db"
      }
      env {
        name  = "DUNENA_PERSIST"
        value = "true"
      }
      env {
        name  = "DUNENA_PERSIST_PATH"
        value = "/var/lib/dunena/dunena-snapshot.json"
      }

      # Auth token from Secret Manager (optional)
      dynamic "env" {
        for_each = var.auth_token_secret != "" ? [1] : []
        content {
          name = "DUNENA_AUTH_TOKEN"
          value_source {
            secret_key_ref {
              secret  = var.auth_token_secret
              version = "latest"
            }
          }
        }
      }

      volume_mounts {
        name       = "dunena-data"
        mount_path = "/var/lib/dunena"
      }

      startup_probe {
        http_get {
          path = "/health/live"
          port = 3000
        }
        initial_delay_seconds = 5
        period_seconds        = 5
        timeout_seconds       = 3
        failure_threshold     = 10
      }

      liveness_probe {
        http_get {
          path = "/health/live"
          port = 3000
        }
        period_seconds    = 15
        timeout_seconds   = 5
        failure_threshold = 3
      }
    }

    volumes {
      name = "dunena-data"
      gcs {
        bucket    = google_storage_bucket.dunena_data.name
        read_only = false
      }
    }

    max_instance_request_concurrency = var.max_concurrency
    timeout                          = "300s"
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }
}

# ── GCS Bucket for Data Persistence ─────────────────────────

resource "google_storage_bucket" "dunena_data" {
  name          = "${var.project_id}-${var.name}-data"
  location      = var.region
  force_destroy = false

  uniform_bucket_level_access = true

  versioning {
    enabled = true
  }

  lifecycle_rule {
    condition {
      num_newer_versions = 5
    }
    action {
      type = "Delete"
    }
  }
}

# ── IAM: Allow Unauthenticated Access (optional) ───────────

resource "google_cloud_run_v2_service_iam_member" "public" {
  count    = var.allow_unauthenticated ? 1 : 0
  location = google_cloud_run_v2_service.dunena.location
  name     = google_cloud_run_v2_service.dunena.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
