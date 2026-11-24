# Copyright 2026 Google LLC
# SPDX-License-Identifier: Apache-2.0
# ==============================================================================
# Firebase Auth（Identity Platform）— 全アプリ共通（Auth はプロジェクトに 1 つ）
#   - ログイン方法は Google ログインだけ（メール/パスワードや匿名ログインは無効）
#   - 許可ドメインは、台帳から作った各アプリの Hosting サイトのドメインだけ
#   - 社内ドメインの確認は、各アプリの Security Rules（isInternal()）で必ず行う
#     （blocking function による社外ドメインの拒否は、組織ポリシーとの相性を確認してから追加する）
# ==============================================================================

locals {
  authorized_domains = concat(
    ["localhost"],
    flatten([
      for id, _ in local.apps : [
        "${local.site_prefix}-${id}.web.app",
        "${local.site_prefix}-${id}.firebaseapp.com",
      ]
    ]),
  )
}

resource "google_identity_platform_config" "this" {
  project = local.project_id

  authorized_domains = local.authorized_domains

  # API が既定値（allow_tenants = false）を返すので、書いておかないと毎回差分が出る（ドリフト検知の邪魔になる）
  multi_tenant {
    allow_tenants = false
  }

  sign_in {
    allow_duplicate_emails = false

    email {
      enabled           = false
      password_required = false
    }

    anonymous {
      enabled = false
    }

    phone_number {
      enabled = false
    }
  }

  depends_on = [google_firebase_project.this]
}

# Google ログイン（OAuth クライアントを指定したときだけ作る。variables.tf の説明を参照）
resource "google_identity_platform_default_supported_idp_config" "google" {
  count         = var.google_oauth_client_id != "" ? 1 : 0
  project       = local.project_id
  idp_id        = "google.com"
  client_id     = var.google_oauth_client_id
  client_secret = var.google_oauth_client_secret
  enabled       = true

  depends_on = [google_identity_platform_config.this]
}
