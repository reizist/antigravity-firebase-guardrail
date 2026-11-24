import { Timestamp } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";
import { autoSourceFields, selectDigestItems, topicSearchQuery } from "../src/digest/select.js";
import type { ArticleDoc } from "../src/types.js";

const now = new Date("2026-11-12T00:00:00Z");
const hoursAgo = (h: number) => Timestamp.fromMillis(now.getTime() - h * 3_600_000);
const article = (scores: Record<string, number>, opts: Partial<ArticleDoc> = {}): ArticleDoc =>
  ({ url: "https://example.com", title: "t", sourceId: "s", publishedAt: null, fetchedAt: hoursAgo(1), summary: "", tags: [], scores, reasons: {}, deliveredTo: [], expireAt: hoursAgo(-1000), ...opts }) as ArticleDoc;

describe("topicSearchQuery / autoSourceFields", () => {
  it("キーワードを OR でつなぎ、空白を含む語は引用符で囲む。8 個まで", () => {
    expect(topicSearchQuery(["生成AI", " LLM ", "", "AI エージェント"])).toBe('生成AI OR LLM OR "AI エージェント"');
    expect(topicSearchQuery(Array.from({ length: 10 }, (_, i) => `k${i}`)).split(" OR ")).toHaveLength(8);
  });

  it("トピックから情報源を作る。キーワードがない・トピックが消えたら null。停止中・autoSearch=false なら無効", () => {
    const f = autoSourceFields("ai", { name: "AI", keywords: ["Gemini"], enabled: true });
    expect(f).toMatchObject({ query: "Gemini", enabled: true, managedBy: "topic", topicId: "ai", fetchIntervalMin: 60 });
    expect(f!.url).toContain("news.google.com/rss/search?q=Gemini");
    expect(autoSourceFields("ai", { name: "AI", keywords: [], enabled: true })).toBeNull();
    expect(autoSourceFields("ai", undefined)).toBeNull();
    expect(autoSourceFields("ai", { name: "AI", keywords: ["x"], enabled: false })!.enabled).toBe(false);
    expect(autoSourceFields("ai", { name: "AI", keywords: ["x"], enabled: true, autoSearch: false })!.enabled).toBe(false);
  });
});

describe("selectDigestItems", () => {
  const digest = { topicIds: ["a", "b"], minScore: 60, maxItems: 2 };

  it("対象トピックの最高スコアで並べ、しきい値・期間・配信済み・重複を除いて N 件", () => {
    const picks = selectDigestItems(
      [
        { id: "low", article: article({ a: 50, b: 55 }) },
        { id: "mid", article: article({ a: 70 }) },
        { id: "high", article: article({ a: 65, b: 90 }) },
        { id: "high", article: article({ a: 65, b: 90 }) }, // 2 つのトピックの検索で重複して来る
        { id: "other", article: article({ c: 99 }) }, // 対象外のトピック
        { id: "old", article: article({ a: 95 }, { fetchedAt: hoursAgo(24 * 8) }) },
        { id: "sent", article: article({ a: 99 }, { deliveredTo: ["morning"] }) },
        { id: "sentElsewhere", article: article({ a: 61 }, { deliveredTo: ["evening"] }) },
      ],
      "morning",
      digest,
      now,
      7,
    );
    expect(picks.map((p) => [p.id, p.topicId, p.score])).toEqual([
      ["high", "b", 90],
      ["mid", "a", 70],
    ]);
  });

  it("同じスコアなら新しく取得したものを先にする", () => {
    const picks = selectDigestItems(
      [
        { id: "older", article: article({ a: 80 }, { fetchedAt: hoursAgo(5) }) },
        { id: "newer", article: article({ a: 80 }, { fetchedAt: hoursAgo(1) }) },
      ],
      "morning",
      { ...digest, maxItems: 10 },
      now,
      7,
    );
    expect(picks.map((p) => p.id)).toEqual(["newer", "older"]);
  });
});
