# ==============================================================================
# 共有プロジェクトの設定（エンジニア組織が管理）
#   config.tf    : platform/config.json の読み込み（プロジェクト ID・社内ドメインなど）
#   main.tf      : API・Firebase の追加・台帳の読み込み・テナントの払い出し
#   auth.tf      : Firebase Auth（Identity Platform・Google ログイン・許可ドメイン）
#   deployer.tf  : アプリのデプロイ SA（fga-deployer）と Functions のビルド SA
#   registry.tf  : Artifact Registry の npm リモートリポジトリ（パッケージの取得先を 1 つにする）
#   budget.tf    : 予算アラート（Pub/Sub・メールに通知）
#   audit_alerts.tf : Firestore のデータベース作成の監査アラート
#   modules/app-tenant : 1 アプリ分のテナント（サイト・DB・TTL・API キー・実行 SA・シークレット・Security Rules）
# すべて destroy できる（Firestore は deletion_policy = "DELETE"）。
# ==============================================================================

provider "google" {
  project                     = local.project_id
  region                      = local.region
  impersonate_service_account = local.terraform_sa_email
}

# Firebase Management API・Cloud Billing Budget API などは、呼び出し元のプロジェクトをクォータ先として指定する必要がある
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
    "billingbudgets.googleapis.com",   # 予算アラート（budget.tf）
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
    "monitoring.googleapis.com",    # 監査アラート・通知チャネル（audit_alerts.tf）
    "pubsub.googleapis.com",        # スケジュール関数・Eventarc の内部、予算・監査アラートの通知先
    "run.googleapis.com",           # 第 2 世代の Functions の実体
    "secretmanager.googleapis.com", # Webhook URL などのシークレット
    "securetoken.googleapis.com",   # Firebase Auth のトークン
    "storage.googleapis.com",       # Functions のソース置き場
  ]

  # 台帳は 2 か所（docs/platform_design.md §3.4）
  #   catalog/apps.yaml           : エンジニア組織がレビューするアプリ（CODEOWNERS の対象）
  #   catalog/self-service/<id>.yaml : 標準の型に収まる Tier 0 のアプリ（レビューなし。型から外れたら下の検証で止める）
  catalog            = yamldecode(file("${path.module}/${var.catalog_path}"))
  reviewed_apps      = merge({}, try(local.catalog.apps, null))
  self_service_files = fileset("${path.module}/${var.self_service_dir}", "*.yaml")
  self_service_apps  = { for f in local.self_service_files : trimsuffix(f, ".yaml") => yamldecode(file("${path.module}/${var.self_service_dir}/${f}")) }
  apps               = merge(local.self_service_apps, local.reviewed_apps)

  # 台帳の最低限の検証（CI のポリシーチェックでも確認する）
  #   app id は Firestore の DB 名にも使うため 4〜20 文字（英小文字で始まり、英小文字か数字で終わる）
  standard_rules_templates = ["internal-team-collab", "internal-author-only"]
  invalid_app_ids          = [for id, _ in local.apps : id if length(regexall("^[a-z][a-z0-9-]{2,18}[a-z0-9]$", id)) == 0]
  invalid_tiers            = [for id, app in local.apps : id if !contains([0, 1], try(app.tier, -1))]
  invalid_templates        = [for id, app in local.apps : id if !contains(concat(local.standard_rules_templates, ["custom"]), try(app.rules_template, "custom"))]
  invalid_tier0_data       = [for id, app in local.apps : id if try(app.tier, -1) == 0 && (!contains(["public", "internal"], try(app.data_class, "")) || try(app.handles_pii, false) != false)]
  invalid_expires          = [for id, app in local.apps : id if length(regexall("^[0-9]{4}-[0-9]{2}-[0-9]{2}$", tostring(try(app.expires, "")))) == 0]
  duplicate_ids            = [for id, _ in local.self_service_apps : id if contains(keys(local.reviewed_apps), id)]
  # セルフサービスの台帳に置けるのは、標準の型だけ（Tier 0・個人情報なし・標準の Rules・シークレットなし・外部送信なし）
  invalid_self_service = [for id, app in local.self_service_apps : id if(
    try(app.tier, -1) != 0
    || !contains(local.standard_rules_templates, try(app.rules_template, "custom"))
    || length(coalesce(try(app.secrets, null), [])) > 0
    || length(coalesce(try(app.external_egress, null), [])) > 0
  )]
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
      condition     = length(local.apps) <= var.max_apps_per_project
      error_message = "共有プロジェクトに置けるアプリ数の上限（${var.max_apps_per_project}）を超えています（Hosting 36 サイト・Firestore 100 DB の上限の手前で止めている）。専用プロジェクトへの切り出しを検討してください"
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
    precondition {
      condition     = length(local.invalid_templates) == 0
      error_message = "rules_template は internal-team-collab / internal-author-only / custom のどれかにしてください: ${join(", ", local.invalid_templates)}"
    }
    precondition {
      condition     = length(local.invalid_tier0_data) == 0
      error_message = "Tier 0 では confidential のデータや個人情報（handles_pii: true）を扱えません。Tier 1 / 2 にしてください: ${join(", ", local.invalid_tier0_data)}"
    }
    precondition {
      condition     = length(local.invalid_expires) == 0
      error_message = "すべてのアプリに YYYY-MM-DD の有効期限（expires）が要ります: ${join(", ", local.invalid_expires)}"
    }
    precondition {
      condition     = length(local.duplicate_ids) == 0
      error_message = "同じ app id が apps.yaml と self-service/ の両方にあります: ${join(", ", local.duplicate_ids)}"
    }
    precondition {
      condition     = length(local.invalid_self_service) == 0
      error_message = "self-service/ に置けるのは標準の型だけです（tier 0・標準の rules_template・secrets と external_egress なし）。apps.yaml に移してエンジニア組織のレビューを受けてください: ${join(", ", local.invalid_self_service)}"
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
  rules_templates_dir = "${path.module}/../rules-templates"
  deployer_email      = google_service_account.deployer.email
  labels              = local.labels

  depends_on = [
    google_firebase_project.this,
    google_identity_platform_config.this,
    terraform_data.catalog_check,
  ]
}
