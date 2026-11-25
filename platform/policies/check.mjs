// ==============================================================================
// CI のポリシーチェック（docs/platform_design.md §5）
//   node platform/policies/check.mjs                       # リポジトリ全体を確認（pnpm policy）
//   node platform/policies/check.mjs --app <id>            # 判定の表示を 1 アプリに絞る
//   node platform/policies/check.mjs --json                # 結果を JSON で出す
//   node platform/policies/check.mjs --markdown-out <file> # PR に貼る報告（データの取り扱いの注意と判定）を書き出す
//
// AI への指示（Skill）だけでは出力のブレをなくせないので、規約から外れた変更を PR の時点で止める。
// ここで確認するのは「台帳」「担当範囲（firebase.json）」「関数（HTTP 関数の禁止など）」「Security Rules」
// 「依存」「秘密情報」。文字列と正規表現による簡易チェックで、構文解析はしていない（すり抜けは
// IAM と Security Rules のレビューで止める前提）。
//
// アプリごとに、どちらのレーンかも判定する（docs/platform_design.md §3.4）:
//   AUTO_APPROVE_ELIGIBLE    : platform/catalog/self-service/<id>.yaml にある、標準の型のアプリ。
//                              エンジニア組織の承認なしで、データベースの払い出しまで自動で反映する
//   ENGINEER_REVIEW_REQUIRED : platform/catalog/apps.yaml にあるアプリ（CODEOWNERS のレビューと、反映前の承認）
//   BLOCKED                  : 規約違反がある（直すまでマージできない）
// ==============================================================================

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const APP_ID_PATTERN = /^[a-z][a-z0-9-]{2,18}[a-z0-9]$/;
const DATA_CLASSES = ["public", "internal", "confidential"];
const STANDARD_RULES_TEMPLATES = ["internal-team-collab", "internal-author-only"];
const RULES_TEMPLATES = [...STANDARD_RULES_TEMPLATES, "custom"];
const MAX_APPS = 30; // Hosting 36 サイト・Firestore 100 DB の上限の手前で止める（Terraform の max_apps_per_project と同じ値）
const TEMPLATES_DIR = "platform/rules-templates";
const SELF_SERVICE_DIR = "platform/catalog/self-service";
// 標準テンプレートのアプリが、エミュレータ用に置くテンプレートの写し（firebase-tools はアプリのディレクトリの外の Rules を読めない）
const TEMPLATE_COPY = "firestore.standard.rules";
const BUNDLE_EXTERNAL = ["firebase-admin", "firebase-functions"];
const PLACEHOLDERS = { project_id: "your-firebase-project-id", internal_domain: "example.com", github_repository: "your-org/your-repo" };
const SKIP_DIRS = new Set(["node_modules", "dist", "lib", ".firebase", "coverage", "emulator-data"]);
const SECRET_PATTERNS = [
  [/hooks\.slack\.com\/services\/[A-Z0-9]{8,}\/[A-Z0-9]{8,}\/[A-Za-z0-9]{16,}/, "Slack の Webhook URL"],
  [/chat\.googleapis\.com\/v1\/spaces\/[^\s"']+[?&]key=[A-Za-z0-9_-]{20,}/, "Google Chat の Webhook URL"],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "秘密鍵"],
  [/AIza[0-9A-Za-z_-]{35}/, "API キー"],
  [/"private_key_id"\s*:/, "サービスアカウントの鍵"],
];

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const camel = (id) => id.split("-").map((p, i) => (i === 0 ? p : p[0].toUpperCase() + p.slice(1))).join("");
const asArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** // と /* *\/ のコメントを除く（"https://..." の // は残す） */
export function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    if (SKIP_DIRS.has(name)) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

/** 式を、かっこ・文字列の外にある演算子（&& か ||）で分ける */
export function splitTopLevel(expr, operator) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    else if (depth === 0 && expr.startsWith(operator, i)) {
      parts.push(expr.slice(start, i).trim());
      start = i + operator.length;
      i += operator.length - 1;
    }
  }
  parts.push(expr.slice(start).trim());
  return parts;
}

