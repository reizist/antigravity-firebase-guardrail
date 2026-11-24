// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0
import type { Timestamp } from "firebase-admin/firestore";

// ==============================================================================
// Firestore のドキュメントの形（docs/news_watcher_design.md §5）
// ==============================================================================

export type SourceType = "rss" | "web" | "google_news";
export type SourceStatus = "pending" | "ok" | "error";

export interface SourceDoc {
  url: string;
  displayName?: string;
  /** google_news のときの検索語 */
  query?: string;
  extraction?: { mode: "auto" | "selector"; selector?: string };
  tags?: string[];
  enabled?: boolean;
  fetchIntervalMin?: number;
  status: SourceStatus;
  // 以下は関数だけが書く
  type?: SourceType;
  feedUrl?: string;
  lastError?: string | null;
  lastFetchedAt?: Timestamp | null;
  checkedAt?: Timestamp;
  sample?: { title: string; url: string }[];
  createdBy?: string;
  /** "yaml"（watchlist.yaml）/ "topic"（トピックから自動で作ったもの）/ なし（画面から追加） */
  managedBy?: string;
  /** トピックから自動で作った情報源のとき、そのトピック（この情報源の記事はこのトピックだけで採点する） */
  topicId?: string;
}

export interface TopicDoc {
  name: string;
  description?: string;
  keywords: string[];
  excludeKeywords?: string[];
  /** 空なら全情報源 */
  sourceIds?: string[];
  /** キーワードから Google ニュース検索の情報源を自動で作る（既定 true。docs/news_watcher_design.md §5.2） */
  autoSearch?: boolean;
  enabled: boolean;
}

/** 定期配信の設定（どのトピックの記事を・何件・いつ・どこへ。docs/news_watcher_design.md §5.3） */
export interface DigestDoc {
  name: string;
  topicIds: string[];
  maxItems: number;
  minScore: number;
  /** cron 形式・Asia/Tokyo。例: "0 9 * * 1-5" */
  cron: string;
  channelId: string;
  enabled: boolean;
  lastRunAt?: Timestamp | null;
}

export interface ChannelDoc {
  type: "google_chat" | "slack";
  displayName?: string;
  /** Secret Manager のシークレット名（Webhook URL そのものは保存しない） */
  secretName: string;
}

export interface ArticleDoc {
  url: string;
  title: string;
  sourceId: string;
  sourceName?: string;
  publishedAt: Timestamp | null;
  fetchedAt: Timestamp;
  summary: string;
  tags: string[];
  scores: Record<string, number>;
  reasons: Record<string, string>;
  deliveredTo: string[];
  expireAt: Timestamp;
}

export interface ShareRequestDoc {
  articleId: string;
  channelId: string;
  comment?: string;
  requestedBy: string;
  status: "pending" | "done" | "error";
}

export interface AppConfigDoc {
  geminiModel?: string;
  maxArticlesPerRun?: number;
}

/** 情報源の提案の依頼（画面から作る。関数が candidates を書く。§5.4） */
export interface SuggestRequestDoc {
  topicId: string;
  requestedBy: string;
  status: "pending" | "done" | "error";
}

/** 配信設定の「今すぐ配信」の依頼（画面でプレビューして選んだ記事。§5.3） */
export interface DigestRunDoc {
  digestId: string;
  articleIds: string[];
  requestedBy: string;
  status: "pending" | "done" | "error";
}
