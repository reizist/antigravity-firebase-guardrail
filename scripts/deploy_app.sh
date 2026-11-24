#!/usr/bin/env bash
# Copyright 2026 Google LLC
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

# ==============================================================================
# アプリのデプロイ（デプロイ SA fga-deployer として実行）
#   ./scripts/deploy_app.sh <app-id>
#
#   1. firebase deploy --only functions:<app>,firestore:indexes（web/dist があれば hosting:<prefix>-<app> も）
#      Security Rules は含めない（反映は platform の Terraform だけ。デプロイ SA には権限もない）
#   2. 自分の関数（Cloud Run サービス <appからハイフンを除いたもの>-*）に、実行 SA app-<app>@ の run.invoker を付ける
#      PJ 単位の IAM Conditions（resource.name で絞る）は関数の呼び出しの判定に効かなかったため、サービス単位で付ける
#      （docs/platform_design.md §9）。スケジュール関数は firebase-tools が付けるが、Firestore トリガーは付けない
#
# 認証:
#   CI（.github/workflows/deploy.yml）: google-github-actions/auth が WIF で fga-deployer の認証情報を用意する
#   ローカル（エンジニア組織だけ。platform/config.json の deployer_impersonators に入っている人）:
#     CLOUDSDK_CONFIG=~/.config/gcloud-fga-deployer gcloud auth application-default login \
#       --impersonate-service-account=fga-deployer@<project>.iam.gserviceaccount.com
# ==============================================================================

APP_ID="${1:?使い方: ./scripts/deploy_app.sh <app-id>}"

# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"
require_configured

APP_DIR="$ROOT_DIR/apps/$APP_ID"
RUNTIME_SA="app-${APP_ID}@${PROJECT_ID}.iam.gserviceaccount.com"
SERVICE_PREFIX="${APP_ID//-/}-"

[[ -d "$APP_DIR" ]] || { echo "ERROR: $APP_DIR がありません" >&2; exit 1; }

# デプロイ SA の認証情報（FGA_DEPLOYER_ADC > CI が用意したもの > ローカルのなりすまし ADC）
if [[ -n "${FGA_DEPLOYER_ADC:-}" ]]; then
  DEPLOYER_CREDENTIALS="$FGA_DEPLOYER_ADC"
elif [[ -n "${GITHUB_ACTIONS:-}" && -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]]; then
  DEPLOYER_CREDENTIALS="$GOOGLE_APPLICATION_CREDENTIALS"
else
  DEPLOYER_CREDENTIALS="$HOME/.config/gcloud-fga-deployer/application_default_credentials.json"
fi
[[ -f "$DEPLOYER_CREDENTIALS" ]] || { echo "ERROR: デプロイ SA の認証情報がありません: $DEPLOYER_CREDENTIALS" >&2; exit 1; }

ONLY="functions:${APP_ID},firestore:indexes"
if [[ -d "$APP_DIR/web/dist" && -n "$(ls -A "$APP_DIR/web/dist" 2>/dev/null)" ]]; then
  ONLY="${ONLY},hosting:${SITE_PREFIX}-${APP_ID}"
fi

echo "===> [1/2] firebase deploy --only ${ONLY}"
(
  cd "$APP_DIR"
  export GOOGLE_APPLICATION_CREDENTIALS="$DEPLOYER_CREDENTIALS"
  unset GOOGLE_OAUTH_ACCESS_TOKEN CLOUDSDK_CONFIG
  pnpm exec firebase deploy --only "$ONLY" --project "$PROJECT_ID" --non-interactive
)

echo "===> [2/2] ${SERVICE_PREFIX}* に ${RUNTIME_SA} の run.invoker を付ける（デプロイ SA の権限で）"
(
  cd "$ROOT_DIR"
  export GOOGLE_APPLICATION_CREDENTIALS="$DEPLOYER_CREDENTIALS"
  unset GOOGLE_OAUTH_ACCESS_TOKEN
  SERVICE_PREFIX="$SERVICE_PREFIX" RUNTIME_SA="$RUNTIME_SA" node --input-type=module -e '
    import { createRequire } from "node:module";
    import { dirname } from "node:path";
    const require = createRequire(import.meta.url);
    // google-auth-library は firebase-tools の依存を使う（依存を増やさない）
    const { GoogleAuth } = require(require.resolve("google-auth-library", { paths: [dirname(require.resolve("firebase-tools/package.json"))] }));
    const { PROJECT_ID, REGION, SERVICE_PREFIX, RUNTIME_SA } = process.env;
    const client = await new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] }).getClient();
    const base = `https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/services`;
    const member = `serviceAccount:${RUNTIME_SA}`;
    const { data } = await client.request({ url: base });
    for (const svc of (data.services ?? []).map((s) => s.name.split("/").pop()).filter((n) => n.startsWith(SERVICE_PREFIX))) {
      const policy = (await client.request({ url: `${base}/${svc}:getIamPolicy` })).data;
      const binding = (policy.bindings ?? []).find((b) => b.role === "roles/run.invoker");
      if (binding?.members?.includes(member)) { console.log(`  = ${svc}`); continue; }
      if (binding) binding.members.push(member);
      else policy.bindings = [...(policy.bindings ?? []), { role: "roles/run.invoker", members: [member] }];
      await client.request({ url: `${base}/${svc}:setIamPolicy`, method: "POST", data: { policy } });
      console.log(`  ✓ ${svc}`);
    }
  '
)
echo "✅ ${APP_ID} をデプロイしました"
