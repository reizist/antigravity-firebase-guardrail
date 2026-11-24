# Copyright 2026 Google LLC
# SPDX-License-Identifier: Apache-2.0
# プロジェクト ID・リージョン・社内ドメイン・サイトの接頭辞・GitHub リポジトリは platform/config.json で決める（config.tf）

variable "terraform_sa_id" {
  description = "Terraform が借用するサービスアカウントの ID（bootstrap の terraform_sa_id と同じ値）"
  type        = string
  default     = "terraform-sa"
}

variable "catalog_path" {
  description = "アプリ台帳のパス（このディレクトリからの相対パス）"
  type        = string
  default     = "../catalog/apps.yaml"
}

variable "apps_dir" {
  description = "アプリのディレクトリ（apps/<id>/firestore.rules を読む）"
  type        = string
  default     = "../../apps"
}

# ------------------------------------------------------------------------------
# Firebase Auth の Google ログイン
#   Google ログインには OAuth クライアントが必要だが、Terraform（API）からは作れない。
#   コンソールで作った OAuth クライアントの ID / シークレットを terraform.tfvars（Git 管理外）か
#   CI のシークレット（TF_VAR_google_oauth_client_id / _secret）で渡す。
#   空のままなら Google プロバイダは作らない（Firebase コンソールで有効化する）。
# ------------------------------------------------------------------------------
variable "google_oauth_client_id" {
  description = "Google ログイン用 OAuth クライアント ID（空なら Google プロバイダを Terraform で作らない）"
  type        = string
  default     = ""
}

variable "google_oauth_client_secret" {
  description = "Google ログイン用 OAuth クライアントシークレット"
  type        = string
  default     = ""
  sensitive   = true
}

# ------------------------------------------------------------------------------
# 予算アラート（任意）
#   予算の作成には課金アカウント側の権限（billing.budgets.create）が必要なので、既定では作らない。
# ------------------------------------------------------------------------------
variable "enable_budgets" {
  description = "予算アラートを作るか（課金アカウント側の権限が必要）"
  type        = bool
  default     = false
}

variable "billing_account" {
  description = "予算アラートを作る課金アカウント ID（enable_budgets = true のとき）"
  type        = string
  default     = ""
}

variable "project_budget_jpy" {
  description = "共有プロジェクト全体の月額予算（円）"
  type        = number
  default     = 30000
}

variable "budget_currency" {
  description = "予算の通貨（課金アカウントの通貨に合わせる）"
  type        = string
  default     = "JPY"
}
