// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0
// ==============================================================================
// news-watcher の関数（codebase: news-watcher）
//   - すべてアプリ名のグループ newsWatcher で export する → 関数名は newsWatcher-<名前>
//   - すべて実行 SA app-news-watcher@・asia-northeast1・maxInstances・ラベル app=news-watcher を指定する
//   - HTTP 関数（onRequest / onCall）は作らない（Tier 0 のルール）
// docs/platform_design.md §3.1 / §5、docs/news_watcher_design.md §4
// ==============================================================================

import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import { onDocumentCreated, onDocumentWritten } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import {
  APP_URL,
  DATABASE_ID,
  DEFAULT_GEMINI_MODEL,
  LABELS,
  REGION,
  RUNTIME_SERVICE_ACCOUNT,
  TIME_ZONE,
  WEBHOOK_SECRET_NAMES,
} from "./config.js";
import {
  handleDigestRun,
  handleShareRequest,
  handleSourceWritten,
  handleSuggestRequest,
  handleTopicWritten,
  runDeliverDigests,
  runFetchSources,
} from "./handlers.js";
import { createGeminiScorer } from "./scoring/gemini.js";
import { createGeminiSuggester } from "./scoring/suggest.js";
import type { AppConfigDoc, DigestRunDoc, ShareRequestDoc, SourceDoc, SuggestRequestDoc, TopicDoc } from "./types.js";

initializeApp();
const db = () => getFirestore(DATABASE_ID);

const webhookSecrets = WEBHOOK_SECRET_NAMES.map((name) => defineSecret(name));
const readSecret = (name: string) => webhookSecrets.find((s) => s.name === name)?.value() ?? "";
const appUrl = () => APP_URL;

/** 全関数に共通の設定（CI のポリシーチェックで、これらの指定を必須にする） */
const common = {
  region: REGION,
  serviceAccount: RUNTIME_SERVICE_ACCOUNT,
  labels: LABELS,
  maxInstances: 2,
  memory: "512MiB",
} as const;

async function loadConfig(): Promise<AppConfigDoc> {
  const snap = await db().collection("config").doc("app").get();
  return (snap.data() as AppConfigDoc | undefined) ?? {};
}

export const newsWatcher = {
  /** 情報源が追加・変更されたら（status = pending）、種類を判定してサンプル記事を取る */
  onSourceWritten: onDocumentWritten(
    { ...common, document: "sources/{sourceId}", database: DATABASE_ID, timeoutSeconds: 60 },
    async (event) => {
      const after = event.data?.after.exists ? (event.data.after.data() as SourceDoc) : undefined;
      await handleSourceWritten({ db: db() }, event.params.sourceId, after);
    },
  ),

  /** トピックが追加・変更・削除されたら、そのキーワードで Google ニュースを検索する情報源を作り直す（§5.2） */
  onTopicWritten: onDocumentWritten(
    { ...common, document: "topics/{topicId}", database: DATABASE_ID, timeoutSeconds: 60 },
    async (event) => {
      const after = event.data?.after.exists ? (event.data.after.data() as TopicDoc) : undefined;
      await handleTopicWritten({ db: db() }, event.params.topicId, after);
    },
  ),

  /** 毎時：情報源から記事を集め、キーワードで絞り込んだものを Gemini で採点・要約する */
  fetchSources: onSchedule(
    { ...common, schedule: "every 60 minutes", timeZone: TIME_ZONE, timeoutSeconds: 540, retryCount: 0 },
    async () => {
      const config = await loadConfig();
      const scorer = createGeminiScorer(config.geminiModel ?? DEFAULT_GEMINI_MODEL);
      await runFetchSources({ db: db(), scorer, maxArticlesPerRun: config.maxArticlesPerRun });
    },
  ),

  /** 15 分ごと：配信時刻になった定期配信の設定（digests）ごとに、スコアの高い記事を N 件投稿する（§5.3） */
  deliverDigests: onSchedule(
    { ...common, schedule: "every 15 minutes", timeZone: TIME_ZONE, timeoutSeconds: 300, retryCount: 0, secrets: webhookSecrets },
    async () => {
      await runDeliverDigests({ db: db(), readSecret, appUrl: appUrl(), windowMinutes: 15 });
    },
  ),

  /** 「今すぐ共有」：shareRequests が作られたら、その記事を投稿する */
  onShareRequest: onDocumentCreated(
    { ...common, document: "shareRequests/{requestId}", database: DATABASE_ID, timeoutSeconds: 60, secrets: webhookSecrets },
    async (event) => {
      const req = event.data?.data() as ShareRequestDoc | undefined;
      if (!req) return;
      await handleShareRequest({ db: db(), readSecret, appUrl: appUrl() }, event.params.requestId, req);
    },
  ),

  /** 情報源の提案：sourceSuggestions が作られたら、Gemini にトピックに合う情報源を挙げさせ、実在を確かめて候補を書く（§5.4） */
  onSuggestRequest: onDocumentCreated(
    { ...common, document: "sourceSuggestions/{requestId}", database: DATABASE_ID, timeoutSeconds: 300 },
    async (event) => {
      const req = event.data?.data() as SuggestRequestDoc | undefined;
      if (!req) return;
      const config = await loadConfig();
      await handleSuggestRequest({ db: db(), suggester: createGeminiSuggester(config.geminiModel ?? DEFAULT_GEMINI_MODEL) }, event.params.requestId, req);
    },
  ),

  /** 今すぐ配信：digestRuns が作られたら、画面で選んだ記事を配信設定の配信先に投稿する（§5.3） */
  onDigestRun: onDocumentCreated(
    { ...common, document: "digestRuns/{runId}", database: DATABASE_ID, timeoutSeconds: 60, secrets: webhookSecrets },
    async (event) => {
      const req = event.data?.data() as DigestRunDoc | undefined;
      if (!req) return;
      await handleDigestRun({ db: db(), readSecret, appUrl: appUrl() }, event.params.runId, req);
    },
  ),
};
