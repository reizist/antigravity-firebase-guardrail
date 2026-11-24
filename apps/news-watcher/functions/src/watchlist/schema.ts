// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0
// ==============================================================================
// watchlist.yaml の読み込みと検証
//   YAML を正として Firestore に sync するための「あるべき姿」を作る（docs/news_watcher_design.md §5.1）
// ==============================================================================

import { parse } from "yaml";
import { WEBHOOK_SECRET_NAMES } from "../config.js";
import { parseCron } from "../digest/cron.js";
import { assertSafeUrlShape } from "../lib/safeFetch.js";
import { googleNewsFeedUrl } from "../sources/inspect.js";

/** sync が書き込む項目（YAML が持ち主の項目）。関数が書く項目（type / feedUrl / sample など）には触らない */
export const OWNED_FIELDS = {
  channels: ["type", "displayName", "secretName"],
  sources: ["url", "query", "displayName", "extraction", "tags", "enabled", "fetchIntervalMin"],
  topics: ["name", "description", "keywords", "excludeKeywords", "sourceIds", "autoSearch", "enabled"],
  digests: ["name", "topicIds", "maxItems", "minScore", "cron", "channelId", "enabled"],
} as const;

export type Collection = keyof typeof OWNED_FIELDS;
export const COLLECTIONS: Collection[] = ["channels", "sources", "topics", "digests"];

export type DocData = Record<string, unknown>;
export type Watchlist = Record<Collection, Record<string, DocData>>;

