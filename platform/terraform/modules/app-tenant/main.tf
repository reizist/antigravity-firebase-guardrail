# Copyright 2026 Google LLC
# SPDX-License-Identifier: Apache-2.0
# ==============================================================================
# 1 アプリ分のテナント（共有プロジェクトの中で、アプリごとに分けるもの）
#   名前の付け方は docs/platform_design.md §3.1
#     Hosting サイト   : <site_prefix>-<id>          （例: fga-news-watcher）
#     Firestore DB     : <id>                        （例: news-watcher）
#     Web アプリ・API キー: <site_prefix>-<id>-web   （リファラと API を絞った API キー）
#     実行 SA          : app-<id>@                   （自分の DB・自分のシークレットだけ）
#     関数名           : <idのcamelCase>-<関数名>    （Cloud Run のサービス名は <idからハイフンを除いたもの>-...）
#     シークレット     : <ID>_<名前>（英大文字・アンダースコア。firebase-tools の制約）
#     Security Rules   : apps/<id>/firestore.rules を Terraform だけが反映する（§3.3）
# ==============================================================================

locals {
  id_parts       = split("-", var.app_id)
  camel_id       = join("", concat([local.id_parts[0]], [for p in slice(local.id_parts, 1, length(local.id_parts)) : title(p)]))
  service_prefix = "${replace(var.app_id, "-", "")}-" # 第 2 世代の Functions の Cloud Run サービス名（小文字化される）
  site_id        = "${var.site_prefix}-${var.app_id}"
  owners         = try(var.app.owners, [])
  admins         = try(var.app.admins, [])
  secret_names   = try(var.app.secrets, [])
  database_name  = "projects/${var.project_id}/databases/${var.app_id}"
  tier           = tostring(try(var.app.tier, 0))
  department     = lower(replace(try(var.app.department, "unknown"), "/[^a-zA-Z0-9_-]/", "-"))
  data_class     = try(var.app.data_class, "internal")
  rules_exists   = fileexists(var.rules_file)
  deny_all_rules = <<-EOT
    rules_version = '2';
    // apps/${var.app_id}/firestore.rules がまだないため、すべて拒否する（platform の Terraform が反映）
    service cloud.firestore {
      match /databases/{database}/documents {
        match /{document=**} {
          allow read, write: if false;
        }
      }
    }
  EOT

  app_labels = merge(var.labels, {
    app        = var.app_id
    tier       = local.tier
    owner-team = local.department
    data-class = local.data_class
  })
}

# ------------------------------------------------------------------------------
# 1. Firestore（アプリ専用のデータベース。Security Rules とインデックスも DB ごとに独立）
# ------------------------------------------------------------------------------
resource "google_firestore_database" "app" {
  project                           = var.project_id
  name                              = var.app_id
  location_id                       = var.region
  type                              = "FIRESTORE_NATIVE"
  concurrency_mode                  = "OPTIMISTIC"
  app_engine_integration_mode       = "DISABLED"
  point_in_time_recovery_enablement = "POINT_IN_TIME_RECOVERY_DISABLED"
  delete_protection_state           = "DELETE_PROTECTION_DISABLED"
  deletion_policy                   = "DELETE"
}

# ------------------------------------------------------------------------------
# 2. Web アプリ登録・API キー・Hosting サイト
#    Firebase の Web API キーは画面に埋め込まれて公開されるため、
#    このアプリのサイトからの呼び出しと、Firebase の API だけに絞った専用キーを使う
# ------------------------------------------------------------------------------
resource "google_apikeys_key" "web" {
  project      = var.project_id
  name         = "${local.site_id}-web"
  display_name = "${var.app_id} (web)"

  restrictions {
    browser_key_restrictions {
      allowed_referrers = [
        "https://${local.site_id}.web.app/*",
        "https://${local.site_id}.firebaseapp.com/*",
        "https://${local.site_id}--*.web.app/*", # Hosting のプレビューチャネル
        # ログイン処理（/__/auth/handler）は PJ の既定ドメインで動き、そこからこのキーで Auth の設定を読む。
        # ないと、ログインのポップアップが「The requested action is invalid.」になる（2026-11-12）
        "https://${var.auth_handler_domain}/*",
      ]
    }

    dynamic "api_targets" {
      for_each = toset([
        "firebase.googleapis.com",
        "firebaseinstallations.googleapis.com",
        "firebaseappcheck.googleapis.com",
        "firestore.googleapis.com",
        "identitytoolkit.googleapis.com",
        "securetoken.googleapis.com",
      ])
      content {
        service = api_targets.value
      }
    }
  }
}

resource "google_firebase_web_app" "app" {
  provider        = google-beta
  project         = var.project_id
  display_name    = try(var.app.display_name, var.app_id)
  api_key_id      = google_apikeys_key.web.uid
  deletion_policy = "DELETE"
}

data "google_firebase_web_app_config" "app" {
  provider   = google-beta
  project    = var.project_id
  web_app_id = google_firebase_web_app.app.app_id
}

resource "google_firebase_hosting_site" "app" {
  provider = google-beta
  project  = var.project_id
  site_id  = local.site_id
  app_id   = google_firebase_web_app.app.app_id
}

