// ポリシーチェックのテスト（node --test platform/policies/）
//   実物の apps/news-watcher と台帳を一時ディレクトリに写し、1 か所だけ規約違反に書き換えて確かめる
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkRepo, splitTopLevel, stripComments } from "./check.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TODAY = "2026-12-01";
// テンプレートからコピーして platform/config.json を書き換えたリポジトリでも通るよう、値は設定から読む
const CONFIG = JSON.parse(readFileSync(join(ROOT, "platform/config.json"), "utf8"));
const SITE = `${CONFIG.site_prefix}-news-watcher`;
const DOMAIN_PATTERN = CONFIG.internal_domain.replaceAll(".", "[.]");

function fixture(mutate = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), "fga-policy-"));
  const skip = (src) => !/node_modules|\/dist$|\/lib$|\.terraform/.test(src);
  cpSync(join(ROOT, "apps"), join(dir, "apps"), { recursive: true, filter: skip });
  for (const path of ["platform/config.json", "platform/catalog/apps.yaml", "platform/policies/allowed-dependencies.json"]) {
    cpSync(join(ROOT, path), join(dir, path), { recursive: true });
  }
  const edit = (path, fn) => writeFileSync(join(dir, path), fn(readFileSync(join(dir, path), "utf8")));
  mutate({ dir, edit, write: (path, text) => writeFileSync(join(dir, path), text) });
  return checkRepo(dir, { today: TODAY });
}

const hasError = (result, pattern) => assert.ok(result.errors.some((e) => pattern.test(e)), `期待した違反がありません: ${pattern}\n${result.errors.join("\n")}`);

test("実物のリポジトリは違反なし", () => {
  assert.deepEqual(checkRepo(ROOT, { today: TODAY }).errors, []);
});

test("HTTP 関数（onRequest / onCall）は Tier 0 で禁止", () => {
  const result = fixture(({ write }) =>
    write("apps/news-watcher/functions/src/api.ts", 'import { onRequest } from "firebase-functions/v2/https";\nexport const api = onRequest((req, res) => { res.send("ok"); });\n'),
  );
  hasError(result, /api\.ts: Tier 0 では HTTP 関数/);
});

test("コメントに書いた onRequest は違反にしない", () => {
  assert.equal(stripComments("// onRequest は作らない\nconst u = 'https://example.com'; /* onCall */").includes("onRequest"), false);
  assert.ok(stripComments("const u = 'https://example.com';").includes("https://example.com"));
});

test("有効期限（expires）が過ぎた・形式が違うアプリは通さない", () => {
  hasError(fixture(({ edit }) => edit("platform/catalog/apps.yaml", (s) => s.replace(/expires: .*/, 'expires: "2026-01-31"'))), /有効期限（2026-01-31）を過ぎています/);
  hasError(fixture(({ edit }) => edit("platform/catalog/apps.yaml", (s) => s.replace(/expires: .*/, 'expires: "来年度末"'))), /expires（有効期限）を YYYY-MM-DD/);
  hasError(fixture(({ edit }) => edit("platform/catalog/apps.yaml", (s) => s.replace(/ +expires: .*\n/, ""))), /expires（有効期限）を YYYY-MM-DD/);
});

test("台帳にないアプリのディレクトリは通さない", () => {
  hasError(fixture(({ dir }) => cpSync(join(dir, "apps/news-watcher/firebase.json"), join(dir, "apps/rogue-app/firebase.json"))), /apps\/rogue-app: 台帳/);
});

test("firebase.json は自分のサイト・DB・codebase だけを参照する", () => {
  const result = fixture(({ edit }) =>
    edit("apps/news-watcher/firebase.json", (s) => s.replace(`"site": "${SITE}"`, `"site": "${CONFIG.site_prefix}-other-app"`).replace('"database": "news-watcher"', '"database": "(default)"').replace('"codebase": "news-watcher"', '"codebase": "default"')),
  );
  hasError(result, new RegExp(`hosting\\.site は自分のサイト ${SITE}`));
  hasError(result, /firestore\.database は自分の DB news-watcher/);
  hasError(result, /functions\.codebase は news-watcher/);
});

test("Security Rules の全開放・isInternal() を通らない allow は通さない", () => {
  const rules = "apps/news-watcher/firestore.rules";
  hasError(fixture(({ edit }) => edit(rules, (s) => s.replace("allow read, write: if false;", "allow read, write: if true;"))), /全開放は書けません/);
  hasError(fixture(({ edit }) => edit(rules, (s) => s.replace("match /articles/{articleId} {\n      allow read: if isInternal();", "match /articles/{articleId} {\n      allow read: if request.auth != null;"))), /allow read の条件は isInternal\(\)/);
  hasError(fixture(({ edit }) => edit(rules, (s) => s.replace("allow delete: if isEditor();", "allow delete: if isEditor() || request.auth != null;"))), /allow delete の条件は isInternal\(\)/);
  hasError(fixture(({ edit }) => edit(rules, (s) => s.replace(DOMAIN_PATTERN, "attacker[.]example"))), /社内ドメインが platform\/config\.json の internal_domain/);
});

test("関数の dependencies はバンドルしない 2 つだけ・許可リストにない依存は通さない", () => {
  const pkg = "apps/news-watcher/functions/package.json";
  hasError(fixture(({ edit }) => edit(pkg, (s) => s.replace('"firebase-admin":', '"left-pad": "1.3.0",\n    "firebase-admin":'))), /left-pad は devDependencies に移し/);
  hasError(fixture(({ edit }) => edit(pkg, (s) => s.replace('"esbuild":', '"left-pad": "1.3.0",\n    "esbuild":'))), /left-pad は許可リスト/);
  hasError(fixture(({ edit }) => edit(pkg, (s) => s.replace(/"firebase-admin": "(\d)/, '"firebase-admin": "^$1'))), /firebase-admin の版は固定/);
});

test("秘密情報らしい文字列・npm のロックファイルは通さない", () => {
  // テスト用に組み立てた偽の Webhook URL（実在しない）
  const fake = ["https://hooks.slack.com", "services", "T".padEnd(9, "0"), "B".padEnd(9, "0"), "x".repeat(24)].join("/");
  hasError(fixture(({ write }) => write("apps/news-watcher/web/src/leak.ts", `export const hook = "${fake}";\n`)), /Slack の Webhook URL/);
  hasError(fixture(({ write }) => write("apps/news-watcher/functions/package-lock.json", "{}")), /pnpm だけ/);
});

test("splitTopLevel はかっこと文字列の中の演算子で分けない", () => {
  assert.deepEqual(splitTopLevel("a() && (b || c) && d.matches('x&&y')", "&&"), ["a()", "(b || c)", "d.matches('x&&y')"]);
});
