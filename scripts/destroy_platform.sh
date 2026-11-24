#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# 破棄
#   ./scripts/destroy_platform.sh                  # テナント・共有 PJ の設定を destroy（全アプリのデータが消える）
#   ./scripts/destroy_platform.sh --delete-project # さらにブートストラップを destroy し、GCP プロジェクトも削除
# Functions と Hosting のリリースは firebase deploy で作られ Terraform の管理外なので、
# プロジェクトを残す場合は firebase functions:delete などで別途削除する（--delete-project ならまとめて消える）。
# ==============================================================================

# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"
require_configured

DELETE_PROJECT="false"
[[ "${1:-}" == "--delete-project" ]] && DELETE_PROJECT="true"

if ! confirm "${PROJECT_ID} の全テナント（全アプリのデータ）を destroy します。続けますか？"; then
  echo "中止しました"
  exit 1
fi

use_gcloud_token_for_terraform

echo "===> [1/2] terraform destroy（共有 PJ の設定・テナント）..."
if [[ -d "$TF_DIR/.terraform" ]]; then
  terraform -chdir="$TF_DIR" destroy
else
  echo "  platform/terraform が init されていないのでスキップ"
fi

if [[ "$DELETE_PROJECT" == "true" ]]; then
  echo "===> [2/2] ブートストラップを destroy し、GCP プロジェクト（${PROJECT_ID}）を削除..."
  terraform -chdir="$TF_DIR/bootstrap" destroy
  echo "✅ ${PROJECT_ID} を削除しました"
else
  echo "✅ テナントと共有 PJ の設定を削除しました（--delete-project で GCP プロジェクトも削除）"
fi