# ------------------------------------------------------------------------------
# 3. 実行 SA（関数はすべてこの SA で動かす。CI のポリシーチェックで serviceAccount の指定を必須にする）
# ------------------------------------------------------------------------------
resource "google_service_account" "runtime" {
  project      = var.project_id
  account_id   = "app-${var.app_id}"
  display_name = "${var.app_id} runtime"
  description  = "${var.app_id} の Cloud Functions 実行用。自分の Firestore DB とシークレットだけにアクセスできる"
}

# 自分の DB だけ読み書きできる（IAM Conditions で DB 名を限定）
resource "google_project_iam_member" "runtime_datastore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.runtime.email}"

  condition {
    title       = "only-${var.app_id}-database"
    description = "Firestore DB ${var.app_id} だけ"
    expression  = "resource.name == \"${local.database_name}\" || resource.name.startsWith(\"${local.database_name}/\")"
  }
}

# 関数の起動（run.invoker）は、PJ 単位の IAM Conditions（resource.name）では絞れなかったため、ここでは付けない。
# デプロイの後に scripts/deploy_app.sh が、自分の関数のサービスごとに実行 SA の run.invoker を付ける（docs/platform_design.md §9）

# PJ 単位でしか付けられないもの（Gemini の呼び出し・ログ出力・Eventarc のイベント受信）
resource "google_project_iam_member" "runtime_project_roles" {
  for_each = toset([
    "roles/aiplatform.user",
    "roles/logging.logWriter",
    "roles/eventarc.eventReceiver",
  ])
  project = var.project_id
  role    = each.key
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

# デプロイ SA が、この実行 SA を関数に割り当てられるようにする（アプリ単位）
resource "google_service_account_iam_member" "deployer_act_as_runtime" {
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${var.deployer_email}"
}

# ------------------------------------------------------------------------------
# 4. シークレットの入れ物（値はオーナーが登録する。Firestore やコードには書かない）
# ------------------------------------------------------------------------------
resource "google_secret_manager_secret" "app" {
  for_each = toset(local.secret_names)
  project  = var.project_id
  # firebase-tools はシークレット名に英大文字・数字・アンダースコアしか認めない（defineSecret の名前＝環境変数名）
  secret_id = upper(replace("${var.app_id}_${each.key}", "-", "_"))
  labels    = local.app_labels

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
}

resource "google_secret_manager_secret_iam_member" "runtime_accessor" {
  for_each  = google_secret_manager_secret.app
  project   = var.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_secret_manager_secret_iam_member" "owner_version_adder" {
  for_each = {
    for pair in setproduct(local.secret_names, local.owners) : "${pair[0]}|${pair[1]}" => {
      secret = pair[0]
      member = pair[1]
    }
  }
  project   = var.project_id
  secret_id = google_secret_manager_secret.app[each.value.secret].secret_id
  role      = "roles/secretmanager.secretVersionAdder"
  member    = each.value.member
}

# ------------------------------------------------------------------------------
# 5. オーナー（業務部門）の権限：自分の DB の閲覧だけ（デプロイ権限は付けない。デプロイは CI から）
# ------------------------------------------------------------------------------
resource "google_project_iam_member" "owner_datastore_viewer" {
  for_each = toset(local.owners)
  project  = var.project_id
  role     = "roles/datastore.viewer"
  member   = each.key

  condition {
    title       = "only-${var.app_id}-database"
    description = "Firestore DB ${var.app_id} だけ"
    expression  = "resource.name == \"${local.database_name}\" || resource.name.startsWith(\"${local.database_name}/\")"
  }
}

# ------------------------------------------------------------------------------
# 6. Security Rules（本番への反映は Terraform だけ。アプリのデプロイ SA は権限を持たない）
# ------------------------------------------------------------------------------
resource "google_firebaserules_ruleset" "firestore" {
  project = var.project_id

  source {
    files {
      name    = "firestore.rules"
      content = local.rules_exists ? file(var.rules_file) : local.deny_all_rules
    }
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "google_firebaserules_release" "firestore" {
  project      = var.project_id
  name         = "cloud.firestore/${google_firestore_database.app.name}"
  ruleset_name = "projects/${var.project_id}/rulesets/${google_firebaserules_ruleset.firestore.name}"

  lifecycle {
    replace_triggered_by = [google_firebaserules_ruleset.firestore]
  }
}

# ------------------------------------------------------------------------------
# 7. アプリ内の最初の admin（members/{email}。以降の追加・変更はアプリの画面から行うので、Terraform は作成だけ）
# ------------------------------------------------------------------------------
resource "google_firestore_document" "initial_admin" {
  for_each    = toset([for e in local.admins : lower(e)])
  project     = var.project_id
  database    = google_firestore_database.app.name
  collection  = "members"
  document_id = each.key
  fields = jsonencode({
    email     = { stringValue = each.key }
    role      = { stringValue = "admin" }
    createdBy = { stringValue = "terraform" }
  })

  lifecycle {
    ignore_changes = [fields]
  }
}
