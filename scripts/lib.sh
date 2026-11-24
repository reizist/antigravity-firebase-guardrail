#!/usr/bin/env bash
# Copyright 2026 Google LLC
# SPDX-License-Identifier: Apache-2.0
# ==============================================================================
# scripts/*.sh の共通処理（source して使う）
#   - platform/config.json から環境の値を読む（PROJECT_ID / REGION / SITE_PREFIX ...）
#   - ローカルでは、Terraform に gcloud のアクセストークンを渡す
#     （gcloud auth login だけで動く。ADC の再認証切れで terraform が止まるのを避ける）
# ==============================================================================

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TF_DIR="$ROOT_DIR/platform/terraform"
CONFIG_FILE="$ROOT_DIR/platform/config.json"

cfg() {
  node -e '
    const c = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const v = c[process.argv[2]];
    if (v === undefined) { console.error(`platform/config.json に ${process.argv[2]} がありません`); process.exit(1); }
    console.log(typeof v === "string" ? v : JSON.stringify(v));
  ' "$CONFIG_FILE" "$1"
}

PROJECT_ID="$(cfg project_id)"
REGION="$(cfg region)"
SITE_PREFIX="$(cfg site_prefix)"
INTERNAL_DOMAIN="$(cfg internal_domain)"
GITHUB_REPOSITORY_NAME="$(cfg github_repository)"
TFSTATE_BUCKET="${PROJECT_ID}-tfstate"
export TF_DIR PROJECT_ID REGION SITE_PREFIX INTERNAL_DOMAIN GITHUB_REPOSITORY_NAME TFSTATE_BUCKET

require_configured() {
  if [[ "$PROJECT_ID" == "your-firebase-project-id" || "$INTERNAL_DOMAIN" == "example.com" || "$GITHUB_REPOSITORY_NAME" == "your-org/your-repo" ]]; then
    echo "ERROR: platform/config.json が雛形のままです。project_id・internal_domain・github_repository を書き換えてください" >&2
    exit 1
  fi
}

# Terraform の認証。CI では google-github-actions/auth の認証情報をそのまま使う
use_gcloud_token_for_terraform() {
  if [[ -z "${GITHUB_ACTIONS:-}" && -z "${GOOGLE_OAUTH_ACCESS_TOKEN:-}" ]]; then
    GOOGLE_OAUTH_ACCESS_TOKEN="$(gcloud auth print-access-token)"
    export GOOGLE_OAUTH_ACCESS_TOKEN
  fi
}

confirm() {
  local answer
  read -r -p "$1 [y/N] " answer
  [[ "$answer" == "y" ]]
}
