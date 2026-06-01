variable "project_id" {
  description = "Google Cloud project ID"
  type        = string
}

variable "name" {
  description = "Name prefix for all resources"
  type        = string
  default     = "dunena"
}

variable "region" {
  description = "GCP region"
  type        = string
  default     = "us-central1"
}

variable "image" {
  description = "Docker image for Dunena"
  type        = string
  default     = "ghcr.io/powencu/dunena:latest"
}

variable "cpu" {
  description = "Cloud Run CPU allocation"
  type        = string
  default     = "1"
}

variable "memory" {
  description = "Cloud Run memory allocation"
  type        = string
  default     = "1Gi"
}

variable "max_entries" {
  description = "Maximum cache entries"
  type        = number
  default     = 100000
}

variable "min_instances" {
  description = "Minimum number of instances"
  type        = number
  default     = 0
}

variable "max_instances" {
  description = "Maximum number of instances (keep at 1 for SQLite)"
  type        = number
  default     = 1
}

variable "max_concurrency" {
  description = "Maximum concurrent requests per instance"
  type        = number
  default     = 80
}

variable "allow_unauthenticated" {
  description = "Allow unauthenticated access to the service"
  type        = bool
  default     = false
}

variable "create_registry" {
  description = "Create an Artifact Registry for Docker images"
  type        = bool
  default     = false
}

variable "auth_token_secret" {
  description = "Secret Manager secret name for auth token (leave empty to disable)"
  type        = string
  default     = ""
}
