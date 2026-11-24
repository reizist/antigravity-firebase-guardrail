// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0
// ==============================================================================
// Web ページ（フィードがない「お知らせ一覧」など）からの記事リンクの抽出
//   auto    : ページ内のリンクから「記事らしいもの」を規則で選ぶ
//   selector: CSS セレクタで記事リンクを指定する（上級者向け）
// docs/news_watcher_design.md §3.2
// ==============================================================================

import { parse } from "node-html-parser";
import type { FeedItem } from "./feed.js";

/** <link rel="alternate" type="application/rss+xml"> などからフィードの URL を見つける */
export function discoverFeedLinks(html: string, baseUrl: string): string[] {
  const root = parse(html);
  const links = root.querySelectorAll('link[rel~="alternate"]');
  const out: string[] = [];
  for (const link of links) {
    const type = (link.getAttribute("type") ?? "").toLowerCase();
    const href = link.getAttribute("href");
    if (!href) continue;
    if (!/(rss|atom|rdf)\+xml|application\/xml|text\/xml/.test(type)) continue;
    try {
      out.push(new URL(href, baseUrl).toString());
    } catch {
      // 不正な URL は無視
    }
  }
  return [...new Set(out)];
}

export function pageTitle(html: string): string {
  const root = parse(html);
  const og = root.querySelector('meta[property="og:site_name"]')?.getAttribute("content");
  return (og ?? root.querySelector("title")?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 100);
}

/** 記事ではなさそうなパス（一覧・タグ・ログインなど） */
const NON_ARTICLE_PATH =
  /\/(tag|tags|category|categories|author|authors|page|search|login|signin|signup|register|contact|about|privacy|terms|sitemap|feed|rss|help|faq)(\/|$)/i;

/** 記事らしいパス（日付・数字の ID・記事を示す語を含む） */
const ARTICLE_HINT = /(\/20\d{2}[\/-]?\d{2})|(\/\d{4,})|(\/(news|article|articles|post|posts|blog|press|release|releases|topics|info|information|entry)\/)/i;

export interface ExtractOptions {
  mode?: "auto" | "selector";
  selector?: string;
  max?: number;
}

/** 記事一覧ページから記事リンクを抽出する（タイトル・URL だけ。日付は取れれば） */
export function extractArticleLinks(html: string, baseUrl: string, options: ExtractOptions = {}): FeedItem[] {
  const max = options.max ?? 30;
  const root = parse(html);
  const base = new URL(baseUrl);

  // ナビゲーション・ヘッダー・フッターのリンクは記事ではないので除く
  for (const el of root.querySelectorAll("nav, header, footer, aside, script, style, noscript")) el.remove();

  const anchors =
    options.mode === "selector" && options.selector
      ? root.querySelectorAll(options.selector).flatMap((el) => (el.tagName === "A" ? [el] : el.querySelectorAll("a")))
      : root.querySelectorAll("a[href]");

  const seen = new Set<string>();
  const items: FeedItem[] = [];
  for (const a of anchors) {
    const href = a.getAttribute("href");
    if (!href || href.startsWith("#") || /^(javascript|mailto|tel):/i.test(href)) continue;
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }
    if (url.protocol !== "https:") continue;
    url.hash = "";
    const key = url.toString();
    if (seen.has(key) || key === base.toString()) continue;

    const title = a.text.replace(/\s+/g, " ").trim();
    if (options.mode !== "selector") {
      if (url.hostname !== base.hostname) continue; // 同じサイトの記事だけ
      if (title.length < 8) continue; // 「続きを読む」「もっと見る」などを除く
      if (NON_ARTICLE_PATH.test(url.pathname)) continue;
      const depth = url.pathname.split("/").filter(Boolean).length;
      if (!ARTICLE_HINT.test(url.pathname) && depth < 2) continue;
    } else if (!title) {
      continue;
    }

    seen.add(key);
    const dateText = a.closest("li, article, tr, div")?.querySelector("time")?.getAttribute("datetime");
    const publishedAt = dateText ? new Date(dateText) : null;
    items.push({
      title: title.slice(0, 300),
      url: key,
      publishedAt: publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt : null,
      summary: "",
    });
    if (items.length >= max) break;
  }
  return items;
}
