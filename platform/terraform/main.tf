# ==============================================================================
# 共有プロジェクトの設定（エンジニア組織が管理）
#   config.tf    : platform/config.json の読み込み（プロジェクト ID・社内ドメインなど）
#   main.tf      : API・Firebase の追加・台帳の読み込み・テナントの払い出し
#   auth.tf      : Firebase Auth（Identity Platform・Google ログイン・許可ドメイン）
#   deployer.tf  : アプリのデプロイ SA（fga-deployer）と Functions のビルド SA
#   registry.tf  : Artifact Registry の npm リモートリポジトリ（パッケージの取得先を 1 つにする）
#   budget.tf    : 予算アラート（任意）
#   modules/app-tenant : 1 アプリ分のテナント（サイト・DB・API キー・実行 SA・シークレット・Security Rules）
# すべて destroy できる（Firestore は deletion_policy = "DELETE"）。
# ==============================================================================

provider "google" {
  project                     = local.project_id
  region                      = local.region
  impersonate_service_account = local.terraform_sa_email
}

# Firebase Management API などは、呼び出し元のプロジェクトをクォータ先として指定する必要がある
provider "google-beta" {
  project                     = local.project_id
  region                      = local.region
  impersonate_service_account = local.terraform_sa_email
  user_project_override       = true
  billing_project             = local.project_id
}

data "google_project" "this" {
  project_id = local.project_id
}

locals {
  # 共有プロジェクトで有効にする API はこれだけ（本番では組織ポリシー gcp.restrictServiceUsage で許可リストにする）
  services = [
    "aiplatform.googleapis.com",       # Gemini（Vertex AI）
    "apikeys.googleapis.com",          # アプリごとの制限付き API キー
    "artifactregistry.googleapis.com", # Functions のイメージ・npm リモートリポジトリ
    "cloudbilling.googleapis.com",     # firebase-tools が関数のデプロイ前に課金（Blaze）の有効を確認する
    "cloudbuild.googleapis.com",       # Functions のビルド
    "cloudfunctions.googleapis.com",   # Cloud Functions for Firebase（第 2 世代）
    "cloudscheduler.googleapis.com",   # スケジュール関数
    "eventarc.googleapis.com",         # Firestore トリガー
    "firebase.googleapis.com",         # Firebase Management
    "firebaseappcheck.googleapis.com", # App Check（Phase 3）
    "firebasehosting.googleapis.com",  # Hosting
    "firebaseinstallations.googleapis.com",
    "firebaserules.googleapis.com", # Security Rules
    "firestore.googleapis.com",     # Firestore
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "identitytoolkit.googleapis.com", # Firebase Auth（Identity Platform）
    "logging.googleapis.com",
    "pubsub.googleapis.com",        # スケジュール関数・Eventarc の内部で使う
    "run.googleapis.com",           # 第 2 世代の Functions の実体
    "secretmanager.googleapis.com", # Webhook URL などのシークレット
    "securetoken.googleapis.com",   # Firebase Auth のトークン
    "storage.googleapis.com",       # Functions のソース置き場
  ]

  catalog = yamldecode(file("${path.module}/${var.catalog_path}"))
  apps    = try(local.catalog.apps, {})

  # 台帳の最低限の検証（CI のポリシーチェックでも確認する）
  #   app id は Firestore の DB 名にも使うため 4〜20 文字（英小文字で始まり、英小文字か数字で終わる）
  invalid_app_ids = [for id, _ in local.apps : id if length(regexall("^[a-z][a-z0-9-]{2,18}[a-z0-9]$", id)) == 0]
  invalid_tiers   = [for id, app in local.apps : id if !contains([0, 1], try(app.tier, -1))]
  # 関数の Cloud Run サービス名はハイフンを除いて小文字化されるので、それが重なる id は認めない（news-watcher と newswatcher など）
  service_prefixes = [for id, _ in local.apps : replace(id, "-", "")]

  labels = {
    workload = "firebase-guardrail"
    managed  = "terraform"
  }
}

resource "terraform_data" "catalog_check" {
  input = keys(local.apps)

  lifecycle {
    precondition {
      condition     = local.project_id != "your-firebase-project-id" && local.internal_domain != "example.com" && local.github_repository != "your-org/your-repo"
      error_message = "platform/config.json が雛形のままです。project_id・internal_domain・github_repository を自分の環境の値に書き換えてください"
    }
    precondition {
      condition     = length(local.invalid_app_ids) == 0
      error_message = "台帳の app id が規則（英小文字で始まり英小文字か数字で終わる、英小文字・数字・ハイフンの 4〜20 文字）に合いません: ${join(", ", local.invalid_app_ids)}"
    }
    precondition {
      condition     = length(local.service_prefixes) == length(distinct(local.service_prefixes))
      error_message = "ハイフンを除くと同じになる app id があります（関数のサービス名が重なるため不可）"
    }
    precondition {
      condition     = length(local.invalid_tiers) == 0
      error_message = "共有プロジェクトに置けるのは tier 0 / 1 だけです（Tier 2 は専用 PJ）: ${join(", ", local.invalid_tiers)}"
    }
  }
}

# 1. API
resource "google_project_service" "apis" {
  for_each           = toset(local.services)
  project            = local.project_id
  service            = each.key
  disable_on_destroy = false
}

# 2. 共有プロジェクトを Firebase プロジェクトにする
resource "google_firebase_project" "this" {
  provider = google-beta
  project  = local.project_id

  depends_on = [google_project_service.apis]
}

# 3. テナント（台帳の 1 件 = 1 アプリ）
module "tenant" {
  source   = "./modules/app-tenant"
  for_each = local.apps

  providers = {
    google      = google
    google-beta = google-beta
  }

  project_id          = local.project_id
  project_number      = data.google_project.this.number
  region              = local.region
  app_id              = each.key
  auth_handler_domain = local.auth_handler_domain
  app                 = each.value
  site_prefix         = local.site_prefix
  internal_domain     = local.internal_domain
  rules_file          = "${path.module}/${var.apps_dir}/${each.key}/firestore.rules"
  deployer_email      = google_service_account.deployer.email
  labels              = local.labels

  depends_on = [
    google_firebase_project.this,
    google_identity_platform_config.this,
    terraform_data.catalog_check,
  ]
}
