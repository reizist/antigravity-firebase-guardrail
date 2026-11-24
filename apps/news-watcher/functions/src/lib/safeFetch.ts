// ==============================================================================
// 安全な取得（利用者が登録した任意の URL を取りに行くため、社内・GCP 内部への踏み台にならないようにする）
//   - https だけ、ポートは 443 だけ、URL にユーザー名・パスワードを含めない
//   - 接続する直前に名前解決の結果を確認し、プライベート・ループバック・リンクローカル
//     （169.254.169.254 のメタデータサーバーを含む）などには接続しない（DNS リバインディング対策）
//   - リダイレクトは手動でたどり、毎回同じ確認をする
//   - タイムアウト・受け取るサイズ・リダイレクト回数に上限を設ける
// docs/news_watcher_design.md §3.3
// ==============================================================================

import dns from "node:dns";
import https from "node:https";
import net from "node:net";
import type { LookupFunction } from "node:net";
import zlib from "node:zlib";
import { LIMITS, USER_AGENT } from "../config.js";

export class UnsafeUrlError extends Error {
  override name = "UnsafeUrlError";
}

export class FetchError extends Error {
  override name = "FetchError";
}

// ---- IP アドレスの判定 ---------------------------------------------------------

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function inCidr4(ip: string, cidr: string): boolean {
  const [base, bitsStr] = cidr.split("/") as [string, string];
  const bits = Number(bitsStr);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

const BLOCKED_V4 = [
  "0.0.0.0/8", // 「このネットワーク」
  "10.0.0.0/8", // プライベート
  "100.64.0.0/10", // CGNAT
  "127.0.0.0/8", // ループバック
  "169.254.0.0/16", // リンクローカル（メタデータサーバー 169.254.169.254 を含む）
  "172.16.0.0/12", // プライベート
  "192.0.0.0/24", // IETF プロトコル割り当て
  "192.0.2.0/24", // ドキュメント用
  "192.168.0.0/16", // プライベート
  "198.18.0.0/15", // ベンチマーク用
  "198.51.100.0/24", // ドキュメント用
  "203.0.113.0/24", // ドキュメント用
  "224.0.0.0/4", // マルチキャスト
  "240.0.0.0/4", // 予約・ブロードキャスト
];

/** 接続してはいけないアドレスなら true */
export function isBlockedAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return BLOCKED_V4.some((cidr) => inCidr4(ip, cidr));
  if (family === 6) {
    const v6 = ip.toLowerCase();
    // IPv4 射影アドレス（::ffff:10.0.0.1 など）は IPv4 として判定
    const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedAddress(mapped[1]!);
    if (v6 === "::" || v6 === "::1") return true;
    if (/^f[cd]/.test(v6)) return true; // fc00::/7 ユニークローカル
    if (/^fe[89ab]/.test(v6)) return true; // fe80::/10 リンクローカル
    if (/^ff/.test(v6)) return true; // マルチキャスト
    if (v6.startsWith("64:ff9b:")) return true; // NAT64（内部の IPv4 に届く可能性がある）
    if (v6.startsWith("2001:db8:")) return true; // ドキュメント用
    return false;
  }
  return true; // IP として解釈できないものは拒否
}

// ---- URL の形の確認 ------------------------------------------------------------

const BLOCKED_HOST_SUFFIXES = [".internal", ".local", ".localhost", ".corp", ".lan", ".home.arpa"];

/** URL の形だけを確認する（名前解決はしない）。問題があれば UnsafeUrlError */
export function assertSafeUrlShape(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("URL の形式が正しくありません");
  }
  if (url.protocol !== "https:") throw new UnsafeUrlError("https:// で始まる URL だけ登録できます");
  if (url.username || url.password) throw new UnsafeUrlError("URL にユーザー名やパスワードを含めることはできません");
  if (url.port && url.port !== "443") throw new UnsafeUrlError("443 以外のポートには接続できません");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "metadata.google.internal") throw new UnsafeUrlError("内部向けのホストには接続できません");
  if (BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) throw new UnsafeUrlError("内部向けのホストには接続できません");
  if (!host.includes(".") && net.isIP(host) === 0) throw new UnsafeUrlError("ドメイン名を省略したホストには接続できません");
  if (net.isIP(host) !== 0 && isBlockedAddress(host)) throw new UnsafeUrlError("内部向けのアドレスには接続できません");
  return url;
}

// ---- 接続直前の名前解決の確認 --------------------------------------------------

type DnsLookupAll = (
  hostname: string,
  options: { all: true },
  callback: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void,
) => void;

