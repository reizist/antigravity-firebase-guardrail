#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# 共有プロジェクトとテナントの反映（エンジニア組織が実行。Terraform SA を借用する）
#   1. サービスエージェントを先に作る（初回デプロイで「Service agent does not exist」になるのを防ぐ）
#   2. terraform plan → 確認 → apply（API・Firebase・Auth・デプロイ SA・npm リモート・テナント・Security Rules）
# 使い方:
#   ./scripts/deploy_platform.sh            # plan を表示して、確認してから apply
#   ./scripts/deploy_platform.sh --plan     # plan だけ
# 2 回目以降は GitHub Actions（.github/workflows/deploy.yml）が同じ内容を実行する。
# ==============================================================================

# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"
require_configured

PLAN_ONLY="false"
[[ "${1:-}" == "--plan" ]] && PLAN_ONLY="true"

use_gcloud_token_for_terraform

echo "===> [1/3] terraform init（tfstate: gs://${TFSTATE_BUCKET}）..."
terraform -chdir="$TF_DIR" init -input=false -backend-config="bucket=${TFSTATE_BUCKET}"

if [[ "$PLAN_ONLY" == "false" ]]; then
  echo "===> [2/3] API を有効化し、サービスエージェントを作成..."
  terraform -chdir="$TF_DIR" apply -target=google_project_service.apis
  TOKEN="$(gcloud auth print-access-token)"
  # gcloud beta services identity create はコンポーネント導入の確認で止まることがあるので REST で呼ぶ
  for svc in firebaserules.googleapis.com eventarc.googleapis.com pubsub.googleapis.com \
             cloudfunctions.googleapis.com run.googleapis.com cloudscheduler.googleapis.com \
             firestore.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com; do
    curl -sS -X POST -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" -d '{}' \
      "https://serviceusage.googleapis.com/v1beta1/projects/${PROJECT_ID}/services/${svc}:generateServiceIdentity" >/dev/null || true
  done
fi

echo "===> [3/3] terraform plan / apply..."
terraform -chdir="$TF_DIR" plan -input=false -out=platform.tfplan
if [[ "$PLAN_ONLY" == "true" ]]; then
  rm -f "$TF_DIR/platform.tfplan"
  exit 0
fi
if ! confirm "この plan を apply しますか？"; then
  rm -f "$TF_DIR/platform.tfplan"
  echo "中止しました"
  exit 1
fi
terraform -chdir="$TF_DIR" apply -input=false platform.tfplan
rm -f "$TF_DIR/platform.tfplan"

echo "=============================================================================="
echo "✅ 反映完了。テナントの情報:"
terraform -chdir="$TF_DIR" output -json tenants
echo "=============================================================================="
