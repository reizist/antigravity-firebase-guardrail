// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0
// ==============================================================================
// watchlist.yaml → Firestore（DB: news-watcher）の sync
//
//   pnpm sync:watchlist                     # 差分を表示するだけ（既定）
//   pnpm sync:watchlist --apply             # 反映する
//   pnpm sync:watchlist --apply --prune     # YAML から消したもの（managedBy: yaml）を Firestore からも消す
//   pnpm sync:watchlist --file <path>       # 別の YAML を使う
//
// 反映先:
//   - FIRESTORE_EMULATOR_HOST があればエミュレータ（プロジェクトは GCLOUD_PROJECT、既定 demo-news-watcher）
//   - なければ本番。--project の指定と GOOGLE_OAUTH_ACCESS_TOKEN（gcloud のアクセストークン）が必要
//       GOOGLE_OAUTH_ACCESS_TOKEN="$(gcloud auth print-access-token)" pnpm sync:watchlist --project <project-id> --apply
// docs/news_watcher_design.md §5.1
// ==============================================================================

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { DATABASE_ID } from "../src/config.js";
import { FirestoreRest } from "../src/watchlist/firestoreRest.js";
import { formatPlan, planSync, type CurrentState } from "../src/watchlist/plan.js";
import { COLLECTIONS, parseWatchlist, WatchlistError } from "../src/watchlist/schema.js";

const { values } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    prune: { type: "boolean", default: false },
    file: { type: "string", default: resolve(process.cwd(), "../watchlist.yaml") },
    project: { type: "string" },
  },
});

async function main() {
  const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
  const projectId = values.project ?? (emulatorHost ? (process.env.GCLOUD_PROJECT ?? "demo-news-watcher") : undefined);
  if (!projectId) {
    throw new Error("本番に sync するときは --project を指定してください（エミュレータなら FIRESTORE_EMULATOR_HOST を設定）");
  }

  const desired = parseWatchlist(await readFile(values.file, "utf8"));
  const client = new FirestoreRest({
    projectId,
    databaseId: DATABASE_ID,
    emulatorHost,
    accessToken: process.env.GOOGLE_OAUTH_ACCESS_TOKEN,
  });

  const current = Object.fromEntries(await Promise.all(COLLECTIONS.map(async (c) => [c, await client.list(c)] as const))) as CurrentState;
  const ops = planSync(desired, current, { prune: values.prune });

  console.log(`反映先: ${emulatorHost ? `エミュレータ ${emulatorHost}` : "本番"} / projects/${projectId}/databases/${DATABASE_ID}`);
  console.log(`YAML : ${values.file}\n`);
  console.log(formatPlan(ops, current, desired));

  const writes = ops.filter((o) => o.kind !== "skip-unmanaged");
  if (!values.apply) {
    if (writes.length > 0) console.log("\n差分を表示しただけです。反映するには --apply を付けてください");
    return;
  }

  // 配信先 → 情報源 → トピックの順に書く（トピックが参照する先を先に作る）。削除は逆順
  for (const op of writes.filter((o) => o.kind !== "delete")) {
    await client.patch(op.collection, op.id, op.data!, op.fieldPaths!, op.kind === "update" ? { mustExist: true } : {});
  }
  for (const op of writes.filter((o) => o.kind === "delete").reverse()) {
    await client.delete(op.collection, op.id);
  }
  console.log(`\n✅ ${writes.length} 件を反映しました`);
}

main().catch((e) => {
  console.error(e instanceof WatchlistError ? e.message : `❌ ${(e as Error).message}`);
  process.exit(1);
});
