#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# 共有プロジェクトのブートストラップ（最初に 1 回だけ。プロジェクトの作成と課金の紐付けができる人が実行）
#   1. 組織・課金アカウントを調べる
#   2. platform/terraform/bootstrap/terraform.tfvars を書く（Git 管理外）
#   3. terraform apply（PJ・Terraform SA・tfstate バケット・GitHub Actions 用の WIF）
#
# 環境変数（任意）:
#   FGA_ORG_ID            作成先の組織 ID（省略時は gcloud organizations list の先頭）
#   FGA_FOLDER_ID         作成先のフォルダ ID（指定すると組織の直下ではなくフォルダに作る）
#   FGA_BILLING_ACCOUNT   課金アカウント ID（省略時は、開いている課金アカウントの先頭）
#   FGA_OPERATORS         Terraform SA を借用できるメンバー（カンマ区切り。省略時は実行した本人）
#                         例: group:platform-engineers@example.com,user:alice@example.com
#   FGA_PROJECT_NAME      プロジェクトの表示名
# ==============================================================================

# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"
require_configured

PROJECT_NAME="${FGA_PROJECT_NAME:-Firebase Governance Apps}"

echo "===> [Bootstrap 1/3] 組織と課金アカウントを確認..."
ACTIVE_ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)')"
[[ -n "$ACTIVE_ACCOUNT" ]] || { echo "ERROR: gcloud にログインしていません（gcloud auth login）" >&2; exit 1; }
ORG_ID="${FGA_ORG_ID:-$(gcloud organizations list --format='value(ID)' 2>/dev/null | head -n 1)}"
FOLDER_ID="${FGA_FOLDER_ID:-}"
BILLING_ACCOUNT="${FGA_BILLING_ACCOUNT:-$(gcloud billing accounts list --filter='open=true' --format='value(ACCOUNT_ID)' 2>/dev/null | head -n 1)}"

OPERATORS_JSON="$(FGA_OPERATORS="${FGA_OPERATORS:-user:${ACTIVE_ACCOUNT}}" node -e '
  console.log(JSON.stringify(process.env.FGA_OPERATORS.split(",").map((s) => s.trim()).filter(Boolean)));
')"

echo "  Account             : $ACTIVE_ACCOUNT"
echo "  Shared project      : $PROJECT_ID ($PROJECT_NAME)"
echo "  Organization ID     : ${ORG_ID:-<none>}"
echo "  Folder ID           : ${FOLDER_ID:-<none>}"
echo "  Billing account     : ${BILLING_ACCOUNT:-<none>}"
echo "  Terraform operators : $OPERATORS_JSON"
echo "  GitHub repository   : $GITHUB_REPOSITORY_NAME"

BOOTSTRAP_STATE="$TF_DIR/bootstrap/terraform.tfstate"
if [[ -f "$BOOTSTRAP_STATE" && -f "$TF_DIR/bootstrap/terraform.tfvars" ]] && grep -q '"type": "google_project"' "$BOOTSTRAP_STATE"; then
  # 2 回目以降（途中で失敗した後の再実行など）。この PJ は bootstrap の Terraform が作って管理しているので、
  # tfvars を書き換えない。create_project = false にすると google_project.shared の削除（PJ ごと）を計画してしまう
  echo "  Note: bootstrap の state が PJ を管理しているので、既存の terraform.tfvars をそのまま使います"
  WRITE_TFVARS="false"
elif gcloud projects describe "$PROJECT_ID" >/dev/null 2>&1; then
  echo "  Note: $PROJECT_ID は既にあるので create_project = false にします（Terraform の管理外の既存 PJ を使う）"
  CREATE_PROJECT="false"
  WRITE_TFVARS="true"
else
  CREATE_PROJECT="true"
  WRITE_TFVARS="true"
fi

echo "===> [Bootstrap 2/3] platform/terraform/bootstrap/terraform.tfvars を書き込み..."
if [[ "$WRITE_TFVARS" == "true" ]]; then
  cat > "$TF_DIR/bootstrap/terraform.tfvars" <<TFVARS
project_name        = "${PROJECT_NAME}"
create_project      = ${CREATE_PROJECT}
org_id              = "${ORG_ID}"
folder_id           = "${FOLDER_ID}"
billing_account     = "${BILLING_ACCOUNT}"
terraform_operators = ${OPERATORS_JSON}
TFVARS
fi

echo "===> [Bootstrap 3/3] terraform apply（PJ・Terraform SA・tfstate・WIF）..."
use_gcloud_token_for_terraform
terraform -chdir="$TF_DIR/bootstrap" init -input=false
# plan を表示し、terraform 自身が確認を求める（yes と入力するまで何も作らない）
terraform -chdir="$TF_DIR/bootstrap" apply

WIF_PROVIDER="$(terraform -chdir="$TF_DIR/bootstrap" output -raw github_wif_provider)"

echo "=============================================================================="
echo "✅ Bootstrap 完了: ${PROJECT_ID}"
echo "   1. Terraform SA の借用権限が効くまで 1〜2 分待ってから実行:"
echo "        ./scripts/deploy_platform.sh"
echo "   2. GitHub Actions からデプロイするなら、リポジトリの変数（Settings → Variables）に登録:"
echo "        GCP_WIF_PROVIDER = ${WIF_PROVIDER}"
echo "=============================================================================="
