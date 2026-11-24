// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0
// ==============================================================================
// トピックに合う情報源（RSS・ニュースサイト）を Gemini に提案させる（docs/news_watcher_design.md §5.4）
//   - Google 検索のグラウンディングを使い、実在するサイトを挙げさせる（使えなければグラウンディングなしで再試行）
//   - 提案された URL は必ず safeFetch で取りに行って確かめる（存在しない・RSS がない・内部 IP は落とす）
// ==============================================================================

import { GoogleGenAI } from "@google/genai";
import { LABELS, REGION } from "../config.js";
import type { TopicDoc } from "../types.js";

export interface SourceSuggestion {
  url: string;
  title: string;
  reason: string;
}

export type SourceSuggester = (topic: Pick<TopicDoc, "name" | "description" | "keywords">) => Promise<SourceSuggestion[]>;

export const MAX_SUGGESTIONS = 10;

export function buildSuggestPrompt(topic: Pick<TopicDoc, "name" | "description" | "keywords">): string {
  return [
    "あなたは社内のニュース収集アプリの編集者です。次の監視トピックについて、継続的に記事を集めるのに適した情報源を提案してください。",
    "",
    "## 監視トピック",
    `名前: ${topic.name}`,
    `説明: ${topic.description ?? "（なし）"}`,
    `キーワード: ${(topic.keywords ?? []).join(", ") || "（なし）"}`,
    "",
    "## 条件",
    `- 実在し、現在も更新されている情報源を最大 ${MAX_SUGGESTIONS} 件。公式ブログ、専門メディア、報道機関のカテゴリページなど`,
    "- RSS / Atom フィードの URL が分かればそれを、分からなければ記事一覧ページの URL を書く（https:// で始まるもの）",
    "- 日本語と英語の情報源を混ぜてよい。SNS のアカウント、有料会員限定のページ、Google ニュース自体は除く",
    "",
    "## 出力",
    "次の形の JSON 配列だけを出力する（説明文は付けない）:",
    '[{"url": "https://...", "title": "情報源の名前", "reason": "このトピックに合う理由（日本語・1 文）"}]',
  ].join("\n");
}

/** Gemini の応答から JSON 配列を取り出して検証する（コードブロックや前後の文があっても読む） */
export function parseSuggestions(text: string): SourceSuggestion[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: SourceSuggestion[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const { url, title, reason } = r as Record<string, unknown>;
    if (typeof url !== "string" || !/^https:\/\/[^\s]+$/.test(url)) continue;
    const key = url.replace(/\/+$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url, title: String(title ?? "").slice(0, 100), reason: String(reason ?? "").slice(0, 300) });
    if (out.length >= MAX_SUGGESTIONS) break;
  }
  return out;
}

export function createGeminiSuggester(model: string, project = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT): SourceSuggester {
  const ai = new GoogleGenAI({ vertexai: true, project, location: REGION });
  return async (topic) => {
    const contents = buildSuggestPrompt(topic);
    let text: string | undefined;
    try {
      const res = await ai.models.generateContent({
        model,
        contents,
        config: { temperature: 0.3, tools: [{ googleSearch: {} }], labels: LABELS },
      });
      text = res.text;
    } catch {
      // グラウンディングが使えない環境・モデルでは、なしで再試行する（URL はどのみち後で確かめる）
      const res = await ai.models.generateContent({ model, contents, config: { temperature: 0.3, labels: LABELS } });
      text = res.text;
    }
    if (!text) throw new Error("Gemini の応答が空でした");
    return parseSuggestions(text);
  };
}
