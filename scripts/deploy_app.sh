#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# アプリのデプロイ（デプロイ SA fga-deployer として実行）
#   ./scripts/deploy_app.sh <app-id>
#   FGA_FIREBASE_DEBUG=1 ./scripts/deploy_app.sh <app-id>   # firebase deploy に --debug を付ける（失敗の原因を調べるとき）
#
#   1. firebase deploy --only functions:<app>,firestore:indexes（web/dist があれば hosting:<prefix>-<app> も）
#      Security Rules は含めない（反映は platform の Terraform だけ。デプロイ SA には権限もない）
#   2. 自分の関数（Cloud Run サービス <appからハイフンを除いたもの>-*）に、実行 SA app-<app>@ の run.invoker を付ける
#      PJ 単位の IAM Conditions（resource.name で絞る）は関数の呼び出しの判定に効かなかったため、サービス単位で付ける
#      （docs/platform_design.md §9）。スケジュール関数は firebase-tools が付けるが、Firestore トリガーは付けない
#   3. Hosting をデプロイしたら、Google ログインの処理が動くドメイン（/__/firebase/init.json の authDomain）が
#      API キーのリファラ制限に入っているかを確かめる（入っていなければ直し方を表示する。docs/runbook.md §8）
#
# 認証:
#   CI（.github/workflows/deploy.yml）: google-github-actions/auth が WIF で fga-deployer の認証情報を用意する
#   ローカル（エンジニア組織だけ。platform/config.json の deployer_impersonators に入っている人）:
#     CLOUDSDK_CONFIG=~/.config/gcloud-fga-deployer gcloud auth application-default login \
#       --impersonate-service-account=fga-deployer@<project>.iam.gserviceaccount.com
#     この端末に `firebase login` が残っていても使わない（下の XDG_CONFIG_HOME）
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

echo "===> [1/3] firebase deploy --only ${ONLY}"
(
  cd "$APP_DIR"
  export GOOGLE_APPLICATION_CREDENTIALS="$DEPLOYER_CREDENTIALS"
  unset GOOGLE_OAUTH_ACCESS_TOKEN CLOUDSDK_CONFIG FIREBASE_TOKEN
  if [[ -z "${GITHUB_ACTIONS:-}" ]]; then
    # firebase-tools は、この端末に残っている `firebase login`（個人のアカウント）を ADC より優先して使う。
    # そのアカウントに権限がないと「iam.serviceAccounts.ActAs がない」という紛らわしいエラーで止まり、
    # 権限があると、デプロイ SA ではなく個人の権限でデプロイしてしまう。
    # 設定の置き場所を空の一時ディレクトリに切り替えて、デプロイ SA だけが使われるようにする（個人のログインは消さない）
    FIREBASE_CONFIG_HOME="$(mktemp -d)"
    trap 'rm -rf "$FIREBASE_CONFIG_HOME"' EXIT
    export XDG_CONFIG_HOME="$FIREBASE_CONFIG_HOME"
  fi
  pnpm exec firebase deploy --only "$ONLY" --project "$PROJECT_ID" --non-interactive ${FGA_FIREBASE_DEBUG:+--debug}
)

echo "===> [2/3] ${SERVICE_PREFIX}* に ${RUNTIME_SA} の run.invoker を付ける（デプロイ SA の権限で）"
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

# Google ログインの処理は、PJ の既定の Hosting サイトのドメイン（init.json の authDomain）で動く。
# プロジェクト ID に予約語（firebase など）を含むと <project_id>.firebaseapp.com とは別のドメインになり、
# API キーのリファラ制限に入っていないと、ログインが「The requested action is invalid.」で失敗する
if [[ "$ONLY" == *hosting:* ]]; then
  echo "===> [3/3] ログイン処理のドメイン（authDomain）を確認"
  EXPECTED_AUTH_DOMAIN="$(node -e '
    const c = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    console.log(c.auth_handler_domain || `${c.project_id}.firebaseapp.com`);
  ' "$CONFIG_FILE")"
  ACTUAL_AUTH_DOMAIN="$(curl -fsS --retry 3 --max-time 20 "https://${SITE_PREFIX}-${APP_ID}.web.app/__/firebase/init.json" 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => { try { console.log(JSON.parse(s).authDomain ?? ""); } catch { console.log(""); } });
  ' || true)"
  if [[ -z "$ACTUAL_AUTH_DOMAIN" ]]; then
    echo "  ? init.json を読めませんでした（確認を省略）"
  elif [[ "$ACTUAL_AUTH_DOMAIN" == "$EXPECTED_AUTH_DOMAIN" ]]; then
    echo "  = ${ACTUAL_AUTH_DOMAIN}"
  else
    echo "  ⚠ ログイン処理のドメインは ${ACTUAL_AUTH_DOMAIN} ですが、API キーが許可しているのは ${EXPECTED_AUTH_DOMAIN} です。" >&2
    echo "    このままだと Google ログインが「The requested action is invalid.」で失敗します。" >&2
    echo "    platform/config.json に \"auth_handler_domain\": \"${ACTUAL_AUTH_DOMAIN}\" を足し、./scripts/deploy_platform.sh で反映してください（docs/runbook.md §8）" >&2
  fi
fi
echo "✅ ${APP_ID} をデプロイしました"
