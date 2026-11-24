// ==============================================================================
// CI のポリシーチェック（docs/platform_design.md §5）
//   node platform/policies/check.mjs        # リポジトリ全体を確認（pnpm policy）
//
// AI への指示（Skill）だけでは出力のブレをなくせないので、規約から外れた変更を PR の時点で止める。
// ここで確認するのは「台帳」「担当範囲（firebase.json）」「関数（HTTP 関数の禁止など）」「Security Rules」
// 「依存」「秘密情報」。文字列と正規表現による簡易チェックで、構文解析はしていない（すり抜けは
// IAM と Security Rules のレビューで止める前提）。
// ==============================================================================

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const APP_ID_PATTERN = /^[a-z][a-z0-9-]{2,18}[a-z0-9]$/;
const DATA_CLASSES = ["public", "internal", "confidential"];
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

function checkCatalog(catalog, today, report) {
  const apps = catalog?.apps ?? {};
  const prefixes = new Map();
  for (const [id, app] of Object.entries(apps)) {
    const at = `platform/catalog/apps.yaml: ${id}`;
    if (!APP_ID_PATTERN.test(id)) report.error(`${at}: app id は英小文字で始まり英小文字か数字で終わる、英小文字・数字・ハイフンの 4〜20 文字にしてください`);
    const prefix = id.replaceAll("-", "");
    if (prefixes.has(prefix)) report.error(`${at}: ハイフンを除くと ${prefixes.get(prefix)} と同じになります（関数のサービス名が重なる）`);
    prefixes.set(prefix, id);

    if (![0, 1].includes(app?.tier)) report.error(`${at}: tier は 0 か 1 にしてください（Tier 2 は専用プロジェクトに切り出す）`);
    if (!DATA_CLASSES.includes(app?.data_class)) report.error(`${at}: data_class は ${DATA_CLASSES.join(" / ")} のどれかにしてください`);
    if (app?.tier === 0 && app?.data_class === "confidential") report.error(`${at}: Tier 0 で扱えるのは internal までです`);
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
    for (const secret of asArray(app?.secrets)) {
      if (!/^[a-z][a-z0-9-]*$/.test(String(secret))) report.error(`${at}: secrets の名前は英小文字・数字・ハイフンにしてください（${secret}）`);
    }

    // 有効期限（expires）: 棚卸しの起点。期限切れのアプリは CI を通さない
    const expires = String(app?.expires ?? "");
    const date = new Date(`${expires}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expires) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== expires) {
      report.error(`${at}: expires（有効期限）を YYYY-MM-DD で書いてください`);
    } else if (expires < today) {
      report.error(`${at}: 有効期限（${expires}）を過ぎています。延長するか、アプリを停止してください`);
    }
  }
  return apps;
}

// ---- アプリ（apps/<id>/） -------------------------------------------------------

function checkFirebaseJson(appId, appDir, config, tier, report, rel) {
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

function checkRules(appId, appDir, config, report, rel) {
  const path = join(appDir, "firestore.rules");
  if (!existsSync(path)) return; // まだなければ、platform の Terraform が全拒否の Rules を反映する
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
  const report = { error: (m) => errors.push(m), warn: (m) => warnings.push(m) };
  const rel = (path) => relative(root, path);

  const config = readJson(join(root, "platform", "config.json"));
  for (const key of ["project_id", "region", "internal_domain", "site_prefix", "github_repository"]) {
    if (typeof config[key] !== "string" || config[key] === "") report.error(`platform/config.json: ${key} を書いてください`);
  }
  if (errors.length > 0) return { errors, warnings };
  for (const [key, placeholder] of Object.entries(PLACEHOLDERS)) {
    if (config[key] === placeholder) report.warn(`platform/config.json: ${key} が雛形の値（${placeholder}）のままです。自分の環境の値に書き換えてください`);
  }

  const catalog = parseYaml(readFileSync(join(root, "platform", "catalog", "apps.yaml"), "utf8"));
  const apps = checkCatalog(catalog, today, report);
  const allowed = new Set(readJson(join(root, "platform", "policies", "allowed-dependencies.json")).allowed);

  const appsDir = join(root, "apps");
  const dirs = existsSync(appsDir) ? readdirSync(appsDir).filter((d) => statSync(join(appsDir, d)).isDirectory()) : [];
  for (const appId of dirs) {
    const appDir = join(appsDir, appId);
    const app = apps[appId];
    if (app === undefined) {
      report.error(`apps/${appId}: 台帳 platform/catalog/apps.yaml に登録されていません`);
      continue;
    }
    checkFirebaseJson(appId, appDir, config, app.tier, report, rel);
    checkFunctions(appId, appDir, app.tier, allowed, report, rel);
    checkRules(appId, appDir, config, report, rel);
    checkAppFiles(appId, appDir, allowed, report, rel);
  }
  return { errors, warnings, apps: dirs };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const { errors, warnings, apps = [] } = checkRepo(root);
  for (const w of warnings) console.warn(`⚠️  ${w}`);
  for (const e of errors) console.error(`❌ ${e}`);
  if (errors.length > 0) {
    console.error(`\nポリシーチェック: ${errors.length} 件の違反があります`);
    process.exit(1);
  }
  console.log(`✅ ポリシーチェック: 違反なし（アプリ: ${apps.join(", ") || "なし"}）`);
}