/** 名前解決の結果に接続してはいけないアドレスが含まれていたら、接続させない lookup 関数を作る */
export function createGuardedLookup(dnsLookup: DnsLookupAll = dns.lookup as unknown as DnsLookupAll): LookupFunction {
  return ((hostname: string, options: dns.LookupOptions, callback: (...args: unknown[]) => void) => {
    dnsLookup(hostname, { all: true }, (err, addresses) => {
      if (err) return callback(err);
      if (addresses.length === 0) return callback(new FetchError(`${hostname} の名前解決に失敗しました`));
      const blocked = addresses.find((a) => isBlockedAddress(a.address));
      if (blocked) return callback(new UnsafeUrlError(`内部向けのアドレス（${blocked.address}）には接続できません`));
      const wanted = options?.family ? addresses.filter((a) => a.family === options.family) : addresses;
      const list = wanted.length > 0 ? wanted : addresses;
      if (options?.all) return callback(null, list);
      return callback(null, list[0]!.address, list[0]!.family);
    });
  }) as LookupFunction;
}

// ---- 取得 ---------------------------------------------------------------------

export interface SafeFetchResult {
  /** リダイレクト後の URL */
  url: string;
  status: number;
  contentType: string;
  body: string;
}

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  accept?: string;
  lookup?: LookupFunction;
}

function requestOnce(url: URL, opts: Required<Omit<SafeFetchOptions, "accept">> & { accept: string }) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>(
    (resolve, reject) => {
      const req = https.request(
        url,
        {
          method: "GET",
          lookup: opts.lookup,
          headers: {
            "User-Agent": USER_AGENT,
            Accept: opts.accept,
            "Accept-Encoding": "gzip, deflate, br",
          },
          timeout: opts.timeoutMs,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          // リダイレクトの本文は読まない
          if (status >= 300 && status < 400) {
            res.resume();
            resolve({ status, headers: res.headers, body: Buffer.alloc(0) });
            return;
          }
          const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase();
          let stream: NodeJS.ReadableStream = res;
          if (encoding === "gzip") stream = res.pipe(zlib.createGunzip());
          else if (encoding === "deflate") stream = res.pipe(zlib.createInflate());
          else if (encoding === "br") stream = res.pipe(zlib.createBrotliDecompress());

          const chunks: Buffer[] = [];
          let size = 0;
          stream.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > opts.maxBytes) {
              req.destroy(new FetchError(`応答が大きすぎます（${opts.maxBytes} バイトまで）`));
              return;
            }
            chunks.push(chunk);
          });
          stream.on("end", () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks) }));
          stream.on("error", reject);
        },
      );
      req.on("timeout", () => req.destroy(new FetchError(`タイムアウトしました（${opts.timeoutMs} ms）`)));
      req.on("error", reject);
      req.end();
    },
  );
}

function decodeBody(body: Buffer, contentType: string): string {
  const charset = contentType.match(/charset=([^;]+)/i)?.[1]?.trim().toLowerCase();
  let label = charset;
  if (!label) {
    // HTML / XML の宣言から文字コードを探す（先頭 2KB だけ）
    const head = body.subarray(0, 2048).toString("latin1");
    label = head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] ?? head.match(/<\?xml[^>]+encoding=["']([\w-]+)/i)?.[1];
    label = label?.toLowerCase();
  }
  try {
    return new TextDecoder(label ?? "utf-8").decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

/** 安全確認をしながら URL を取得する（リダイレクトも確認する） */
export async function safeFetch(raw: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const opts = {
    timeoutMs: options.timeoutMs ?? LIMITS.fetchTimeoutMs,
    maxBytes: options.maxBytes ?? LIMITS.maxResponseBytes,
    maxRedirects: options.maxRedirects ?? LIMITS.maxRedirects,
    accept: options.accept ?? "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/html;q=0.8, */*;q=0.5",
    lookup: options.lookup ?? createGuardedLookup(),
  };

  let url = assertSafeUrlShape(raw);
  for (let hop = 0; hop <= opts.maxRedirects; hop++) {
    const res = await requestOnce(url, opts);
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.location;
      if (typeof location !== "string" || !location) throw new FetchError(`リダイレクト先がありません（${res.status}）`);
      url = assertSafeUrlShape(new URL(location, url).toString());
      continue;
    }
    const contentType = String(res.headers["content-type"] ?? "");
    if (res.status >= 400) throw new FetchError(`取得に失敗しました（HTTP ${res.status}）`);
    return { url: url.toString(), status: res.status, contentType, body: decodeBody(res.body, contentType) };
  }
  throw new FetchError(`リダイレクトが多すぎます（${opts.maxRedirects} 回まで）`);
}
