// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0
// ==============================================================================
// Gemini（Vertex AI）による関連度の採点と要約
//   - 渡すのはタイトルと RSS の概要だけ（本文は渡さない・保存しない）
//   - 出力は JSON スキーマで固定する
//   - リクエストにラベル app=news-watcher を付けて費用を集計できるようにする
// docs/news_watcher_design.md §6
// ==============================================================================

import { GoogleGenAI, Type } from "@google/genai";
import { LABELS, REGION } from "../config.js";
import type { TopicDoc } from "../types.js";

export interface ScoreInput {
  title: string;
  summary: string;
  sourceName?: string;
  url: string;
}

export interface ScoreResult {
  score: number;
  reason: string;
  summary: string;
  tags: string[];
}

export type Scorer = (article: ScoreInput, topic: Pick<TopicDoc, "name" | "description" | "keywords">) => Promise<ScoreResult>;

export const SCORE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    score: { type: Type.INTEGER, description: "トピックとの関連度（0〜100）" },
    reason: { type: Type.STRING, description: "そのスコアにした理由（日本語・1 文）" },
    summary: { type: Type.STRING, description: "記事の要約（日本語・3 行以内・120 文字程度）" },
    tags: { type: Type.ARRAY, items: { type: Type.STRING }, description: "記事の分類タグ（日本語・3 個まで）" },
  },
  required: ["score", "reason", "summary", "tags"],
  propertyOrdering: ["score", "reason", "summary", "tags"],
};

export function buildPrompt(article: ScoreInput, topic: Pick<TopicDoc, "name" | "description" | "keywords">): string {
  return [
    "あなたは社内のニュースチャンネルの編集者です。次の記事が、監視トピックにどれだけ関係するかを採点し、要約してください。",
    "記事のタイトルと概要だけから判断し、書かれていないことは推測しないでください。",
    "",
    "## 監視トピック",
    `名前: ${topic.name}`,
    `説明: ${topic.description ?? "（なし）"}`,
    `キーワード: ${(topic.keywords ?? []).join(", ") || "（なし）"}`,
    "",
    "## 記事",
    `タイトル: ${article.title}`,
    `情報源: ${article.sourceName ?? new URL(article.url).hostname}`,
    `概要: ${article.summary || "（なし）"}`,
    "",
    "## 採点の目安",
    "90〜100: トピックの中心的なニュース / 60〜89: 明確に関係する / 30〜59: 間接的に関係する / 0〜29: ほぼ無関係",
  ].join("\n");
}

/** Gemini の出力を検証し、範囲外の値を丸める */
export function parseScore(text: string): ScoreResult {
  const raw = JSON.parse(text) as Partial<ScoreResult>;
  const score = Math.max(0, Math.min(100, Math.round(Number(raw.score ?? 0))));
  return {
    score: Number.isFinite(score) ? score : 0,
    reason: String(raw.reason ?? "").slice(0, 300),
    summary: String(raw.summary ?? "").slice(0, 400),
    tags: Array.isArray(raw.tags) ? raw.tags.map(String).slice(0, 3) : [],
  };
}

/** Vertex AI の Gemini で採点する Scorer を作る */
export function createGeminiScorer(model: string, project = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT): Scorer {
  const ai = new GoogleGenAI({ vertexai: true, project, location: REGION });
  return async (article, topic) => {
    const res = await ai.models.generateContent({
      model,
      contents: buildPrompt(article, topic),
      config: {
        temperature: 0.2,
        responseMimeType: "application/json",
        responseSchema: SCORE_SCHEMA,
        labels: LABELS,
      },
    });
    const text = res.text;
    if (!text) throw new Error("Gemini の応答が空でした");
    return parseScore(text);
  };
}
