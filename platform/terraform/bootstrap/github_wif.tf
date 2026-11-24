# ==============================================================================
# GitHub Actions → Google Cloud の鍵なし認証（Workload Identity Federation）
#   - リポジトリ local.github_repository の Actions のトークンだけを受け付ける
#   - terraform-sa を借用できるのは platform の CI（Terraform・Security Rules の反映）
#   - アプリのデプロイ SA（fga-deployer）の借用設定は ../deployer.tf
#   - SA を借用できるのは、デプロイ用ブランチ（platform/config.json の deploy_ref。既定 refs/heads/main）で動くワークフローだけ
#   - SA キーは発行しない
# ==============================================================================

resource "google_iam_workload_identity_pool" "github" {
  project                   = local.effective_project_id
  workload_identity_pool_id = "github"
  display_name              = "GitHub Actions"
  description               = "GitHub Actions からのデプロイ用（${local.github_repository}）"
  depends_on                = [google_project_service.bootstrap_apis]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = local.effective_project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-actions"
  display_name                       = "GitHub Actions OIDC"
  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
    "attribute.actor"      = "assertion.actor"
    "attribute.workflow"   = "assertion.workflow"
    # リポジトリとブランチを 1 つの属性にまとめる（SA の借用をブランチ単位で絞るため）
    "attribute.repo_ref" = "assertion.repository + ':' + assertion.ref"
  }
  # このリポジトリ以外のトークンは受け付けない
  attribute_condition = "assertion.repository == '${local.github_repository}'"
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "terraform_sa_github" {
  service_account_id = google_service_account.terraform_sa.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repo_ref/${local.github_repository}:${local.deploy_ref}"
}
