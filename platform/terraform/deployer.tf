# Copyright 2026 Google LLC
# SPDX-License-Identifier: Apache-2.0
# ==============================================================================
# アプリのデプロイ SA（fga-deployer）— GitHub Actions のアプリ用ワークフローだけが借用する
#   付けるもの  : Hosting・インデックス・Functions・スケジューラのデプロイに必要な権限
#   付けないもの: Security Rules（firebaserules.*）→ Rules の反映は Terraform（terraform-sa）だけ
#   Hosting と Functions の新規作成は PJ 単位の権限しかないため、他のアプリを上書きしないことは
#   CI のポリシーチェック（firebase.json の参照先・関数名の接頭辞）で守る（docs/platform_design.md §3.2）
# ==============================================================================

resource "google_service_account" "deployer" {
  project      = local.project_id
  account_id   = "fga-deployer"
  display_name = "Citizen apps deployer (GitHub Actions)"
  description  = "アプリの firebase deploy（Hosting・Functions・インデックス）用。Security Rules の権限は持たない"

  depends_on = [google_project_service.apis]
}

locals {
  deployer_roles = [
    "roles/firebasehosting.admin",    # Hosting のデプロイ（サイト単位の IAM はない）
    "roles/datastore.indexAdmin",     # Firestore のインデックス
    "roles/cloudfunctions.developer", # Functions のデプロイ
    "roles/cloudscheduler.admin",     # スケジュール関数のジョブ
    "roles/eventarc.developer",       # Firestore トリガー
    "roles/run.viewer",               # 第 2 世代の Functions の状態確認
    "roles/artifactregistry.reader",  # npm リモートリポジトリからの取得
    "roles/secretmanager.viewer",     # 関数が使うシークレットの存在確認（値は読まない）
    "roles/firebase.viewer",          # firebase CLI がプロジェクト情報を読む
    "roles/serviceusage.serviceUsageConsumer",
  ]
}

resource "google_project_iam_member" "deployer" {
  for_each = toset(local.deployer_roles)
  project  = local.project_id
  role     = each.key
  member   = "serviceAccount:${google_service_account.deployer.email}"
}

# GitHub Actions からの借用（このリポジトリの、デプロイ用ブランチで動くワークフローだけ。PR のブランチからは借用できない）
resource "google_service_account_iam_member" "deployer_github" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${local.github_wif_pool_name}/attribute.repo_ref/${local.github_repository}:${local.deploy_ref}"
}

# エンジニア組織によるローカルからの借用（CI を作る前の初回デプロイと、デプロイ SA の権限が足りるかの確認用）
#   gcloud auth application-default login --impersonate-service-account=fga-deployer@<project>.iam.gserviceaccount.com
resource "google_service_account_iam_member" "deployer_impersonators" {
  for_each           = toset(local.deployer_impersonators)
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = each.key
}

# ------------------------------------------------------------------------------
# Functions（第 2 世代）のビルド SA
#   Cloud Functions のビルドは既定で Compute Engine の既定 SA で実行されるが、
#   組織ポリシー（iam.automaticIamGrantsForDefaultServiceAccounts）で既定 SA への自動付与を止めている組織では、
#   既定 SA にロールが付かない。ビルドに必要なロールだけを付ける。
#   （関数の実行 SA は各アプリの app-<id>@ を必ず指定させるので、既定 SA が実行に使われることはない）
# ------------------------------------------------------------------------------
locals {
  compute_default_sa = "${data.google_project.this.number}-compute@developer.gserviceaccount.com"
}

resource "google_project_iam_member" "functions_builder" {
  project = local.project_id
  role    = "roles/cloudbuild.builds.builder"
  member  = "serviceAccount:${local.compute_default_sa}"

  depends_on = [google_project_service.apis]
}

# デプロイ SA がビルド SA を使えるようにする
resource "google_service_account_iam_member" "deployer_act_as_builder" {
  service_account_id = "projects/${local.project_id}/serviceAccounts/${local.compute_default_sa}"
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer.email}"

  depends_on = [google_project_service.apis]
}

# firebase-tools は PJ で最初に関数をデプロイするとき、次のプロジェクト IAM を確認し、なければ自分で付けようとする
# （checkIam.js の ensureServiceAgentRoles）。デプロイ SA にはプロジェクト IAM を変える権限がないので、ここで付けておく。
#   - Pub/Sub のサービスエージェント: Eventarc（Pub/Sub 経由）が関数を呼ぶときの OIDC トークンの発行に必要
#   - Compute Engine の既定 SA: firebase-tools がトリガーの既定 SA とみなして確認する。この基盤の関数は app-<app>@ で
#     実行・呼び出しされるので使われないが、確認を通すために必要（ビルドはこの SA で動くので、リスクは docs/platform_design.md §9）
resource "google_project_iam_member" "functions_service_agents" {
  for_each = {
    pubsub_token_creator   = { role = "roles/iam.serviceAccountTokenCreator", member = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-pubsub.iam.gserviceaccount.com" }
    compute_run_invoker    = { role = "roles/run.invoker", member = "serviceAccount:${local.compute_default_sa}" }
    compute_event_receiver = { role = "roles/eventarc.eventReceiver", member = "serviceAccount:${local.compute_default_sa}" }
  }
  project = local.project_id
  role    = each.value.role
  member  = each.value.member

  depends_on = [google_project_service.apis]
}

# firebase-tools は関数を含むデプロイの前に、App Engine の既定 SA への actAs を必ず確認し、なければ止まる
# （関数の実行 SA を指定していても。firebase-tools の checkServiceAccountIam）。
# この SA にはロールを何も付けないので、借用できても権限は増えない（docs/platform_design.md §9）
resource "google_service_account_iam_member" "deployer_act_as_appspot" {
  service_account_id = "projects/${local.project_id}/serviceAccounts/${local.project_id}@appspot.gserviceaccount.com"
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer.email}"

  depends_on = [google_project_service.apis]
}

# 既定のロールにない、デプロイに必要な最小限の権限（docs/platform_design.md §9）
#   - run.services.setIamPolicy: firebase-tools がスケジュール関数の Cloud Run サービスに invoker（実行 SA）を設定する
#   - firebaserules.rulesets.test: firebase.json に rules があると、インデックスのデプロイでも Rules のコンパイル確認が呼ばれる
#     （コンパイルの確認だけで、Rules の作成・反映はできない。反映は terraform-sa だけ）
# destroy すると削除済み（7 日間）になるが、同じ role_id で作り直すと provider が復元する
resource "google_project_iam_custom_role" "deployer_extras" {
  project     = local.project_id
  role_id     = "fgaDeployerExtras"
  title       = "FGA deployer extras"
  description = "fga-deployer に追加で必要な権限（スケジュール関数の invoker 設定・Rules のコンパイル確認）"
  permissions = [
    "run.services.getIamPolicy",
    "run.services.setIamPolicy",
    "firebaserules.rulesets.test",
  ]
}

resource "google_project_iam_member" "deployer_extras" {
  project = local.project_id
  role    = google_project_iam_custom_role.deployer_extras.id
  member  = "serviceAccount:${google_service_account.deployer.email}"
}
