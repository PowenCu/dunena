output "service_url" {
  description = "Cloud Run service URL"
  value       = google_cloud_run_v2_service.dunena.uri
}

output "service_name" {
  description = "Cloud Run service name"
  value       = google_cloud_run_v2_service.dunena.name
}

output "bucket_name" {
  description = "GCS bucket name for data persistence"
  value       = google_storage_bucket.dunena_data.name
}

output "bucket_url" {
  description = "GCS bucket URL"
  value       = google_storage_bucket.dunena_data.url
}
