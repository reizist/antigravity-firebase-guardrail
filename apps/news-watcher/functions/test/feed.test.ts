// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { looksLikeFeed, parseFeed, stripHtml } from "../src/sources/feed.js";

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Example News</title>
    <item>
      <title>新製品を発表 &amp; 提供開始</title>
      <link>https://example.com/news/2026/10/30/launch</link>
      <pubDate>Thu, 29 Oct 2026 09:00:00 +0900</pubDate>
      <description><![CDATA[<p>新しい<b>クラウド</b>サービスを発表しました。</p>]]></description>
    </item>
    <item>
      <title>ガイドなし</title>
      <guid isPermaLink="true">https://example.com/news/2</guid>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Blog</title>
  <entry>
    <title>Atom の記事</title>
    <link rel="alternate" href="/posts/atom-1"/>
    <link rel="edit" href="/edit/atom-1"/>
    <updated>2026-10-28T10:00:00Z</updated>
    <summary>Atom の概要</summary>
  </entry>
</feed>`;

const RDF = `<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel><title>RDF Site</title></channel>
  <item>
    <title>RDF の記事</title>
    <link>https://rdf.example.jp/a/1</link>
    <dc:date>2026-10-27T08:00:00+09:00</dc:date>
  </item>
</rdf:RDF>`;

describe("parseFeed", () => {
  it("RSS 2.0", () => {
    const feed = parseFeed(RSS)!;
    expect(feed.title).toBe("Example News");
    expect(feed.items).toHaveLength(2);
    expect(feed.items[0]).toMatchObject({
      title: "新製品を発表 & 提供開始",
      url: "https://example.com/news/2026/10/30/launch",
      summary: "新しい クラウド サービスを発表しました。",
    });
    expect(feed.items[0]!.publishedAt?.toISOString()).toBe("2026-10-29T00:00:00.000Z");
    expect(feed.items[1]!.url).toBe("https://example.com/news/2");
  });

  it("Atom（rel=alternate のリンクを相対 URL から解決する）", () => {
    const feed = parseFeed(ATOM, "https://blog.example.com/feed.atom")!;
    expect(feed.title).toBe("Atom Blog");
    expect(feed.items[0]).toMatchObject({ title: "Atom の記事", url: "https://blog.example.com/posts/atom-1", summary: "Atom の概要" });
  });

  it("RSS 1.0（RDF）", () => {
    const feed = parseFeed(RDF)!;
    expect(feed.title).toBe("RDF Site");
    expect(feed.items[0]).toMatchObject({ title: "RDF の記事", url: "https://rdf.example.jp/a/1" });
    expect(feed.items[0]!.publishedAt?.toISOString()).toBe("2026-10-26T23:00:00.000Z");
  });

  it("HTML はフィードとして扱わない", () => {
    expect(looksLikeFeed("<!doctype html><html></html>")).toBe(false);
    expect(parseFeed("<html><body>hi</body></html>")).toBeNull();
  });
});

describe("stripHtml", () => {
  it("タグとスクリプトを除き、長さを切り詰める", () => {
    expect(stripHtml("<script>alert(1)</script><p>a   b</p>")).toBe("a b");
    expect(stripHtml("あ".repeat(600), 10)).toBe(`${"あ".repeat(9)}…`);
  });
});