export class WatchlistError extends Error {
  constructor(public readonly problems: string[]) {
    super(`watchlist.yaml に問題があります:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "WatchlistError";
  }
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string" && s.trim() !== "");
}

/** undefined の項目を取り除く（Firestore では「項目なし」として扱う） */
function compact(obj: DocData): DocData {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/** YAML の文字列を読み込み、検証して Firestore に書く形にする。問題があれば WatchlistError */
export function parseWatchlist(text: string): Watchlist {
  const raw = parse(text) as unknown;
  const problems: string[] = [];
  const out: Watchlist = { channels: {}, sources: {}, topics: {}, digests: {} };
  if (!isRecord(raw)) throw new WatchlistError(["YAML の最上位はマップ（channels / sources / topics / digests）にしてください"]);

  for (const key of Object.keys(raw)) {
    if (!(COLLECTIONS as string[]).includes(key)) problems.push(`不明な項目です: ${key}（channels / sources / topics / digests のどれか）`);
  }

  const section = (name: Collection): [string, Record<string, unknown>][] => {
    const s = raw[name];
    if (s === undefined || s === null) return [];
    if (!isRecord(s)) {
      problems.push(`${name} はマップにしてください`);
      return [];
    }
    return Object.entries(s).flatMap(([id, v]) => {
      if (!ID_RE.test(id)) problems.push(`${name}.${id}: キーは英小文字・数字・ハイフン（63 文字まで）にしてください`);
      if (!isRecord(v)) {
        problems.push(`${name}.${id}: 中身はマップにしてください`);
        return [];
      }
      const allowed = OWNED_FIELDS[name] as readonly string[];
      for (const k of Object.keys(v)) if (!allowed.includes(k)) problems.push(`${name}.${id}: 不明な項目です: ${k}`);
      return [[id, v] as [string, Record<string, unknown>]];
    });
  };

  // ---- channels ----
  for (const [id, c] of section("channels")) {
    if (c.type !== "google_chat" && c.type !== "slack") problems.push(`channels.${id}.type は google_chat か slack にしてください`);
    if (typeof c.secretName !== "string" || !(WEBHOOK_SECRET_NAMES as readonly string[]).includes(c.secretName)) {
      problems.push(`channels.${id}.secretName は ${WEBHOOK_SECRET_NAMES.join(" / ")} のどれかにしてください（functions/src/config.ts）`);
    }
    if (c.displayName !== undefined && typeof c.displayName !== "string") problems.push(`channels.${id}.displayName は文字列にしてください`);
    out.channels[id] = compact({ type: c.type, displayName: c.displayName, secretName: c.secretName });
  }

  // ---- sources ----
  for (const [id, s] of section("sources")) {
    const hasUrl = typeof s.url === "string" && s.url !== "";
    const hasQuery = typeof s.query === "string" && s.query.trim() !== "";
    if (hasUrl === hasQuery) problems.push(`sources.${id}: url か query のどちらか一方を書いてください`);
    if (hasUrl) {
      try {
        assertSafeUrlShape(s.url as string);
      } catch (e) {
        problems.push(`sources.${id}.url: ${(e as Error).message}`);
      }
    }
    if (s.extraction !== undefined) {
      const ex = s.extraction;
      if (!isRecord(ex) || (ex.mode !== "auto" && ex.mode !== "selector")) {
        problems.push(`sources.${id}.extraction.mode は auto か selector にしてください`);
      } else if (ex.mode === "selector" && (typeof ex.selector !== "string" || ex.selector === "")) {
        problems.push(`sources.${id}.extraction.selector を書いてください`);
      }
    }
    if (s.tags !== undefined && !(stringList(s.tags) && s.tags.length <= 10)) problems.push(`sources.${id}.tags は文字列のリスト（10 個まで）にしてください`);
    if (s.enabled !== undefined && typeof s.enabled !== "boolean") problems.push(`sources.${id}.enabled は true / false にしてください`);
    if (
      s.fetchIntervalMin !== undefined &&
      !(Number.isInteger(s.fetchIntervalMin) && (s.fetchIntervalMin as number) >= 30 && (s.fetchIntervalMin as number) <= 1440)
    ) {
      problems.push(`sources.${id}.fetchIntervalMin は 30〜1440 の整数にしてください`);
    }
    out.sources[id] = compact({
      // google_news は検索語から作った RSS の URL を url に入れておく（Rules と画面のため）
      url: hasQuery ? googleNewsFeedUrl(s.query as string) : s.url,
      query: hasQuery ? (s.query as string).trim() : undefined,
      displayName: s.displayName,
      extraction: s.extraction,
      tags: s.tags,
      enabled: s.enabled ?? true,
      fetchIntervalMin: s.fetchIntervalMin,
    });
  }

  // ---- topics ----
  for (const [id, t] of section("topics")) {
    if (typeof t.name !== "string" || t.name === "") problems.push(`topics.${id}.name を書いてください`);
    if (t.keywords !== undefined && !(stringList(t.keywords) && t.keywords.length <= 50)) problems.push(`topics.${id}.keywords は文字列のリスト（50 個まで）にしてください`);
    if (t.excludeKeywords !== undefined && !stringList(t.excludeKeywords)) problems.push(`topics.${id}.excludeKeywords は文字列のリストにしてください`);
    if (t.sourceIds !== undefined) {
      if (!stringList(t.sourceIds)) problems.push(`topics.${id}.sourceIds は文字列のリストにしてください`);
      else for (const sid of t.sourceIds) if (!(sid in out.sources)) problems.push(`topics.${id}.sourceIds: 情報源 ${sid} が sources にありません`);
    }
    if (t.autoSearch !== undefined && typeof t.autoSearch !== "boolean") problems.push(`topics.${id}.autoSearch は true / false にしてください`);
    if (t.enabled !== undefined && typeof t.enabled !== "boolean") problems.push(`topics.${id}.enabled は true / false にしてください`);
    out.topics[id] = compact({
      name: t.name,
      description: t.description,
      keywords: t.keywords ?? [],
      excludeKeywords: t.excludeKeywords,
      sourceIds: t.sourceIds,
      autoSearch: t.autoSearch ?? true,
      enabled: t.enabled ?? true,
    });
  }

  // ---- digests（定期配信の設定。docs/news_watcher_design.md §5.3） ----
  for (const [id, d] of section("digests")) {
    if (typeof d.name !== "string" || d.name === "") problems.push(`digests.${id}.name を書いてください`);
    if (!(stringList(d.topicIds) && d.topicIds.length >= 1 && d.topicIds.length <= 10)) {
      problems.push(`digests.${id}.topicIds はトピックのキーのリスト（1〜10 個）にしてください`);
    } else {
      for (const t of d.topicIds) if (!(t in out.topics)) problems.push(`digests.${id}.topicIds: トピック ${t} が topics にありません`);
    }
    const maxItems = d.maxItems ?? 10;
    if (!(Number.isInteger(maxItems) && (maxItems as number) >= 1 && (maxItems as number) <= 30)) problems.push(`digests.${id}.maxItems は 1〜30 の整数にしてください`);
    const minScore = d.minScore ?? 60;
    if (!(Number.isInteger(minScore) && (minScore as number) >= 0 && (minScore as number) <= 100)) problems.push(`digests.${id}.minScore は 0〜100 の整数にしてください`);
    try {
      parseCron(String(d.cron ?? ""));
    } catch (e) {
      problems.push(`digests.${id}.cron: ${(e as Error).message}`);
    }
    if (!(typeof d.channelId === "string" && d.channelId in out.channels)) problems.push(`digests.${id}.channelId: 配信先 ${String(d.channelId)} が channels にありません`);
    if (d.enabled !== undefined && typeof d.enabled !== "boolean") problems.push(`digests.${id}.enabled は true / false にしてください`);
    out.digests[id] = compact({
      name: d.name,
      topicIds: d.topicIds,
      maxItems,
      minScore,
      cron: d.cron !== undefined ? String(d.cron) : undefined,
      channelId: d.channelId,
      enabled: d.enabled ?? true,
    });
  }

  if (problems.length > 0) throw new WatchlistError(problems);
  return out;
}
