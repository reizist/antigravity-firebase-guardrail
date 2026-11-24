// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0
// ==============================================================================
// キーワードによる一次絞り込み（Gemini に渡す記事を減らしてコストを抑える）
// ==============================================================================

import type { TopicDoc } from "../types.js";

/** 全角・半角や大文字・小文字の違いをなくす */
export function normalizeText(s: string): string {
  return s.normalize("NFKC").toLowerCase();
}

export interface Candidate {
  title: string;
  summary: string;
}

/** トピックのキーワードのどれかを含み、除外キーワードを含まなければ true（キーワードが空なら常に true） */
export function matchesTopic(item: Candidate, topic: Pick<TopicDoc, "keywords" | "excludeKeywords">): boolean {
  const haystack = normalizeText(`${item.title}\n${item.summary}`);
  const excludes = (topic.excludeKeywords ?? []).map(normalizeText).filter(Boolean);
  if (excludes.some((k) => haystack.includes(k))) return false;
  const keywords = (topic.keywords ?? []).map(normalizeText).filter(Boolean);
  if (keywords.length === 0) return true;
  return keywords.some((k) => haystack.includes(k));
}
