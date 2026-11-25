// ==============================================================================
// 承認なしで反映してよい plan かを確かめる（.github/workflows/deploy.yml の自動反映レーン）
//   terraform show -json platform.tfplan > plan.json
//   node platform/policies/plan-guard.mjs plan.json
//
// 承認なしで反映するのは、セルフサービスの台帳（platform/catalog/self-service/<id>.yaml）だけが
// 変わったとき。ただし、main にはまだ承認されていない別の変更が残っているかもしれない。
// そこで plan の中身を見て、「セルフサービスのアプリのテナントを作る・直す」以外が 1 つでもあれば、
// 自動では反映しない（承認つきの反映に回す）。
//   - 変更してよいのは module.tenant["<id>"] の中と google_billing_budget.app["<id>"] だけ
//   - 削除だけの変更と、データベースを消す変更（作り直しを含む）は認めない
//   - アプリを足すと必ず変わる共通のリソース 2 つは、変わり方を確かめて認める
//       terraform_data.catalog_check           : 台帳の検証（app id の一覧が変わるだけ）
//       google_identity_platform_config.this   : Auth の許可ドメインに、そのアプリのサイトが増えるだけ
// ==============================================================================

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OWNED = [/^module\.tenant\["([^"]+)"\]\./, /^google_billing_budget\.app\["([^"]+)"\]$/];

/** Auth の設定の変更が「セルフサービスのアプリのサイトを許可ドメインに足す」だけか */
function onlyAddsTenantDomains(change, ids, sitePrefix) {
  const { before, after } = change;
  if (before === null || after === null || typeof before !== "object" || typeof after !== "object") return false;
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  if (changed.some((k) => k !== "authorized_domains")) return false;
  const old = new Set(before.authorized_domains ?? []);
  const now = after.authorized_domains ?? [];
  if ([...old].some((d) => !now.includes(d))) return false;
  const allowed = new Set([...ids].flatMap((id) => [`${sitePrefix}-${id}.web.app`, `${sitePrefix}-${id}.firebaseapp.com`]));
  return now.filter((d) => !old.has(d)).every((d) => allowed.has(d));
}

export function checkPlan(plan, selfServiceIds, { sitePrefix = "" } = {}) {
  const ids = new Set(selfServiceIds);
  const violations = [];
  const changes = [];
  for (const rc of plan.resource_changes ?? []) {
    const actions = rc.change?.actions ?? [];
    if (actions.every((a) => a === "no-op" || a === "read")) continue;
    changes.push(`${actions.join("+")} ${rc.address}`);
    const updateOnly = actions.length === 1 && actions[0] === "update";
    if (rc.address === "terraform_data.catalog_check" && updateOnly) continue;
    if (rc.address === "google_identity_platform_config.this" && updateOnly && onlyAddsTenantDomains(rc.change, ids, sitePrefix)) continue;
    const id = OWNED.map((re) => re.exec(rc.address)?.[1]).find((v) => v !== undefined);
    if (id === undefined || !ids.has(id)) {
      violations.push(`${rc.address}: セルフサービスのアプリのテナント以外の変更です（${actions.join("+")}）`);
    } else if (actions.length === 1 && actions[0] === "delete") {
      violations.push(`${rc.address}: 削除は承認なしでは反映しません`);
    } else if (rc.type === "google_firestore_database" && actions.includes("delete")) {
      violations.push(`${rc.address}: データベースの作り直し（データが消える）は承認なしでは反映しません`);
    }
  }
  return { ok: violations.length === 0, violations, changes };
}

export function selfServiceIds(root) {
  const dir = join(root, "platform", "catalog", "self-service");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".yaml")).map((f) => f.slice(0, -".yaml".length)) : [];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const { site_prefix: sitePrefix } = JSON.parse(readFileSync(join(root, "platform", "config.json"), "utf8"));
  const { ok, violations, changes } = checkPlan(JSON.parse(readFileSync(process.argv[2], "utf8")), selfServiceIds(root), { sitePrefix });
  for (const c of changes) console.log(`  ${c}`);
  if (!ok) {
    for (const v of violations) console.error(`❌ ${v}`);
    console.error("\nこの plan は承認なしでは反映できません（承認つきの反映に回します）");
    process.exit(1);
  }
  console.log(`✅ 承認なしで反映できる plan です（変更 ${changes.length} 件。すべてセルフサービスのアプリのテナント）`);
}