/** 条件が「必ず guards のどれかを通る」形か（最上位が && だけで、その 1 つが guard() の呼び出し） */
function requiresGuard(expr, guards) {
  if (splitTopLevel(expr, "||").length > 1) return false;
  return splitTopLevel(expr, "&&").some((part) => {
    const m = /^(\w+)\(\)$/.exec(part);
    return m !== null && guards.has(m[1]);
  });
}

// ---- 台帳 ---------------------------------------------------------------------

/** 台帳を読む。apps.yaml（レビューあり）と self-service/<id>.yaml（標準の型だけ・レビューなし）の 2 か所 */
function loadCatalog(root, report) {
  const apps = {};
  const reviewed = parseYaml(readFileSync(join(root, "platform", "catalog", "apps.yaml"), "utf8"))?.apps ?? {};
  for (const [id, app] of Object.entries(reviewed)) apps[id] = { app: app ?? {}, selfService: false, at: `platform/catalog/apps.yaml: ${id}` };

  const dir = join(root, SELF_SERVICE_DIR);
  for (const name of existsSync(dir) ? readdirSync(dir).sort() : []) {
    const at = `${SELF_SERVICE_DIR}/${name}`;
    if (/\.yml$/.test(name)) report.error(`${at}: 拡張子は .yaml にしてください（.yml は基盤が読みません）`);
    if (!name.endsWith(".yaml")) continue;
    const id = basename(name, ".yaml");
    const app = parseYaml(readFileSync(join(dir, name), "utf8"));
    if (app === null || typeof app !== "object" || Array.isArray(app)) {
      report.error(`${at}: アプリ 1 件分の項目（display_name など）を書いてください`);
    } else if (apps[id] !== undefined) {
      report.error(`${at}: ${id} は platform/catalog/apps.yaml にもあります（どちらか一方にしてください）`);
    } else {
      apps[id] = { app, selfService: true, at };
    }
  }
  return apps;
}

