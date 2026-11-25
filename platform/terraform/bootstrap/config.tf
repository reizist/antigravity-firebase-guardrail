# プロジェクト ID・リージョン・GitHub リポジトリは platform/config.json で決める（../config.tf と同じファイル）
locals {
  platform_config   = jsondecode(file("${path.module}/../../config.json"))
  project_id        = local.platform_config.project_id
  region            = local.platform_config.region
  github_repository = local.platform_config.github_repository
  deploy_ref        = try(local.platform_config.deploy_ref, "refs/heads/main")
  enable_budgets    = try(local.platform_config.enable_budgets, true)
}
