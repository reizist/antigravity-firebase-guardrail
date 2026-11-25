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
# 予算アラート・監査アラート
#   作るかどうか・金額・通知先は platform/config.json で決める（config.tf）。ここは補助の値だけ。
# ------------------------------------------------------------------------------
variable "billing_account" {
  description = "予算アラートを作る課金アカウント ID（空なら、プロジェクトに紐付いている課金アカウントを使う）"
  type        = string
  default     = ""
}

variable "budget_currency" {
  description = "予算の通貨（課金アカウントの通貨に合わせる）"
  type        = string
  default     = "JPY"
}

variable "self_service_dir" {
  description = "セルフサービスの台帳のディレクトリ（1 アプリ 1 ファイル。このディレクトリからの相対パス）"
  type        = string
  default     = "../catalog/self-service"
}

variable "max_apps_per_project" {
  description = "共有プロジェクト 1 つに置けるアプリ数の上限（Hosting 36 サイト・Firestore 100 DB の上限の手前で止める）"
  type        = number
  default     = 30
}

# ------------------------------------------------------------------------------
# API クォータ上限（quotas.tf。既定では空＝0 件スキップ。terraform.tfvars で指定する）
# ------------------------------------------------------------------------------
variable "quota_contact_email" {
  description = "Cloud Quotas API のクォータ変更申請に添える連絡先メールアドレス（任意）"
  type        = string
  default     = ""
}

variable "api_quota_caps" {
  description = "Cloud Quotas API で共有プロジェクト全体の API 消費上限を引き下げる設定（キーは任意の識別子）"
  type = map(object({
    service         = string
    quota_id        = string
    preferred_value = number
    dimensions      = optional(map(string), {})
    justification   = optional(string, "Firebase guardrail cost cap")
  }))
  default = {}
}
