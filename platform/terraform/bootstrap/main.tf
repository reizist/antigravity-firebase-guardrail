# ==============================================================================
# ブートストラップ（プロジェクトを作成し課金を紐付けられる人が、最初に 1 回だけ実行する）
#   1. 共有 GCP プロジェクト（業務部門のアプリを「テナント」として同居させる）
#   2. Terraform 用サービスアカウント（エンジニア組織だけが借用できる）
#   3. tfstate バケット
#   4. GitHub Actions からの鍵なし認証（Workload Identity Federation）の土台（github_wif.tf）
# 以降の操作は、terraform_operators（エンジニア組織）が Terraform SA を借用して行う。
# ==============================================================================

provider "google" {
  region = local.region
}

resource "terraform_data" "config_check" {
  input = local.project_id

  lifecycle {
    precondition {
      condition     = local.project_id != "your-firebase-project-id" && local.github_repository != "your-org/your-repo"
      error_message = "platform/config.json が雛形のままです。project_id・github_repository を自分の環境の値に書き換えてください"
    }
  }
}

# 1. 共有プロジェクト（deletion_policy = "DELETE" で terraform destroy 時にプロジェクトごと消せる）
resource "google_project" "shared" {
  count           = var.create_project ? 1 : 0
  name            = var.project_name
  project_id      = local.project_id
  org_id          = var.folder_id == "" && var.org_id != "" ? var.org_id : null
  folder_id       = var.folder_id != "" ? var.folder_id : null
  billing_account = var.billing_account != "" ? var.billing_account : null
  deletion_policy = "DELETE"

  depends_on = [terraform_data.config_check]

  labels = {
    workload = "firebase-guardrail"
    managed  = "terraform"
    firebase = "enabled"
  }
}

locals {
  effective_project_id = var.create_project ? google_project.shared[0].project_id : local.project_id
  bootstrap_apis = [
    "cloudresourcemanager.googleapis.com",
    "serviceusage.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
    "storage.googleapis.com",
  ]
}

# 2. 土台となる API
resource "google_project_service" "bootstrap_apis" {
  for_each           = toset(local.bootstrap_apis)
  project            = local.effective_project_id
  service            = each.key
  disable_on_destroy = false

  depends_on = [google_project.shared]
}

# 3. Terraform 用サービスアカウント
#    Security Rules を本番に反映できるのはこの SA だけ（アプリのデプロイ SA には firebaserules.* を付けない）
resource "google_service_account" "terraform_sa" {
  project      = local.effective_project_id
  account_id   = var.terraform_sa_id
  display_name = "Firebase guardrail Terraform"
  description  = "エンジニア組織が共有プロジェクト・テナント・Security Rules を管理するために借用する SA"

  depends_on = [google_project_service.bootstrap_apis]
}

locals {
  terraform_sa_roles = [
    "roles/editor",
    "roles/resourcemanager.projectIamAdmin",
    "roles/serviceusage.serviceUsageAdmin",
    "roles/iam.serviceAccountAdmin",
    "roles/firebase.admin",
    "roles/firebaserules.admin",
    "roles/identityplatform.admin",
    "roles/datastore.owner",
    "roles/secretmanager.admin",
    "roles/artifactregistry.admin",
    "roles/serviceusage.apiKeysAdmin",
    "roles/storage.admin",
    "roles/logging.configWriter",
    "roles/iam.roleAdmin", # デプロイ SA のカスタムロール（fgaDeployerExtras）
  ]
}

resource "google_project_iam_member" "terraform_sa_roles" {
  for_each = toset(local.terraform_sa_roles)
  project  = local.effective_project_id
  role     = each.key
  member   = "serviceAccount:${google_service_account.terraform_sa.email}"
}

# 4. エンジニア組織（と GitHub Actions 経由の自分自身）だけが Terraform SA を借用できる
resource "google_service_account_iam_binding" "token_creator" {
  service_account_id = google_service_account.terraform_sa.name
  role               = "roles/iam.serviceAccountTokenCreator"
  members            = concat(var.terraform_operators, ["serviceAccount:${google_service_account.terraform_sa.email}"])
}

resource "google_service_account_iam_binding" "user" {
  service_account_id = google_service_account.terraform_sa.name
  role               = "roles/iam.serviceAccountUser"
  members            = var.terraform_operators
}

# 4b. エンジニア組織に共有プロジェクトの Owner を付ける
resource "google_project_iam_member" "operators_owner" {
  for_each = toset(var.terraform_operators)
  project  = local.effective_project_id
  role     = "roles/owner"
  member   = each.key

  depends_on = [google_project_service.bootstrap_apis]
}

# 5. tfstate バケット（force_destroy = true で、いつでも destroy できる）
resource "google_storage_bucket" "tfstate" {
  project                     = local.effective_project_id
  name                        = "${local.effective_project_id}-tfstate"
  location                    = local.region
  force_destroy               = true
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  versioning {
    enabled = true
  }

  depends_on = [google_project_service.bootstrap_apis]
}
