import { describe, expect, it } from "vitest";
import { discoverFeedLinks, extractArticleLinks, pageTitle } from "../src/sources/web.js";

const PAGE = `<!doctype html>
<html><head>
  <title>Example Corp | お知らせ</title>
  <link rel="alternate" type="application/rss+xml" href="/feed.xml">
  <link rel="alternate" type="text/html" href="/en/">
  <link rel="stylesheet" href="/a.css">
</head>
<body>
  <header><a href="/about/company">会社概要の長いリンクテキスト</a></header>
  <nav><a href="/news/category/press">プレスリリース一覧へのリンク</a></nav>
  <main>
    <ul class="news-list">
      <li><time datetime="2026-10-29">2026/10/29</time><a href="/news/2026/10/29/new-service">新サービスの提供を開始しました</a></li>
      <li><a href="/news/12345">決算説明会の資料を公開しました</a></li>
      <li><a href="/news/12345#detail">決算説明会の資料を公開しました（重複）</a></li>
      <li><a href="https://other.example.net/news/1">外部サイトの記事へのリンクです</a></li>
      <li><a href="/news/tag/ai">AI タグの一覧ページへのリンク</a></li>
      <li><a href="/x">短い</a></li>
      <li><a href="javascript:void(0)">JavaScript のリンクは無視します</a></li>
    </ul>
  </main>
  <footer><a href="/privacy/policy-detail">プライバシーポリシーの詳細ページ</a></footer>
</body></html>`;

describe("discoverFeedLinks", () => {
  it("RSS / Atom の alternate リンクだけを絶対 URL で返す", () => {
    expect(discoverFeedLinks(PAGE, "https://corp.example.com/news/")).toEqual(["https://corp.example.com/feed.xml"]);
  });
});

describe("pageTitle", () => {
  it("title を返す", () => {
    expect(pageTitle(PAGE)).toBe("Example Corp | お知らせ");
  });
});

describe("extractArticleLinks", () => {
  it("auto：同じサイトの記事らしいリンクだけを選ぶ（ナビ・フッター・タグ一覧・短いリンク・重複を除く）", () => {
    const items = extractArticleLinks(PAGE, "https://corp.example.com/news/");
    expect(items.map((i) => i.url)).toEqual([
      "https://corp.example.com/news/2026/10/29/new-service",
      "https://corp.example.com/news/12345",
    ]);
    expect(items[0]!.publishedAt?.toISOString()).toBe("2026-10-29T00:00:00.000Z");
  });

  it("selector：指定した要素のリンクだけを選ぶ（外部サイトも含める）", () => {
    const items = extractArticleLinks(PAGE, "https://corp.example.com/news/", { mode: "selector", selector: "ul.news-list li:nth-child(4)" });
    expect(items.map((i) => i.url)).toEqual(["https://other.example.net/news/1"]);
  });
});
