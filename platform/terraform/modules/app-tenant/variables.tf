variable "project_id" {
  description = "共有 GCP プロジェクト ID"
  type        = string
}

variable "project_number" {
  description = "共有 GCP プロジェクト番号"
  type        = string
}

variable "region" {
  description = "Firestore・Functions・Secret Manager のリージョン"
  type        = string
}

variable "app_id" {
  description = "台帳の app id（例: news-watcher）"
  type        = string
}

variable "app" {
  description = "台帳のエントリ（platform/catalog/apps.yaml の apps.<id>）"
  type        = any
}

variable "site_prefix" {
  description = "Hosting サイト ID の接頭辞"
  type        = string
}

variable "internal_domain" {
  description = "社内ドメイン"
  type        = string
}

variable "rules_file" {
  description = "アプリ独自の Security Rules ファイル（apps/<id>/firestore.rules）。rules_template が custom のときに使う（なければ全拒否の Rules を反映する）"
  type        = string
}

variable "rules_templates_dir" {
  description = "標準の Security Rules テンプレートのディレクトリ（platform/rules-templates）"
  type        = string
}

variable "deployer_email" {
  description = "アプリのデプロイ SA（fga-deployer）"
  type        = string
}

variable "labels" {
  description = "共通ラベル"
  type        = map(string)
  default     = {}
}

variable "auth_handler_domain" {
  description = "Firebase Auth のログイン処理を動かすドメイン（PJ の既定の Hosting サイト）。API キーの許可リファラに加える"
  type        = string
}
