import { describe, expect, it } from "vitest";
import type { SafeFetchResult } from "../src/lib/safeFetch.js";
import { collectItems, googleNewsFeedUrl, inspectSource, isSourceDue } from "../src/sources/inspect.js";
import type { SourceDoc } from "../src/types.js";

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed Title</title>
<item><title>記事 1</title><link>https://example.com/1</link></item>
<item><title>記事 2</title><link>https://example.com/2</link></item></channel></rss>`;

const HTML_WITH_FEED = `<html><head><title>Site</title><link rel="alternate" type="application/rss+xml" href="/rss"></head><body></body></html>`;
const HTML_NO_FEED = `<html><head><title>お知らせ</title></head><body><main>
<a href="/info/2026/10/a">お知らせ A の本文へのリンクです</a></main></body></html>`;

function fakeFetcher(pages: Record<string, { body: string; contentType: string }>) {
  const calls: string[] = [];
  const fetcher = async (url: string): Promise<SafeFetchResult> => {
    calls.push(url);
    const page = pages[url];
    if (!page) throw new Error(`not found: ${url}`);
    return { url, status: 200, ...page };
  };
  return { fetcher, calls };
}

describe("inspectSource", () => {
  it("RSS の URL ならそのまま rss", async () => {
    const { fetcher } = fakeFetcher({ "https://example.com/feed": { body: RSS, contentType: "application/rss+xml" } });
    const r = await inspectSource({ url: "https://example.com/feed" }, fetcher);
    expect(r).toMatchObject({ type: "rss", feedUrl: "https://example.com/feed", displayName: "Feed Title" });
    expect(r.sample).toHaveLength(2);
  });

  it("HTML からフィードを見つけたら rss（取得先は見つけたフィード）", async () => {
    const { fetcher } = fakeFetcher({
      "https://example.com/": { body: HTML_WITH_FEED, contentType: "text/html" },
      "https://example.com/rss": { body: RSS, contentType: "application/xml" },
    });
    const r = await inspectSource({ url: "https://example.com/" }, fetcher);
    expect(r).toMatchObject({ type: "rss", feedUrl: "https://example.com/rss" });
  });

  it("フィードがなければ web", async () => {
    const { fetcher } = fakeFetcher({ "https://example.jp/info/": { body: HTML_NO_FEED, contentType: "text/html; charset=utf-8" } });
    const r = await inspectSource({ url: "https://example.jp/info/" }, fetcher);
    expect(r).toMatchObject({ type: "web", feedUrl: null, displayName: "お知らせ" });
    expect(r.sample[0]!.url).toBe("https://example.jp/info/2026/10/a");
  });

  it("検索語があれば google_news", async () => {
    const url = googleNewsFeedUrl("生成AI 規制");
    const { fetcher, calls } = fakeFetcher({ [url]: { body: RSS, contentType: "application/rss+xml" } });
    const r = await inspectSource({ url: "https://news.google.com/", query: "生成AI 規制" }, fetcher);
    expect(r.type).toBe("google_news");
    expect(calls[0]).toContain("q=%E7%94%9F%E6%88%90AI%20%E8%A6%8F%E5%88%B6");
  });

  it("記事が見つからなければエラー", async () => {
    const { fetcher } = fakeFetcher({ "https://example.jp/": { body: "<html><body>なし</body></html>", contentType: "text/html" } });
    await expect(inspectSource({ url: "https://example.jp/" }, fetcher)).rejects.toThrow("記事のリンク");
  });
});

describe("collectItems", () => {
  it("rss は feedUrl から取得する", async () => {
    const { fetcher, calls } = fakeFetcher({ "https://example.com/rss": { body: RSS, contentType: "application/xml" } });
    const items = await collectItems({ url: "https://example.com/", feedUrl: "https://example.com/rss", type: "rss", status: "ok" }, fetcher);
    expect(items).toHaveLength(2);
    expect(calls).toEqual(["https://example.com/rss"]);
  });
});

describe("isSourceDue", () => {
  const ts = (d: Date) => ({ toDate: () => d }) as unknown as SourceDoc["lastFetchedAt"];
  const now = new Date("2026-10-30T10:00:00Z");

  it("一度も取得していなければ true", () => {
    expect(isSourceDue({ url: "", status: "ok" }, now)).toBe(true);
  });

  it("間隔（5 分の余裕込み）を過ぎていれば true", () => {
    expect(isSourceDue({ url: "", status: "ok", lastFetchedAt: ts(new Date("2026-10-30T09:04:00Z")) }, now)).toBe(true);
    expect(isSourceDue({ url: "", status: "ok", lastFetchedAt: ts(new Date("2026-10-30T09:30:00Z")) }, now)).toBe(false);
    expect(isSourceDue({ url: "", status: "ok", fetchIntervalMin: 30, lastFetchedAt: ts(new Date("2026-10-30T09:30:00Z")) }, now)).toBe(true);
  });
});
