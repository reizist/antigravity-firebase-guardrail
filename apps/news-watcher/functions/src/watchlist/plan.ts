// ==============================================================================
// sync の計画（YAML のあるべき姿と、Firestore の今の状態を比べる）
//   - 書き込むのは YAML が持ち主の項目だけ（OWNED_FIELDS）。関数が書く項目は残す
//   - sync したドキュメントには managedBy: "yaml" を付ける。更新・削除はこれが付いたものだけ
//     （将来、画面から作ったドキュメント managedBy: "ui" と共存できるようにする）
//   - 情報源は、新規か url / query / extraction が変わったときだけ status: "pending"（関数が判定し直す）
// ==============================================================================

import { COLLECTIONS, OWNED_FIELDS, type Collection, type DocData, type Watchlist } from "./schema.js";

export const MANAGED_BY = "yaml";

export type OpKind = "create" | "update" | "delete" | "skip-unmanaged";

export interface SyncOp {
  kind: OpKind;
  collection: Collection;
  id: string;
  /** 書き込む値（create / update） */
  data?: DocData;
  /** 更新する項目（create / update）。ここに含まれていて data にない項目は削除される */
  fieldPaths?: string[];
  /** 変わった項目（表示用） */
  changed?: string[];
  /** 情報源の再判定を依頼するか */
  reinspect?: boolean;
}

export type CurrentState = Record<Collection, Record<string, DocData>>;

/** 順序に左右されない比較のため、キーを並べた JSON にする */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

const REINSPECT_FIELDS = new Set(["url", "query", "extraction"]);

/** 廃止した項目。YAML 管理のドキュメントに残っていたら消す（トピックごとの配信 → digests に移した。§5.3） */
const DEPRECATED_FIELDS: Partial<Record<Collection, string[]>> = {
  topics: ["channelId", "digestCron", "minScore", "maxItemsPerDigest"],
};

export function planSync(desired: Watchlist, current: CurrentState, options: { prune?: boolean } = {}): SyncOp[] {
  const ops: SyncOp[] = [];
  for (const collection of COLLECTIONS) {
    const owned = OWNED_FIELDS[collection] as readonly string[];
    const want = desired[collection];
    const have = current[collection] ?? {};

    for (const [id, data] of Object.entries(want)) {
      const existing = have[id];
      if (existing && existing.managedBy !== MANAGED_BY) {
        // 画面などから作られたものと ID がぶつかった：上書きしない
        ops.push({ kind: "skip-unmanaged", collection, id });
        continue;
      }
      const stale = (DEPRECATED_FIELDS[collection] ?? []).filter((f) => existing?.[f] !== undefined);
      const changed = [...owned.filter((f) => stable(data[f]) !== stable(existing?.[f])), ...stale];
      const isNew = !existing;
      const reinspect =
        collection === "sources" && (isNew || changed.some((f) => REINSPECT_FIELDS.has(f)) || existing?.status === undefined);
      if (!isNew && changed.length === 0 && !reinspect) continue;

      const extra: DocData = { managedBy: MANAGED_BY };
      if (reinspect) extra.status = "pending";
      if (isNew && collection === "sources") extra.createdBy = "watchlist.yaml";
      ops.push({
        kind: isNew ? "create" : "update",
        collection,
        id,
        data: { ...data, ...extra },
        fieldPaths: [...owned, ...Object.keys(extra), ...stale],
        changed: isNew ? Object.keys(data) : changed,
        reinspect,
      });
    }

    if (options.prune) {
      for (const [id, existing] of Object.entries(have)) {
        if (id in want) continue;
        if (existing.managedBy === MANAGED_BY) ops.push({ kind: "delete", collection, id });
      }
    }
  }
  return ops;
}

/** 計画を人が読める形にする */
export function formatPlan(ops: SyncOp[], current: CurrentState, desired: Watchlist): string {
  const lines: string[] = [];
  const mark: Record<OpKind, string> = { create: "+", update: "~", delete: "-", "skip-unmanaged": "!" };
  for (const op of ops) {
    let detail = "";
    if (op.kind === "update") detail = `（${op.changed?.join(", ") || "status"}${op.reinspect ? " → 再判定" : ""}）`;
    if (op.kind === "create" && op.reinspect) detail = "（判定を依頼）";
    if (op.kind === "skip-unmanaged") detail = "（managedBy が yaml ではないので上書きしない）";
    lines.push(`  ${mark[op.kind]} ${op.collection}/${op.id} ${detail}`);
  }
  const unmanaged = COLLECTIONS.flatMap((c) =>
    Object.entries(current[c] ?? {})
      .filter(([id, d]) => !(id in desired[c]) && d.managedBy !== MANAGED_BY)
      .map(([id]) => `${c}/${id}`),
  );
  const counts = (k: OpKind) => ops.filter((o) => o.kind === k).length;
  lines.push("");
  lines.push(`追加 ${counts("create")} / 変更 ${counts("update")} / 削除 ${counts("delete")} / 上書きしない ${counts("skip-unmanaged")}`);
  if (unmanaged.length > 0) lines.push(`YAML 管理外のドキュメント（触らない）: ${unmanaged.join(", ")}`);
  return lines.join("\n");
}
