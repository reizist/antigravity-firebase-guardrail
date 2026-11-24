import { createHash } from "node:crypto";

/** 追跡用のクエリ（同じ記事を別物と数えないために取り除く） */
const TRACKING_PARAMS = [/^utm_/i, /^fbclid$/i, /^gclid$/i, /^yclid$/i, /^mc_(cid|eid)$/i, /^_ga$/i, /^ref$/i];

/**
 * 記事の URL を正規化する（重複除外のキーにする）。
 * - スキームとホストを小文字に、フラグメントと追跡用のクエリを除く、クエリを並べ替える
 */
export function normalizeUrl(raw: string, base?: string): string {
  const url = new URL(raw, base);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  const kept = [...url.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAMS.some((re) => re.test(key)))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = "";
  for (const [key, value] of kept) url.searchParams.append(key, value);
  if (url.pathname !== "/" && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
  return url.toString();
}

/** 正規化した URL のハッシュ（articles のドキュメント ID） */
export function urlHash(raw: string, base?: string): string {
  return createHash("sha256").update(normalizeUrl(raw, base)).digest("hex").slice(0, 32);
}

export function hostOf(raw: string): string {
  return new URL(raw).hostname.toLowerCase();
}
