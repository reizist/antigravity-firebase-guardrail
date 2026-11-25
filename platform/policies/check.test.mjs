// ポリシーチェックのテスト（node --test platform/policies/）
//   実物の apps/news-watcher と台帳を一時ディレクトリに写し、1 か所だけ規約違反に書き換えて確かめる
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkRepo, renderMarkdown, splitTopLevel, stripComments } from "./check.mjs";
import { checkPlan } from "./plan-guard.mjs";

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
  for (const path of ["platform/config.json", "platform/catalog", "platform/rules-templates", "platform/policies/allowed-dependencies.json"]) {
    cpSync(join(ROOT, path), join(dir, path), { recursive: true });
  }
  const edit = (path, fn) => writeFileSync(join(dir, path), fn(readFileSync(join(dir, path), "utf8")));
  const write = (path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  mutate({ dir, edit, write });
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
  hasError(fixture(({ dir }) => cpSync(join(dir, "apps/news-watcher/firebase.json"), join(dir, "apps/rogue-app/firebase.json"))), /apps\/rogue-app: 台帳（/);
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

// ---- 2 レーン（セルフサービスの台帳と、エンジニア組織がレビューする台帳） ----------------

const SELF_SERVICE = "platform/catalog/self-service/link-collection.yaml";
const selfServiceEntry = (overrides = "") => `display_name: リンク集
description: チームのリンクとメモを共有する
tier: 0
department: sales
data_class: internal
handles_pii: false
rules_template: internal-team-collab
owners:
  - user:alice@${CONFIG.internal_domain}
admins:
  - alice@${CONFIG.internal_domain}
expires: "2027-06-30"
${overrides}`;
const selfServiceFirebaseJson = (rules = "firestore.standard.rules") =>
  JSON.stringify({
    hosting: { site: `${CONFIG.site_prefix}-link-collection`, public: "web/dist" },
    firestore: [{ database: "link-collection", location: CONFIG.region, rules, indexes: "firestore.indexes.json" }],
  });
/** 標準の型に収まるアプリ link-collection を足した状態から始める */
const withSelfService = (mutate = () => {}, entry = selfServiceEntry()) =>
  fixture((f) => {
    f.write(SELF_SERVICE, entry);
    f.write("apps/link-collection/firebase.json", selfServiceFirebaseJson());
    f.write("apps/link-collection/firestore.standard.rules", readFileSync(join(ROOT, "platform/rules-templates/internal-team-collab.rules"), "utf8"));
    mutate(f);
  });
const lane = (result, id) => result.lanes.find((l) => l.id === id);

test("news-watcher はエンジニア組織の確認が要る（独自の Rules・シークレット・外部への送信）", () => {
  const result = checkRepo(ROOT, { today: TODAY });
  assert.equal(result.verdict, "ENGINEER_REVIEW_REQUIRED");
  assert.equal(lane(result, "news-watcher").verdict, "ENGINEER_REVIEW_REQUIRED");
  assert.equal(lane(result, "news-watcher").reasons.length, 3);
  assert.match(renderMarkdown(result), /`news-watcher` \| `ENGINEER_REVIEW_REQUIRED`/);
});

test("標準の型に収まるセルフサービスのアプリは AUTO_APPROVE_ELIGIBLE", () => {
  const result = withSelfService();
  assert.deepEqual(result.errors, []);
  assert.equal(lane(result, "link-collection").verdict, "AUTO_APPROVE_ELIGIBLE");
  assert.equal(lane(result, "link-collection").catalog, "self-service");
  // リポジトリ全体では、news-watcher があるので確認が要る
  assert.equal(result.verdict, "ENGINEER_REVIEW_REQUIRED");
});

test("セルフサービスの台帳には、標準の型から外れたアプリを置けない", () => {
  hasError(withSelfService(() => {}, selfServiceEntry("secrets: [slack-webhook]\n")), /self-service\/ ではシークレットを使えません/);
  hasError(withSelfService(() => {}, selfServiceEntry("external_egress: [some-api]\n")), /self-service\/ では外部への送信/);
  hasError(withSelfService(() => {}, selfServiceEntry().replace("tier: 0", "tier: 1")), /self-service\/ に置けるのは tier: 0 だけ/);
  hasError(withSelfService(() => {}, selfServiceEntry().replace("internal-team-collab", "custom")), /self-service\/ では rules_template に標準テンプレート/);
  hasError(withSelfService(() => {}, selfServiceEntry().replace(`user:alice@${CONFIG.internal_domain}`, "user:mallory@attacker.example")), /owners \/ admins は社内ドメイン/);
  // apps.yaml と同じ id は置けない（テナントの乗っ取りを防ぐ）
  hasError(fixture(({ write }) => write("platform/catalog/self-service/news-watcher.yaml", selfServiceEntry())), /news-watcher は platform\/catalog\/apps\.yaml にもあります/);
});

test("セルフサービスのアプリは、独自の Rules・テンプレート以外の Rules・safeFetch を通さない fetch を持てない", () => {
  hasError(withSelfService(({ write }) => write("apps/link-collection/firestore.rules", "rules_version = '2';\n")), /firestore\.rules を置けません/);
  hasError(withSelfService(({ write }) => write("apps/link-collection/firebase.json", selfServiceFirebaseJson("firestore.rules"))), /firestore\.rules は firestore\.standard\.rules/);
  // エミュレータ用の写しは、テンプレートと同じ中身でなければならない（違う型のテンプレート・書き換えたもの）
  hasError(withSelfService(({ edit }) => edit("apps/link-collection/firestore.standard.rules", (s) => s.replace("allow delete: if isInternal();", "allow delete: if true;"))), /標準テンプレート .* と中身が違います/);
  hasError(withSelfService(({ write }) => write("apps/link-collection/firestore.standard.rules", readFileSync(join(ROOT, "platform/rules-templates/internal-author-only.rules"), "utf8"))), /中身が違います/);
  const fn = (code) => (f) => {
    f.write("apps/link-collection/functions/src/index.ts", `const common = { region: "r", serviceAccount: \`app-\${APP_ID}@p.iam.gserviceaccount.com\`, maxInstances: 2, labels: {} };\nexport const linkCollection = {};\n${code}`);
  };
  hasError(withSelfService(fn('await fetch("https://example.org/upload", { method: "POST" });\n')), /safeFetch を通さない fetch\(\) があります.*self-service\/ のアプリではできません/);
  assert.deepEqual(withSelfService(fn('await safeFetch("https://example.org/feed");\n')).errors, []);
});

test("レビューする台帳のアプリの生の fetch は、違反ではなく確認の理由になる", () => {
  const result = fixture(({ write }) => write("apps/news-watcher/functions/src/raw.ts", 'export const ping = () => fetch("https://example.org/");\n'));
  assert.deepEqual(result.errors, []);
  assert.ok(lane(result, "news-watcher").reasons.some((r) => /safeFetch を通さない fetch/.test(r)));
});

test("Tier 0 は個人情報・confidential を扱えない。handles_pii と rules_template は必須", () => {
  const catalog = "platform/catalog/apps.yaml";
  const blocked = fixture(({ edit }) => edit(catalog, (s) => s.replace("handles_pii: false", "handles_pii: true")));
  hasError(blocked, /Tier 0 では confidential のデータや個人情報/);
  assert.equal(blocked.verdict, "BLOCKED");
  assert.equal(lane(blocked, "news-watcher").verdict, "BLOCKED");
  hasError(fixture(({ edit }) => edit(catalog, (s) => s.replace("data_class: internal", "data_class: confidential"))), /Tier 0 では confidential/);
  hasError(fixture(({ edit }) => edit(catalog, (s) => s.replace(/ +handles_pii: false\n/, ""))), /handles_pii（個人情報・顧客データを扱うか）/);
  hasError(fixture(({ edit }) => edit(catalog, (s) => s.replace(/ +rules_template: custom\n/, ""))), /rules_template は/);
});

test("標準の Rules テンプレートも、社内ドメインと isInternal() を確かめる", () => {
  const template = "platform/rules-templates/internal-team-collab.rules";
  hasError(fixture(({ edit }) => edit(template, (s) => s.replace(DOMAIN_PATTERN, "attacker[.]example"))), /internal-team-collab\.rules: isInternal\(\) の社内ドメイン/);
  hasError(fixture(({ edit }) => edit(template, (s) => s.replace("allow delete: if isInternal();", "allow delete: if true;"))), /internal-team-collab\.rules: allow delete: if true/);
});

test("plan-guard: 承認なしで反映できるのは、セルフサービスのアプリのテナントの作成・変更だけ", () => {
  const rc = (address, actions, type = "x") => ({ address, type, change: { actions } });
  const tenant = (id, name) => `module.tenant["${id}"].${name}`;
  const ok = checkPlan(
    {
      resource_changes: [
        rc(tenant("link-collection", "google_firestore_database.app"), ["create"], "google_firestore_database"),
        rc(tenant("link-collection", "google_firebaserules_ruleset.firestore"), ["create", "delete"]),
        rc('google_billing_budget.app["link-collection"]', ["create"]),
        rc(tenant("news-watcher", "google_firestore_database.app"), ["no-op"]),
      ],
    },
    ["link-collection"],
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.changes.length, 3);

  // アプリを足すと必ず変わる共通のリソース：台帳の検証と、Auth の許可ドメイン（そのアプリのサイトが増えるだけなら認める）
  const auth = (before, after, extra = {}) => ({
    address: "google_identity_platform_config.this",
    type: "google_identity_platform_config",
    change: { actions: ["update"], before: { autodelete_anonymous_users: false, authorized_domains: before }, after: { autodelete_anonymous_users: false, authorized_domains: after, ...extra } },
  });
  const guard = (changes) => checkPlan({ resource_changes: changes }, ["link-collection"], { sitePrefix: "fga" });
  const domains = ["localhost", "fga-news-watcher.web.app"];
  assert.equal(guard([rc("terraform_data.catalog_check", ["update"]), auth(domains, [...domains, "fga-link-collection.web.app", "fga-link-collection.firebaseapp.com"])]).ok, true);
  assert.equal(guard([auth(domains, [...domains, "attacker.example"])]).ok, false);
  assert.equal(guard([auth(domains, ["localhost", "fga-link-collection.web.app"])]).ok, false);
  assert.equal(guard([auth(domains, [...domains, "fga-link-collection.web.app"], { autodelete_anonymous_users: true })]).ok, false);
  assert.equal(guard([rc("terraform_data.catalog_check", ["delete", "create"])]).ok, false);

  const bad = (changes) => checkPlan({ resource_changes: changes }, ["link-collection"]);
  // レビューする台帳のアプリ・基盤そのものの変更が混ざっている
  assert.equal(bad([rc(tenant("news-watcher", "google_firebaserules_ruleset.firestore"), ["create", "delete"])]).ok, false);
  assert.equal(bad([rc("google_project_iam_member.deployer", ["create"])]).ok, false);
  // 削除・データベースの作り直し
  assert.equal(bad([rc(tenant("link-collection", "google_firestore_field.ttl[\"requests\"]"), ["delete"])]).ok, false);
  assert.equal(bad([rc(tenant("link-collection", "google_firestore_database.app"), ["delete", "create"], "google_firestore_database")]).ok, false);
  // 台帳から消したアプリ（self-service/ にもうない）
  assert.equal(bad([rc(tenant("gone-app", "google_firestore_database.app"), ["delete"], "google_firestore_database")]).ok, false);
});
