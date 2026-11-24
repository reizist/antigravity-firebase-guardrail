output "project_id" {
  description = "共有 GCP プロジェクト ID"
  value       = local.effective_project_id
}

output "terraform_sa_email" {
  description = "Terraform 用サービスアカウント"
  value       = google_service_account.terraform_sa.email
}

output "tfstate_bucket_name" {
  description = "tfstate バケット"
  value       = google_storage_bucket.tfstate.name
}

output "github_wif_pool_name" {
  description = "Workload Identity Pool のリソース名（deployer.tf の借用設定で使う）"
  value       = google_iam_workload_identity_pool.github.name
}

output "github_wif_provider" {
  description = "GitHub Actions の google-github-actions/auth に渡す workload_identity_provider"
  value       = google_iam_workload_identity_pool_provider.github.name
}
