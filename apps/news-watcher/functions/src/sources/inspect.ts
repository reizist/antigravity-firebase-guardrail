// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0
// ==============================================================================
// 情報源の判定と記事の取得
//   利用者は URL を貼るだけ。RSS / Atom ならそのまま、HTML ならフィードを探し、
//   見つからなければ Web ページとして記事リンクを抽出する（docs/news_watcher_design.md §3.2）
// ==============================================================================

import { LIMITS } from "../config.js";
import { safeFetch, type SafeFetchResult } from "../lib/safeFetch.js";
import type { SourceDoc, SourceType } from "../types.js";
import { parseFeed, type FeedItem } from "./feed.js";
import { discoverFeedLinks, extractArticleLinks, pageTitle } from "./web.js";

export type Fetcher = (url: string) => Promise<SafeFetchResult>;

export interface InspectResult {
  type: SourceType;
  /** 実際に取りに行く URL（RSS のとき） */
  feedUrl: string | null;
  displayName: string;
  sample: { title: string; url: string }[];
}

/** Google ニュースのキーワード検索の RSS の URL */
export function googleNewsFeedUrl(query: string): string {
  const q = encodeURIComponent(query.trim());
  return `https://news.google.com/rss/search?q=${q}&hl=ja&gl=JP&ceid=JP:ja`;
}

function sampleOf(items: FeedItem[]) {
  return items
    .filter((i) => i.url && i.title)
    .slice(0, 3)
    .map((i) => ({ title: i.title, url: i.url }));
}

/** 登録された情報源を調べて、種類・取得先・サンプル記事を決める */
export async function inspectSource(source: Pick<SourceDoc, "url" | "query" | "extraction">, fetcher: Fetcher = safeFetch): Promise<InspectResult> {
  if (source.query) {
    const feedUrl = googleNewsFeedUrl(source.query);
    const res = await fetcher(feedUrl);
    const feed = parseFeed(res.body, res.url);
    if (!feed) throw new Error("Google ニュースの RSS を解析できませんでした");
    return { type: "google_news", feedUrl, displayName: `Google ニュース: ${source.query}`, sample: sampleOf(feed.items) };
  }

  const res = await fetcher(source.url);
  const feed = parseFeed(res.body, res.url);
  if (feed) {
    return { type: "rss", feedUrl: res.url, displayName: feed.title || new URL(res.url).hostname, sample: sampleOf(feed.items) };
  }

  if (!/html/i.test(res.contentType) && !/^\s*<(!doctype|html)/i.test(res.body)) {
    throw new Error(`RSS / Atom でも HTML でもありません（${res.contentType || "Content-Type なし"}）`);
  }

  // HTML: まずフィードを探す
  for (const link of discoverFeedLinks(res.body, res.url).slice(0, 3)) {
    try {
      const feedRes = await fetcher(link);
      const found = parseFeed(feedRes.body, feedRes.url);
      if (found && found.items.length > 0) {
        return {
          type: "rss",
          feedUrl: feedRes.url,
          displayName: found.title || pageTitle(res.body) || new URL(res.url).hostname,
          sample: sampleOf(found.items),
        };
      }
    } catch {
      // 見つけたフィードが取れなければ、次の候補か Web ページとして扱う
    }
  }

  // フィードがなければ Web ページとして記事リンクを抽出する
  const items = extractArticleLinks(res.body, res.url, source.extraction ?? {});
  if (items.length === 0) {
    throw new Error("記事のリンクを見つけられませんでした（CSS セレクタを指定すると取れる場合があります）");
  }
  return { type: "web", feedUrl: null, displayName: pageTitle(res.body) || new URL(res.url).hostname, sample: sampleOf(items) };
}

/** 判定済みの情報源から記事を取得する */
export async function collectItems(source: SourceDoc, fetcher: Fetcher = safeFetch): Promise<FeedItem[]> {
  const max = LIMITS.maxItemsPerSource;
  if (source.type === "web") {
    const res = await fetcher(source.url);
    return extractArticleLinks(res.body, res.url, { ...(source.extraction ?? {}), max });
  }
  const url = source.feedUrl ?? (source.query ? googleNewsFeedUrl(source.query) : source.url);
  const res = await fetcher(url);
  const feed = parseFeed(res.body, res.url);
  if (!feed) throw new Error("フィードを解析できませんでした（形式が変わった可能性があります）");
  return feed.items.filter((i) => i.url && i.title).slice(0, max);
}

/** 前回の取得から fetchIntervalMin 分たっていれば true */
export function isSourceDue(source: SourceDoc, now: Date, defaultIntervalMin = 60): boolean {
  const last = source.lastFetchedAt?.toDate();
  if (!last) return true;
  const interval = (source.fetchIntervalMin ?? defaultIntervalMin) * 60_000;
  // スケジュールの揺れを吸収するため 5 分の余裕を持たせる
  return now.getTime() - last.getTime() >= interval - 5 * 60_000;
}
