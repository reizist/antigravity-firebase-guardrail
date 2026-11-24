// ==============================================================================
// Firestore REST API の最小クライアント（sync スクリプト用。依存を増やさないため自前で書く）
//   - エミュレータ: FIRESTORE_EMULATOR_HOST があれば http://<host>/v1/...（Bearer owner で Rules を通さず書ける）
//   - 本番: https://firestore.googleapis.com/v1/...（gcloud のアクセストークン。IAM で認可され、Rules は通らない）
// ==============================================================================

import type { DocData } from "./schema.js";

type Value =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { stringValue: string }
  | { timestampValue: string }
  | { arrayValue: { values?: Value[] } }
  | { mapValue: { fields?: Record<string, Value> } };

export function toValue(v: unknown): Value {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === "object") return { mapValue: { fields: toFields(v as DocData) } };
  throw new Error(`Firestore に書けない値です: ${String(v)}`);
}

export function toFields(obj: DocData): Record<string, Value> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined).map(([k, v]) => [k, toValue(v)]));
}

export function fromValue(v: Value): unknown {
  if ("nullValue" in v) return null;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("stringValue" in v) return v.stringValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(fromValue);
  if ("mapValue" in v) return fromFields(v.mapValue.fields ?? {});
  return undefined;
}

export function fromFields(fields: Record<string, Value>): DocData {
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, fromValue(v)]));
}

export interface RestTarget {
  projectId: string;
  databaseId: string;
  /** エミュレータのホスト（例: 127.0.0.1:8080）。なければ本番 */
  emulatorHost?: string;
  /** 本番用のアクセストークン */
  accessToken?: string;
}

export class FirestoreRest {
  private readonly base: string;
  private readonly headers: Record<string, string>;

  constructor(private readonly target: RestTarget, private readonly fetchImpl: typeof fetch = fetch) {
    const path = `/v1/projects/${target.projectId}/databases/${target.databaseId}/documents`;
    if (target.emulatorHost) {
      this.base = `http://${target.emulatorHost}${path}`;
      this.headers = { Authorization: "Bearer owner" };
    } else {
      if (!target.accessToken) throw new Error("本番に sync するにはアクセストークンが必要です（GOOGLE_OAUTH_ACCESS_TOKEN に gcloud auth print-access-token の値を設定してください）");
      this.base = `https://firestore.googleapis.com${path}`;
      this.headers = { Authorization: `Bearer ${target.accessToken}`, "x-goog-user-project": target.projectId };
    }
  }

  private async call(url: string, init: RequestInit = {}): Promise<unknown> {
    const res = await this.fetchImpl(url, {
      ...init,
      headers: { ...this.headers, "Content-Type": "application/json", ...(init.headers as Record<string, string> | undefined) },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Firestore REST ${init.method ?? "GET"} ${url.replace(this.base, "")} → HTTP ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }

  /** コレクションの全ドキュメント（ID → データ） */
  async list(collection: string): Promise<Record<string, DocData>> {
    const out: Record<string, DocData> = {};
    let pageToken = "";
    do {
      const url = `${this.base}/${collection}?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
      const body = (await this.call(url)) as { documents?: { name: string; fields?: Record<string, Value> }[]; nextPageToken?: string };
      for (const doc of body.documents ?? []) out[doc.name.split("/").pop()!] = fromFields(doc.fields ?? {});
      pageToken = body.nextPageToken ?? "";
    } while (pageToken);
    return out;
  }

  /** 指定した項目だけを書き換える（fieldPaths にあって data にない項目は削除される） */
  async patch(collection: string, id: string, data: DocData, fieldPaths: string[], options: { mustExist?: boolean } = {}): Promise<void> {
    const params = new URLSearchParams();
    for (const f of fieldPaths) params.append("updateMask.fieldPaths", f);
    if (options.mustExist !== undefined) params.append("currentDocument.exists", String(options.mustExist));
    await this.call(`${this.base}/${collection}/${encodeURIComponent(id)}?${params}`, {
      method: "PATCH",
      body: JSON.stringify({ fields: toFields(data) }),
    });
  }

  async delete(collection: string, id: string): Promise<void> {
    await this.call(`${this.base}/${collection}/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
}
