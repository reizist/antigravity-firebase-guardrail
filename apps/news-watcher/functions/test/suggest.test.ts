import { describe, expect, it } from "vitest";
import { buildSuggestPrompt, MAX_SUGGESTIONS, parseSuggestions } from "../src/scoring/suggest.js";

describe("parseSuggestions", () => {
  it("コードブロックや前後の文があっても JSON 配列を読み、https 以外・重複を落とす", () => {
    const text = [
      "以下が提案です。",
      "```json",
      JSON.stringify([
        { url: "https://example.com/feed", title: "Example", reason: "公式" },
        { url: "https://example.com/feed/", title: "dup" },
        { url: "http://insecure.example.com/rss", title: "http" },
        { url: "not a url", title: "x" },
        { url: "https://news.example.jp/ai/", title: 123 },
      ]),
      "```",
    ].join("\n");
    expect(parseSuggestions(text)).toEqual([
      { url: "https://example.com/feed", title: "Example", reason: "公式" },
      { url: "https://news.example.jp/ai/", title: "123", reason: "" },
    ]);
  });

  it("JSON でなければ空。件数は上限まで", () => {
    expect(parseSuggestions("ごめんなさい")).toEqual([]);
    expect(parseSuggestions("[oops")).toEqual([]);
    const many = JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ url: `https://e${i}.example.com/` })));
    expect(parseSuggestions(many)).toHaveLength(MAX_SUGGESTIONS);
  });

  it("プロンプトにトピックの名前・説明・キーワードが入る", () => {
    const p = buildSuggestPrompt({ name: "AI エージェント", description: "MCP など", keywords: ["MCP", "Agent"] });
    expect(p).toContain("AI エージェント");
    expect(p).toContain("MCP など");
    expect(p).toContain("MCP, Agent");
  });
});
