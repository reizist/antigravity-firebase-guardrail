# Copyright 2026 Google LLC
# SPDX-License-Identifier: Apache-2.0
# ==============================================================================
# Artifact Registry の npm リモートリポジトリ（docs/platform_design.md §7.2）
#   npmjs.com に直接取りに行かせず、取得先をこのリポジトリ 1 つにする。
#   取得の記録が監査ログに残り、問題のある版が見つかったときの調査・遮断の起点になる。
#   .npmrc: registry=https://<region>-npm.pkg.dev/<project>/npm-remote/
# ==============================================================================

resource "google_artifact_registry_repository" "npm_remote" {
  project       = local.project_id
  location      = local.region
  repository_id = "npm-remote"
  description   = "npmjs.com のリモートリポジトリ（市民開発アプリのパッケージ取得先）"
  format        = "NPM"
  mode          = "REMOTE_REPOSITORY"
  labels        = local.labels

  remote_repository_config {
    description = "npmjs.com"
    npm_repository {
      public_repository = "NPMJS"
    }
  }

  depends_on = [google_project_service.apis]
}

# 読み取り：デプロイ SA・アプリのオーナー（ローカル開発で pnpm install するため）
resource "google_artifact_registry_repository_iam_member" "npm_remote_readers" {
  for_each = toset(concat(
    ["serviceAccount:${google_service_account.deployer.email}"],
    distinct(flatten([for _, app in local.apps : try(app.owners, [])])),
  ))
  project    = local.project_id
  location   = google_artifact_registry_repository.npm_remote.location
  repository = google_artifact_registry_repository.npm_remote.name
  role       = "roles/artifactregistry.reader"
  member     = each.key
}

# ==============================================================================
# Functions のコンテナイメージ置き場（Cloud Functions が既定で使う名前 gcf-artifacts）
#   firebase-tools は削除ポリシー firebase-functions-cleanup がないとデプロイの最後でエラーにするが、
#   デプロイ SA にはリポジトリを変更する権限がないので、ここで作って付けておく（docs/platform_design.md §9）
#   既に Functions が作ってしまった PJ では import する:
#     terraform import google_artifact_registry_repository.gcf_artifacts projects/<project>/locations/<region>/repositories/gcf-artifacts
# ==============================================================================

resource "google_artifact_registry_repository" "gcf_artifacts" {
  project       = local.project_id
  location      = local.region
  repository_id = "gcf-artifacts"
  description   = "This repository is created and used by Cloud Functions for storing function docker images."
  format        = "DOCKER"

  # firebase-tools の既定（1 日より古いイメージを削除）と同じ内容にする
  cleanup_policies {
    id     = "firebase-functions-cleanup"
    action = "DELETE"
    condition {
      tag_state  = "ANY"
      older_than = "86400s"
    }
  }

  depends_on = [google_project_service.apis]
}