function checkCatalog(entries, config, today, report) {
  const prefixes = new Map();
  if (Object.keys(entries).length > MAX_APPS) {
    report.error(`台帳: 共有プロジェクトに置けるアプリは ${MAX_APPS} 件までです（現在 ${Object.keys(entries).length} 件）。専用プロジェクトへの切り出しを検討してください`);
  }
  for (const [id, { app, selfService, at }] of Object.entries(entries)) {
    if (!APP_ID_PATTERN.test(id)) report.error(`${at}: app id は英小文字で始まり英小文字か数字で終わる、英小文字・数字・ハイフンの 4〜20 文字にしてください`);
    const prefix = id.replaceAll("-", "");
    if (prefixes.has(prefix)) report.error(`${at}: ハイフンを除くと ${prefixes.get(prefix)} と同じになります（関数のサービス名が重なる）`);
    prefixes.set(prefix, id);

    if (![0, 1].includes(app?.tier)) report.error(`${at}: tier は 0 か 1 にしてください（Tier 2 は専用プロジェクトに切り出す）`);
    if (!DATA_CLASSES.includes(app?.data_class)) report.error(`${at}: data_class は ${DATA_CLASSES.join(" / ")} のどれかにしてください`);
    if (typeof app?.handles_pii !== "boolean") report.error(`${at}: handles_pii（個人情報・顧客データを扱うか）を true か false で書いてください`);
    if (app?.tier === 0 && (app?.data_class === "confidential" || app?.handles_pii === true)) {
      report.error(`${at}: Tier 0 では confidential のデータや個人情報（handles_pii: true）を扱えません。Tier 1 / 2 としてエンジニア組織に相談してください`);
    }
    if (!RULES_TEMPLATES.includes(app?.rules_template)) report.error(`${at}: rules_template は ${RULES_TEMPLATES.join(" / ")} のどれかにしてください`);
    for (const egress of asArray(app?.external_egress ?? [])) {
      if (!/^[a-z][a-z0-9-]*$/.test(String(egress))) report.error(`${at}: external_egress（外部への送信先）の名前は英小文字・数字・ハイフンにしてください（${egress}）`);
    }
    for (const collection of asArray(app?.ttl_collections ?? [])) {
      if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(String(collection))) report.error(`${at}: ttl_collections はコレクションの名前で書いてください（${collection}）`);
    }
    if (app?.budget_jpy !== undefined && !(Number.isInteger(app.budget_jpy) && app.budget_jpy > 0)) report.error(`${at}: budget_jpy（月額予算・円）は正の整数にしてください`);
    for (const key of ["display_name", "description", "department"]) {
      if (typeof app?.[key] !== "string" || app[key].trim() === "") report.error(`${at}: ${key} を書いてください`);
    }
    const owners = asArray(app?.owners);
    if (owners.length === 0) report.error(`${at}: owners（オーナー）を 1 人以上書いてください`);
    for (const owner of owners) {
      if (!/^(user|group):[^@\s]+@[^@\s]+$/.test(String(owner))) report.error(`${at}: owners は user:<メール> か group:<メール> の形式にしてください（${owner}）`);
    }
    const admins = asArray(app?.admins);
    if (admins.length === 0) report.error(`${at}: admins（アプリ内の最初の admin）を 1 人以上書いてください`);
    for (const admin of admins) {
      if (!/^[^@\s:]+@[^@\s]+$/.test(String(admin))) report.error(`${at}: admins はメールアドレスで書いてください（${admin}）`);
    }
    for (const secret of asArray(app?.secrets ?? [])) {
      if (!/^[a-z][a-z0-9-]*$/.test(String(secret))) report.error(`${at}: secrets の名前は英小文字・数字・ハイフンにしてください（${secret}）`);
    }

    // セルフサービスの台帳に置けるのは、標準の型だけ（レビューなしで反映されるため）
    if (selfService) {
      const toReviewed = "platform/catalog/apps.yaml に登録して、エンジニア組織のレビューを受けてください";
      if (app?.tier !== 0) report.error(`${at}: self-service/ に置けるのは tier: 0 だけです。${toReviewed}`);
      if (!STANDARD_RULES_TEMPLATES.includes(app?.rules_template)) report.error(`${at}: self-service/ では rules_template に標準テンプレート（${STANDARD_RULES_TEMPLATES.join(" / ")}）を使ってください。独自の Rules が要るなら、${toReviewed}`);
      if (asArray(app?.secrets ?? []).length > 0) report.error(`${at}: self-service/ ではシークレットを使えません。${toReviewed}`);
      if (asArray(app?.external_egress ?? []).length > 0) report.error(`${at}: self-service/ では外部への送信（external_egress）ができません。${toReviewed}`);
      for (const member of [...owners.map((o) => String(o).replace(/^(user|group):/, "")), ...admins.map(String)]) {
        if (!member.toLowerCase().endsWith(`@${config.internal_domain.toLowerCase()}`)) report.error(`${at}: owners / admins は社内ドメイン（${config.internal_domain}）のアドレスにしてください（${member}）`);
      }
    }

    // 有効期限（expires）: 棚卸しの起点。期限切れのアプリは CI を通さない
    const expires = String(app?.expires ?? "");
    const date = new Date(`${expires}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expires) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== expires) {
      report.error(`${at}: expires（有効期限）を YYYY-MM-DD で書いてください`);
    } else if (expires < today) {
      report.error(`${at}: 有効期限（${expires}）を過ぎています。延長するか、アプリを停止してください`);
    } else if ((date.getTime() - new Date(`${today}T00:00:00Z`).getTime()) / 86_400_000 > 366) {
      report.warn(`${at}: 有効期限（${expires}）が 1 年より先です。棚卸しのために、1 年以内を勧めます`);
    }
  }
}

// ---- アプリ（apps/<id>/） -------------------------------------------------------

function checkFirebaseJson(appId, appDir, config, app, report, rel) {
  const tier = app.tier;
  const path = join(appDir, "firebase.json");
  if (!existsSync(path)) return report.error(`${rel(path)}: firebase.json がありません`);
  const fb = readJson(path);
  const at = rel(path);
  const site = `${config.site_prefix}-${appId}`;

  for (const hosting of asArray(fb.hosting)) {
    if (hosting.site !== site) report.error(`${at}: hosting.site は自分のサイト ${site} にしてください（${hosting.site ?? hosting.target ?? "未指定"}）`);
    if (tier === 0 && asArray(hosting.rewrites).some((r) => r.function !== undefined || r.run !== undefined)) {
      report.error(`${at}: Tier 0 では hosting.rewrites から関数・Cloud Run を呼べません（HTTP の入口を作らない）`);
    }
  }
  for (const firestore of asArray(fb.firestore)) {
    if (firestore.database !== appId) report.error(`${at}: firestore.database は自分の DB ${appId} にしてください（未指定だと (default) になる）`);
    if (firestore.location !== undefined && firestore.location !== config.region) report.error(`${at}: firestore.location は ${config.region} にしてください`);
    if (STANDARD_RULES_TEMPLATES.includes(app.rules_template)) {
      if (firestore.rules !== TEMPLATE_COPY) report.error(`${at}: firestore.rules は ${TEMPLATE_COPY}（標準テンプレートの写し）にしてください（エミュレータでも本番と同じ Rules で確かめるため）`);
    }
  }
  for (const functions of asArray(fb.functions)) {
    if (functions.codebase !== appId) report.error(`${at}: functions.codebase は ${appId} にしてください（他のアプリの関数を消さないため）`);
  }
  for (const key of ["storage", "database", "dataconnect", "apphosting", "extensions", "remoteconfig"]) {
    if (fb[key] !== undefined) report.error(`${at}: ${key} は Tier 0 / 1 の共有プロジェクトでは使えません（エンジニア組織に相談してください）`);
  }

  const rc = join(appDir, ".firebaserc");
  if (existsSync(rc)) {
    const def = readJson(rc).projects?.default;
    if (def !== undefined && !String(def).startsWith("demo-")) {
      report.error(`${rel(rc)}: default は demo-${appId} にしてください（ローカルから本番のプロジェクトを触らないため）`);
    }
  }
}

function checkFunctions(appId, appDir, tier, allowed, report, rel) {
  const dir = join(appDir, "functions");
  if (!existsSync(dir)) return;

  const pkgPath = join(dir, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = readJson(pkgPath);
    for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
      if (!BUNDLE_EXTERNAL.includes(name)) {
        report.error(`${rel(pkgPath)}: dependencies に置けるのは ${BUNDLE_EXTERNAL.join(" / ")} だけです。${name} は devDependencies に移し、esbuild でバンドルしてください`);
      } else if (!/^\d+\.\d+\.\d+$/.test(version)) {
        report.error(`${rel(pkgPath)}: ${name} の版は固定してください（${version} → 例: 1.2.3）`);
      }
    }
    checkAllowedDependencies(pkgPath, pkg, allowed, report, rel);
  }

  const entry = join(dir, "src", "index.ts");
  if (!existsSync(entry)) return report.error(`${rel(dir)}: 関数の入口 src/index.ts がありません`);

  if (tier === 0) {
    for (const file of listFiles(join(dir, "src")).filter((f) => /\.(ts|js|mjs|cjs)$/.test(f))) {
      const code = stripComments(readFileSync(file, "utf8"));
      if (/\bonRequest\b|\bonCall\b|firebase-functions\/(?:v[12]\/)?https|\bfunctions\.https\b/.test(code)) {
        report.error(`${rel(file)}: Tier 0 では HTTP 関数（onRequest / onCall）を作れません。画面からは Firestore に書き込み、Firestore トリガーか onSchedule で処理してください`);
      }
    }
  }

  // 外部への送信は safeFetch を通す（内部ネットワークへのアクセスと、意図しない送信先を防ぐ）
  for (const file of listFiles(join(dir, "src")).filter((f) => /\.(ts|js|mjs|cjs)$/.test(f) && !/\.test\.|\/lib\/safeFetch\.ts$/.test(f))) {
    if (/(^|[^.\w])fetch\s*\(/.test(stripComments(readFileSync(file, "utf8")))) {
      report.review(`${rel(file)}: safeFetch を通さない fetch() があります（送信先と SSRF 対策をエンジニア組織が確認する）`);
    }
  }

  const code = stripComments(readFileSync(entry, "utf8"));
  const group = camel(appId);
  const exports = [...code.matchAll(/^export\s+(?:const|let|var|function|async\s+function|default|\{|\*)\s*(\w*)/gm)].map((m) => m[1]);
  if (exports.length !== 1 || exports[0] !== group) {
    report.error(`${rel(entry)}: 関数は export const ${group} = { ... } の 1 つのグループだけで export してください（関数名が ${group}-<名前> になる）`);
  }
  for (const option of ["serviceAccount", "maxInstances", "labels", "region"]) {
    if (!new RegExp(`\\b${option}\\b`).test(code)) report.error(`${rel(entry)}: 全関数に ${option} を指定してください（共通の設定オブジェクトにまとめる）`);
  }
  const allCode = listFiles(join(dir, "src")).map((f) => stripComments(readFileSync(f, "utf8"))).join("\n");
  if (!allCode.includes(`app-\${APP_ID}@`) && !allCode.includes(`app-${appId}@`)) {
    report.error(`${rel(dir)}: 実行 SA は app-${appId}@<project>.iam.gserviceaccount.com を、メールアドレスをすべて書いて指定してください`);
  }
}

function checkAllowedDependencies(pkgPath, pkg, allowed, report, rel) {
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    if (!allowed.has(name)) {
      report.error(`${rel(pkgPath)}: ${name} は許可リスト（platform/policies/allowed-dependencies.json）にありません。追加はエンジニア組織に相談してください`);
    }
  }
}

function checkAppRules(root, appDir, config, app, report, rel) {
  const path = join(appDir, "firestore.rules");
  const copy = join(appDir, TEMPLATE_COPY);
  if (STANDARD_RULES_TEMPLATES.includes(app.rules_template)) {
    // 標準テンプレートのアプリは、基盤が platform/rules-templates/ の Rules を反映する。
    // アプリのディレクトリには、エミュレータ用の写しだけを置く（中身が違えば止める）
    if (existsSync(path)) report.error(`${rel(path)}: rules_template: ${app.rules_template} のアプリには firestore.rules を置けません（反映されるのは標準テンプレート）。独自の Rules が要るなら、台帳を rules_template: custom にしてください`);
    const template = join(root, TEMPLATES_DIR, `${app.rules_template}.rules`);
    if (existsSync(copy) && existsSync(template) && readFileSync(copy, "utf8") !== readFileSync(template, "utf8")) {
      report.error(`${rel(copy)}: 標準テンプレート ${TEMPLATES_DIR}/${app.rules_template}.rules と中身が違います。テンプレートをそのまま写してください（cp ${TEMPLATES_DIR}/${app.rules_template}.rules ${rel(copy)}）`);
    } else if (!existsSync(copy) && existsSync(join(appDir, "firebase.json"))) {
      report.error(`${rel(copy)}: 標準テンプレートの写しがありません（cp ${TEMPLATES_DIR}/${app.rules_template}.rules ${rel(copy)}）`);
    }
    return;
  }
  if (existsSync(copy)) report.error(`${rel(copy)}: rules_template: custom のアプリには置けません（Rules は firestore.rules に書く）`);
  if (!existsSync(path)) return; // まだなければ、platform の Terraform が全拒否の Rules を反映する
  checkRules(path, config, report, rel);
}

function checkRules(path, config, report, rel) {
  const rules = stripComments(readFileSync(path, "utf8"));
  const at = rel(path);

  const functions = new Map([...rules.matchAll(/function\s+(\w+)\s*\(([^)]*)\)\s*\{\s*return\s+([\s\S]*?);\s*\}/g)].map((m) => [m[1], m[3]]));
  const isInternal = functions.get("isInternal");
  const domainPattern = `.*@${config.internal_domain.replaceAll(".", "[.]")}$`;
  if (isInternal === undefined) {
    report.error(`${at}: 社内ドメインを確認する isInternal() がありません`);
  } else {
    if (splitTopLevel(isInternal, "||").length > 1) report.error(`${at}: isInternal() の条件を || で緩めないでください`);
    const parts = splitTopLevel(isInternal, "&&");
    if (!parts.includes("request.auth != null")) report.error(`${at}: isInternal() で request.auth != null を確認してください`);
    if (!parts.includes("request.auth.token.email_verified == true")) report.error(`${at}: isInternal() で email_verified == true を確認してください`);
    if (!parts.some((p) => p.replace(/\s+/g, "") === `request.auth.token.email.lower().matches('${domainPattern}')`)) {
      report.error(`${at}: isInternal() の社内ドメインが platform/config.json の internal_domain（${config.internal_domain}）と合いません。matches('${domainPattern}') にしてください`);
    }
  }

  // isInternal() を必ず通る関数（isEditor() など）を、通ることが確かめられるものから順に足していく
  const guards = new Set(["isInternal"]);
  for (let added = true; added; ) {
    added = false;
    for (const [name, body] of functions) {
      if (!guards.has(name) && requiresGuard(body, guards)) {
        guards.add(name);
        added = true;
      }
    }
  }

  if (/\ballow\s+[\w\s,]+;/.test(rules)) report.error(`${at}: 条件のない allow（誰でも許可）は書けません`);
  for (const [, operations, condition] of rules.matchAll(/\ballow\s+([\w\s,]+?)\s*:\s*if\s+([\s\S]*?);/g)) {
    const expr = condition.trim();
    if (expr === "false") continue;
    if (/^true$|\|\|\s*true\b|\btrue\s*\|\|/.test(expr)) {
      report.error(`${at}: allow ${operations}: if true のような全開放は書けません`);
    } else if (!requiresGuard(expr, guards)) {
      report.error(`${at}: allow ${operations} の条件は isInternal()（か、それを必ず通る ${[...guards].filter((g) => g !== "isInternal").join(" / ") || "関数"}）を && の先頭に置いてください: ${expr.replace(/\s+/g, " ").slice(0, 80)}`);
    }
  }
}

function checkAppFiles(appId, appDir, allowed, report, rel) {
  for (const file of listFiles(appDir)) {
    const name = file.split("/").pop();
    if (["package-lock.json", "yarn.lock", "npm-shrinkwrap.json", "bun.lockb"].includes(name)) {
      report.error(`${rel(file)}: パッケージ管理は pnpm だけを使ってください（ロックファイルはルートの pnpm-lock.yaml）`);
    }
    if ([".npmrc", ".pnpmfile.cjs", "pnpm-workspace.yaml"].includes(name)) {
      report.error(`${rel(file)}: アプリのディレクトリに ${name} は置けません（取得先とサプライチェーン対策の設定はルートで管理する）`);
    }
    if (/\.(png|jpe?g|gif|webp|ico|woff2?|pdf|zip)$/i.test(name) || statSync(file).size > 1024 * 1024) continue;
    const text = readFileSync(file, "utf8");
    for (const [pattern, label] of SECRET_PATTERNS) {
      if (pattern.test(text)) report.error(`${rel(file)}: ${label}らしい文字列があります。秘密情報は Secret Manager に保存してください`);
    }
  }
  const webPkg = join(appDir, "web", "package.json");
  if (existsSync(webPkg)) checkAllowedDependencies(webPkg, readJson(webPkg), allowed, report, rel);
}

// ---- 全体 ---------------------------------------------------------------------

export function checkRepo(root, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const errors = [];
  const warnings = [];
  const report = { error: (m) => errors.push(m), warn: (m) => warnings.push(m), review: () => {} };
  const rel = (path) => relative(root, path);

  const config = readJson(join(root, "platform", "config.json"));
  for (const key of ["project_id", "region", "internal_domain", "site_prefix", "github_repository"]) {
    if (typeof config[key] !== "string" || config[key] === "") report.error(`platform/config.json: ${key} を書いてください`);
  }
  if (errors.length > 0) return { errors, warnings, lanes: [], verdict: "BLOCKED" };
  for (const [key, placeholder] of Object.entries(PLACEHOLDERS)) {
    if (config[key] === placeholder) report.warn(`platform/config.json: ${key} が雛形の値（${placeholder}）のままです。自分の環境の値に書き換えてください`);
  }

  const entries = loadCatalog(root, report);
  checkCatalog(entries, config, today, report);
  const allowed = new Set(readJson(join(root, "platform", "policies", "allowed-dependencies.json")).allowed);

  // 標準の Rules テンプレート（社内ドメインが platform/config.json と合っているか、緩められていないか）
  const templatesDir = join(root, TEMPLATES_DIR);
  for (const name of STANDARD_RULES_TEMPLATES) {
    const path = join(templatesDir, `${name}.rules`);
    if (existsSync(path)) checkRules(path, config, report, rel);
    else report.error(`${TEMPLATES_DIR}/${name}.rules: 標準テンプレートがありません`);
  }

  // レーンの判定（アプリごと）。エンジニア組織の確認が要る理由を集める
  const reasons = new Map(Object.keys(entries).map((id) => [id, []]));
  for (const [id, { app }] of Object.entries(entries)) {
    const add = (m) => reasons.get(id).push(m);
    if (app?.tier === 1) add("Tier 1（Rules と IAM をエンジニア組織が確認する）");
    if (app?.rules_template === "custom") add("独自の Security Rules（rules_template: custom）");
    if (asArray(app?.secrets ?? []).length > 0) add(`シークレットを使う（${asArray(app.secrets).join(", ")}）`);
    if (asArray(app?.external_egress ?? []).length > 0) add(`外部へ送信する（${asArray(app.external_egress).join(", ")}）`);
  }

  const appsDir = join(root, "apps");
  const dirs = existsSync(appsDir) ? readdirSync(appsDir).filter((d) => statSync(join(appsDir, d)).isDirectory()) : [];
  for (const appId of dirs) {
    const appDir = join(appsDir, appId);
    const entry = entries[appId];
    if (entry === undefined) {
      report.error(`apps/${appId}: 台帳（platform/catalog/apps.yaml か ${SELF_SERVICE_DIR}/${appId}.yaml）に登録されていません`);
      continue;
    }
    // セルフサービスのアプリは、確認が要る内容があれば違反にする（レビューを通らないため）
    const appReport = {
      ...report,
      review: (m) => (entry.selfService ? report.error(`${m}。self-service/ のアプリではできません（platform/catalog/apps.yaml に登録する）`) : reasons.get(appId).push(m)),
    };
    checkFirebaseJson(appId, appDir, config, entry.app, appReport, rel);
    checkFunctions(appId, appDir, entry.app.tier, allowed, appReport, rel);
    checkAppRules(root, appDir, config, entry.app, appReport, rel);
    checkAppFiles(appId, appDir, allowed, appReport, rel);
  }

  const blocked = errors.length > 0;
  const lanes = Object.entries(entries).map(([id, { app, selfService }]) => ({
    id,
    catalog: selfService ? "self-service" : "apps.yaml",
    verdict: blocked ? "BLOCKED" : selfService ? "AUTO_APPROVE_ELIGIBLE" : "ENGINEER_REVIEW_REQUIRED",
    reasons: reasons.get(id),
    // apps.yaml にあるが、標準の型に収まっているアプリ（self-service/ に移せば、レビューなしで反映できる）
    movable: !selfService && reasons.get(id).length === 0 && STANDARD_RULES_TEMPLATES.includes(app?.rules_template),
    tier: app?.tier,
    data_class: app?.data_class,
    handles_pii: app?.handles_pii,
    rules_template: app?.rules_template,
    external_egress: asArray(app?.external_egress ?? []),
    expires: String(app?.expires ?? ""),
  }));
  const verdict = blocked ? "BLOCKED" : lanes.some((l) => l.verdict === "ENGINEER_REVIEW_REQUIRED") ? "ENGINEER_REVIEW_REQUIRED" : "AUTO_APPROVE_ELIGIBLE";
  return { errors, warnings, apps: dirs, lanes, verdict };
}

const VERDICT_TEXT = {
  AUTO_APPROVE_ELIGIBLE: "✅ **AUTO_APPROVE_ELIGIBLE**（標準の型：エンジニア組織の承認なしで反映できます）",
  ENGINEER_REVIEW_REQUIRED: "🔍 **ENGINEER_REVIEW_REQUIRED**（エンジニア組織が確認してから反映します）",
  BLOCKED: "🛑 **BLOCKED**（規約違反があります。直すまでマージできません）",
};

/** PR に貼る報告（データの取り扱いの注意と、アプリごとの判定） */
export function renderMarkdown({ errors, warnings, lanes, verdict }, { only = [] } = {}) {
  const shown = only.length > 0 ? lanes.filter((l) => only.includes(l.id)) : lanes;
  const lines = [
    "## 🛡️ ポリシーチェック",
    "",
    `**判定**: ${VERDICT_TEXT[verdict]}`,
    "",
    "> [!WARNING]",
    "> **データベースに入れるデータを確かめてください**",
    "> - Tier 0 のデータベースには、**個人情報・顧客データ・未公開の財務情報・社外秘のファイル**を入れないでください（当てはまるなら Tier 1 / 2 としてエンジニア組織に相談する）。",
    "> - データベースを新しく作ると、監査ログ（`CreateDatabase`）から管理者に通知されます。",
    "> - 台帳にない外部への送信・秘密情報の直書き・HTTP 関数は禁止です。",
    "",
    "| アプリ | 判定 | 台帳 | Tier | データ区分 | 個人情報 | Rules | 外部への送信 | 有効期限 |",
    "| :--- | :--- | :--- | :---: | :---: | :---: | :--- | :--- | :---: |",
    ...shown.map((l) => `| \`${l.id}\` | \`${l.verdict}\` | ${l.catalog} | ${l.tier ?? "-"} | \`${l.data_class ?? "-"}\` | \`${l.handles_pii ?? "-"}\` | \`${l.rules_template ?? "-"}\` | ${l.external_egress.join(", ") || "なし"} | \`${l.expires || "-"}\` |`),
  ];
  for (const lane of shown) {
    if (lane.reasons.length === 0 && !lane.movable) continue;
    lines.push("", `### \`${lane.id}\``);
    for (const reason of lane.reasons) lines.push(`- 🔍 エンジニア組織が確認: ${reason}`);
    if (lane.movable) lines.push(`- 💡 標準の型に収まっています。\`${SELF_SERVICE_DIR}/${lane.id}.yaml\` に移すと、承認なしで反映できます`);
  }
  if (errors.length > 0) lines.push("", "### 規約違反", ...errors.map((e) => `- 🛑 ${e}`));
  if (warnings.length > 0) lines.push("", "### 注意", ...warnings.map((w) => `- ⚠️ ${w}`));
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const values = (flag) => args.flatMap((a, i) => (a === flag && args[i + 1] !== undefined ? [args[i + 1]] : []));
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const result = checkRepo(root);
  const { errors, warnings, apps = [], lanes, verdict } = result;
  const only = values("--app");

  const [markdownOut] = values("--markdown-out");
  if (markdownOut !== undefined) writeFileSync(markdownOut, renderMarkdown(result, { only }));
  if (args.includes("--json")) {
    console.log(JSON.stringify({ verdict, errors, warnings, lanes: only.length > 0 ? lanes.filter((l) => only.includes(l.id)) : lanes }, null, 2));
    process.exit(errors.length > 0 ? 1 : 0);
  }

  for (const w of warnings) console.warn(`⚠️  ${w}`);
  for (const e of errors) console.error(`❌ ${e}`);
  if (errors.length > 0) {
    console.error(`\nポリシーチェック: ${errors.length} 件の違反があります（BLOCKED）`);
    process.exit(1);
  }
  for (const lane of only.length > 0 ? lanes.filter((l) => only.includes(l.id)) : lanes) {
    console.log(`${lane.verdict === "AUTO_APPROVE_ELIGIBLE" ? "✅" : "🔍"} ${lane.id}: ${lane.verdict}${lane.reasons.length > 0 ? `（${lane.reasons.join(" / ")}）` : ""}`);
  }
  console.log(`✅ ポリシーチェック: 違反なし（アプリ: ${apps.join(", ") || "なし"}）`);
}
