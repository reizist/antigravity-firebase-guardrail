# ==============================================================================
# 環境ごとの値は platform/config.json の 1 か所で決める
#   Terraform・scripts/・CI・アプリのビルド（functions/src/config.ts など）が同じファイルを読む。
#   ここに書かない値（OAuth クライアント・予算）は terraform.tfvars（Git 管理外）か CI のシークレットで渡す。
# ==============================================================================

locals {
  platform_config = jsondecode(file("${path.module}/../config.json"))

  project_id             = local.platform_config.project_id
  region                 = local.platform_config.region
  internal_domain        = local.platform_config.internal_domain
  site_prefix            = local.platform_config.site_prefix
  github_repository      = local.platform_config.github_repository
  deploy_ref             = try(local.platform_config.deploy_ref, "refs/heads/main")
  deployer_impersonators = try(local.platform_config.deployer_impersonators, [])

  # bootstrap が作るもの（名前が決まっているので、出力を写さなくてよい）
  terraform_sa_email   = "${var.terraform_sa_id}@${local.project_id}.iam.gserviceaccount.com"
  github_wif_pool_name = "projects/${data.google_project.this.number}/locations/global/workloadIdentityPools/github"

  # Firebase Auth のログイン処理（/__/auth/handler）を動かすドメイン＝ PJ の既定の Hosting サイト
  #   既定は <project_id>.firebaseapp.com。プロジェクト ID に firebase などの予約語を含むと既定サイトの ID が変わる
  #   （例: firebase-xxx → fir-xxx）ので、そのときは config.json の auth_handler_domain に
  #   /__/firebase/init.json の authDomain を書く
  auth_handler_domain = try(local.platform_config.auth_handler_domain, "") != "" ? local.platform_config.auth_handler_domain : "${local.project_id}.firebaseapp.com"
}
