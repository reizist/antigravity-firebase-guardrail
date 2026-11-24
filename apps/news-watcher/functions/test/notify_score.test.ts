import { describe, expect, it } from "vitest";
import {
  assertAllowedWebhook,
  buildGoogleChatPayload,
  buildPayload,
  buildSlackPayload,
  sendWebhook,
  type DigestMessage,
} from "../src/notifiers/index.js";
import { buildPrompt, parseScore } from "../src/scoring/gemini.js";
import { matchesTopic } from "../src/scoring/prefilter.js";

const MSG: DigestMessage = {
  heading: "📰 競合動向 のまとめ",
  items: [
    { title: "A社が <新製品> を発表", url: "https://example.com/a", summary: "要約 A", sourceName: "Example", score: 92 },
    { title: "B社 & C社が提携", url: "https://example.com/b", summary: "", score: 70 },
  ],
  appUrl: "https://fga-news-watcher.web.app",
};

describe("Google Chat", () => {
  it("Cards v2 のペイロード", () => {
    expect(buildGoogleChatPayload(MSG)).toMatchSnapshot();
  });
});

describe("Slack", () => {
  it("Block Kit のペイロード（mrkdwn の特殊文字をエスケープする）", () => {
    const payload = buildSlackPayload(MSG);
    expect(JSON.stringify(payload)).toContain("A社が &lt;新製品&gt; を発表");
    expect(JSON.stringify(payload)).toContain("B社 &amp; C社が提携");
    expect(payload).toMatchSnapshot();
  });
});

describe("buildPayload", () => {
  it("未対応の種類はエラー", () => {
    expect(() => buildPayload("teams" as never, MSG)).toThrow("未対応");
  });
});

describe("Webhook の送信先", () => {
  it("Google Chat / Slack のホストだけ認める", () => {
    expect(assertAllowedWebhook("https://chat.googleapis.com/v1/spaces/AAA/messages?key=x&token=y").hostname).toBe("chat.googleapis.com");
    expect(assertAllowedWebhook("https://hooks.slack.com/services/T/B/X").hostname).toBe("hooks.slack.com");
    expect(() => assertAllowedWebhook("https://evil.example.com/hook")).toThrow("認めていない");
    expect(() => assertAllowedWebhook("http://hooks.slack.com/services/T/B/X")).toThrow("https");
  });

  it("送信に失敗したらエラー（応答本文の先頭だけ含める）", async () => {
    const fakeFetch = (async () => new Response("bad request", { status: 400 })) as typeof fetch;
    await expect(sendWebhook("https://hooks.slack.com/services/T/B/X", {}, fakeFetch)).rejects.toThrow("HTTP 400");
  });

  it("JSON を POST する", async () => {
    let captured: RequestInit | undefined;
    const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
      captured = init;
      return new Response("ok");
    }) as typeof fetch;
    await sendWebhook("https://chat.googleapis.com/v1/spaces/AAA/messages", { text: "hi" }, fakeFetch);
    expect(captured?.method).toBe("POST");
    expect(captured?.body).toBe('{"text":"hi"}');
  });
});

describe("matchesTopic", () => {
  const item = { title: "ＧＯＯＧＬＥ が新しい Gemini を発表", summary: "生成AIの規制にも言及" };

  it("全角・大文字小文字を区別せずにキーワードを探す", () => {
    expect(matchesTopic(item, { keywords: ["google"] })).toBe(true);
    expect(matchesTopic(item, { keywords: ["生成ai"] })).toBe(true);
    expect(matchesTopic(item, { keywords: ["AWS"] })).toBe(false);
  });

  it("除外キーワードを含めば false、キーワードが空なら true", () => {
    expect(matchesTopic(item, { keywords: ["google"], excludeKeywords: ["規制"] })).toBe(false);
    expect(matchesTopic(item, { keywords: [] })).toBe(true);
  });
});

describe("Gemini の採点", () => {
  it("プロンプトにトピックと記事を含める（本文は含めない）", () => {
    const prompt = buildPrompt(
      { title: "記事タイトル", summary: "概要", url: "https://example.com/a" },
      { name: "競合動向", description: "競合のクラウド製品", keywords: ["AWS", "Azure"] },
    );
    expect(prompt).toContain("名前: 競合動向");
    expect(prompt).toContain("キーワード: AWS, Azure");
    expect(prompt).toContain("情報源: example.com");
  });

  it("出力を検証し、範囲外の値を丸める", () => {
    expect(parseScore('{"score": 140.6, "reason": "r", "summary": "s", "tags": ["a","b","c","d"]}')).toEqual({
      score: 100,
      reason: "r",
      summary: "s",
      tags: ["a", "b", "c"],
    });
    expect(parseScore('{"score": -3}').score).toBe(0);
    expect(() => parseScore("not json")).toThrow();
  });
});
