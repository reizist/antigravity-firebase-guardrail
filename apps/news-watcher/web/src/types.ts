// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0
// 画面で扱うデータの形（関数側の functions/src/types.ts に合わせる）と、全画面で共有する状態
import type { Firestore, Timestamp } from "firebase/firestore";

export type Role = "viewer" | "editor" | "admin";

export interface Source {
  id: string;
  url: string;
  displayName?: string;
  query?: string;
  tags?: string[];
  enabled?: boolean;
  fetchIntervalMin?: number;
  status: "pending" | "ok" | "error";
  type?: "rss" | "web" | "google_news";
  lastError?: string | null;
  lastFetchedAt?: Timestamp | null;
  sample?: { title: string; url: string }[];
  managedBy?: string;
  createdBy?: string;
  topicId?: string;
}

export interface Topic {
  id: string;
  name: string;
  description?: string;
  keywords: string[];
  excludeKeywords?: string[];
  autoSearch?: boolean;
  enabled: boolean;
  managedBy?: string;
}

export interface Digest {
  id: string;
  name: string;
  topicIds: string[];
  maxItems: number;
  minScore: number;
  cron: string;
  channelId: string;
  enabled: boolean;
  lastRunAt?: Timestamp | null;
  managedBy?: string;
}

export interface Channel {
  id: string;
  type: "google_chat" | "slack";
  displayName?: string;
}

export interface Article {
  id: string;
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
}

export interface Delivery {
  id: string;
  digestId?: string;
  topicId?: string | null;
  channelId: string;
  articleIds: string[];
  postedAt: Timestamp;
  status: "ok" | "error";
  error: string | null;
  trigger: "digest" | "manual";
  requestedBy?: string;
}

export interface AppState {
  db: Firestore;
  uid: string;
  email: string;
  role: Role;
  topics: Map<string, Topic>;
  sources: Map<string, Source>;
  channels: Map<string, Channel>;
  digests: Map<string, Digest>;
  /** 自分のフィードバック（articleId → up / down） */
  votes: Map<string, "up" | "down">;
}

export const canEdit = (s: AppState) => s.role === "editor" || s.role === "admin";
