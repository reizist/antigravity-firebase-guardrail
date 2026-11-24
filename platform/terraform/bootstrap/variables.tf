# プロジェクト ID・リージョン・GitHub リポジトリは platform/config.json で決める（config.tf）

variable "project_name" {
  description = "共有 GCP プロジェクトの表示名"
  type        = string
  default     = "Firebase Governance Apps"
}

variable "create_project" {
  description = "Terraform で新しく GCP プロジェクトを作るか（既にあるプロジェクトを使うなら false）"
  type        = bool
  default     = true
}

variable "org_id" {
  description = "作成先の組織 ID（folder_id を指定したときは使わない）"
  type        = string
  default     = ""
}

variable "folder_id" {
  description = "作成先のフォルダ ID（任意）"
  type        = string
  default     = ""
}

variable "billing_account" {
  description = "新しいプロジェクトに紐付ける課金アカウント ID"
  type        = string
  default     = ""
}

variable "terraform_sa_id" {
  description = "Terraform 用サービスアカウントの ID"
  type        = string
  default     = "terraform-sa"
}

variable "terraform_operators" {
  description = "Terraform 用サービスアカウントを借用できる IAM メンバー（エンジニア組織。例: [\"group:platform-engineers@example.com\"]）"
  type        = list(string)
}
