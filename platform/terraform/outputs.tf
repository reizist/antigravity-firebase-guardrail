# Copyright 2026 Google LLC
# SPDX-License-Identifier: Apache-2.0
output "project_id" {
  description = "共有 GCP プロジェクト ID"
  value       = local.project_id
}

output "deployer_service_account" {
  description = "アプリのデプロイ SA（GitHub Actions のアプリ用ワークフローが借用する）"
  value       = google_service_account.deployer.email
}

output "npm_registry_url" {
  description = ".npmrc の registry に指定する URL"
  value       = "https://${local.region}-npm.pkg.dev/${local.project_id}/${google_artifact_registry_repository.npm_remote.repository_id}/"
}

output "authorized_domains" {
  description = "Firebase Auth の許可ドメイン"
  value       = google_identity_platform_config.this.authorized_domains
}

output "google_sign_in_configured" {
  description = "Google ログインを Terraform で設定したか（false ならコンソールで有効化する）"
  value       = length(google_identity_platform_default_supported_idp_config.google) > 0
}

output "tenants" {
  description = "テナントごとの情報（apps/<id>/ の firebase.json・関数・画面の設定に使う）"
  value = {
    for id, t in module.tenant : id => {
      url                     = t.url
      site_id                 = t.site_id
      database                = t.database
      functions_codebase      = t.functions_codebase
      functions_export_group  = t.functions_export_group
      runtime_service_account = t.runtime_service_account
      secrets                 = t.secrets
      web_config              = t.web_config
    }
  }
}
