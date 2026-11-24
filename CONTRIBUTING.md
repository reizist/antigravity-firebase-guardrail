# Contributing

関心を持っていただきありがとうございます。これは始まったばかりの、MIT ライセンスのコミュニティプロジェクトです。Issue・PR・⭐ のどれも、進む方向を決める助けになります。

## 特に歓迎するもの

- **別の環境での検証結果** — 公開にあたって一般化した部分（`platform/config.json`・WIF のブランチ制限・`deploy.yml`）は、まだ新しいプロジェクトに適用して確かめていません（[README の Verification status](README.md#-verification-status)）。試した結果（うまくいった・止まった）をぜひ教えてください
- **ポリシーチェックのすり抜け** — [`platform/policies/check.mjs`](platform/policies/check.mjs) は正規表現による簡易検査です。規約違反なのに通る書き方を見つけたら、再現する最小の例を添えてください
- **最小権限の `firebase deploy` の新しいつまずき** — `firebase-tools` の版が上がると前提が変わります（[docs/platform_design.md §9](docs/platform_design.md)）
- **2 本目・3 本目の見本アプリ** — Tier 0 の規約（HTTP 関数なし）の中で作れるもの
- **未実装のもの** — Rules のユニットテスト（エミュレータ）、Tier 1 の Storage バケット、App Check

## 開発環境

Node.js 24（`.nvmrc`）・pnpm（`corepack enable pnpm`）・Terraform 1.5 以上。Google Cloud の認証情報は要りません。

```bash
git clone https://github.com/reizist/antigravity-firebase-guardrail
cd antigravity-firebase-guardrail
corepack enable pnpm
pnpm install --frozen-lockfile
```

## PR を出す前に

```bash
pnpm policy && pnpm policy:test      # ポリシーチェックと、そのテスト
pnpm typecheck && pnpm test          # news-watcher の単体テスト
pnpm build
shellcheck --severity=warning scripts/*.sh
terraform fmt -check -recursive platform/terraform   # Terraform を変えたとき
```

- **CI が同じものを実行します**（[`.github/workflows/ci.yml`](.github/workflows/ci.yml)）。OSV-Scanner もロックファイルを確認します
- **Skill を正直に保つ。** [`.agents/skills/`](.agents/skills/) と [`AGENT.md`](AGENT.md) は AI が読む規約です。動きを変えたら、合わせて直してください。コードにない機能を書かないでください
- **検証の範囲を正直に書く。** 実機で確かめていない変更は、そう書いてください。README の「Verification status」も合わせて更新します
- **依存を増やさない。** 追加するときは、理由を PR に書き、[`platform/policies/allowed-dependencies.json`](platform/policies/allowed-dependencies.json) も変更します。`pnpm-workspace.yaml` の保護設定（`minimumReleaseAge` など）は緩めません
- **秘密情報・環境固有の値を入れない。** 実在のプロジェクト ID・メールアドレス・Webhook URL・`*.tfvars`・state。`platform/config.json` は雛形の値のままにします
- [`CHANGELOG.md`](CHANGELOG.md) に 1 行足してください

## 決まりごと

- 小さく、目的が 1 つの PR。**何を変えたか・なぜか** を書き、Issue があればリンクする
- 周りの書き方に合わせる（スクリプトは bash・`set -euo pipefail`・変数は引用符で囲む。ドキュメントとコメントは日本語）
- GitHub Actions は commit SHA で固定し、`# vN` のコメントを付ける（Dependabot が更新します）
- ポリシーチェックに検査を足したら、[`check.test.mjs`](platform/policies/check.test.mjs) にテストも足す

## バグ・アイデアの報告

Issue に、実行したもの（コマンド、`node -v`・`pnpm -v`・`terraform version`・`firebase-tools` の版、OS）と、期待した結果・実際の結果を書いてください。まとまっていないアイデアも歓迎します。

貢献いただいた内容は、このプロジェクトの [MIT License](LICENSE) で提供されることに同意したものとします。
