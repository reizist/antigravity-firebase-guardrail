// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0
// ==============================================================================
// トピックの自動検索（§5.2）と、定期配信で送る記事の選び方（§5.3）— Firestore に依存しない純粋な関数
// ==============================================================================

import { googleNewsFeedUrl } from "../sources/inspect.js";
import type { ArticleDoc, DigestDoc, TopicDoc } from "../types.js";

/** 検索語に使うキーワードの上限（長すぎる検索語は Google ニュースで結果が出にくい） */
export const MAX_SEARCH_KEYWORDS = 8;

export const AUTO_SOURCE_PREFIX = "topic-";
export const autoSourceId = (topicId: string) => `${AUTO_SOURCE_PREFIX}${topicId}`;

/** トピックのキーワードから Google ニュースの検索語を作る（空白を含む語は "..." で囲み、OR でつなぐ） */
export function topicSearchQuery(keywords: string[]): string {
  return keywords
    .map((k) => k.trim())
    .filter(Boolean)
    .slice(0, MAX_SEARCH_KEYWORDS)
    .map((k) => (/\s/.test(k) ? `"${k.replace(/"/g, "")}"` : k))
    .join(" OR ");
}

/** トピックから自動で作る情報源の、関数が持ち主の項目。作らない（消す）ときは null */
export function autoSourceFields(topicId: string, topic: TopicDoc | undefined) {
  if (!topic) return null;
  const query = topicSearchQuery(topic.keywords ?? []);
  if (!query) return null;
  return {
    url: googleNewsFeedUrl(query),
    query,
    displayName: `トピック「${topic.name}」の Google ニュース`,
    enabled: topic.enabled !== false && topic.autoSearch !== false,
    fetchIntervalMin: 60,
    tags: [topic.name],
    managedBy: "topic",
    topicId,
  };
}

export interface DigestPick {
  id: string;
  article: ArticleDoc;
  /** 対象トピックのうち、スコアが最も高いもの */
  topicId: string;
  score: number;
}

/**
 * 定期配信で送る記事を選ぶ：対象トピックのどれかのスコアが minScore 以上・lookbackDays 以内に取得・
 * まだこの設定で配信していないものを、スコアの高い順（同点なら新しい順）に maxItems 件
 */
export function selectDigestItems(
  candidates: { id: string; article: ArticleDoc }[],
  digestId: string,
  digest: Pick<DigestDoc, "topicIds" | "minScore" | "maxItems">,
  now: Date,
  lookbackDays: number,
): DigestPick[] {
  const since = now.getTime() - lookbackDays * 86_400_000;
  const seen = new Set<string>();
  const picks: DigestPick[] = [];
  for (const { id, article } of candidates) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (article.deliveredTo?.includes(digestId)) continue;
    if (!article.fetchedAt || article.fetchedAt.toMillis() < since) continue;
    let best: { topicId: string; score: number } | null = null;
    for (const t of digest.topicIds) {
      const s = article.scores?.[t];
      if (typeof s === "number" && s >= digest.minScore && (!best || s > best.score)) best = { topicId: t, score: s };
    }
    if (best) picks.push({ id, article, ...best });
  }
  picks.sort((x, y) => y.score - x.score || y.article.fetchedAt.toMillis() - x.article.fetchedAt.toMillis());
  return picks.slice(0, digest.maxItems);
}
