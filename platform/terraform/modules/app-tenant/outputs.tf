# Copyright 2026 Google LLC
# SPDX-License-Identifier: Apache-2.0
output "site_id" {
  description = "Hosting サイト ID"
  value       = google_firebase_hosting_site.app.site_id
}

output "url" {
  description = "アプリの URL"
  value       = "https://${google_firebase_hosting_site.app.site_id}.web.app"
}

output "database" {
  description = "Firestore DB 名"
  value       = google_firestore_database.app.name
}

output "functions_codebase" {
  description = "firebase.json の functions.codebase に指定する名前"
  value       = var.app_id
}

output "functions_export_group" {
  description = "関数を export するグループ名（関数名は <これ>-<関数名> になる）"
  value       = local.camel_id
}

output "runtime_service_account" {
  description = "関数の serviceAccount に指定する実行 SA"
  value       = google_service_account.runtime.email
}

output "secrets" {
  description = "シークレット ID の一覧（defineSecret に指定する名前）"
  value       = [for s in google_secret_manager_secret.app : s.secret_id]
}

output "web_app_id" {
  description = "Firebase の Web アプリ ID"
  value       = google_firebase_web_app.app.app_id
}

output "web_config" {
  description = "画面（web/）に埋め込む Firebase の設定（公開される値。秘密情報ではない）"
  value = {
    projectId         = var.project_id
    appId             = google_firebase_web_app.app.app_id
    apiKey            = data.google_firebase_web_app_config.app.api_key
    authDomain        = "${google_firebase_hosting_site.app.site_id}.firebaseapp.com"
    messagingSenderId = data.google_firebase_web_app_config.app.messaging_sender_id
    databaseId        = google_firestore_database.app.name
  }
}
