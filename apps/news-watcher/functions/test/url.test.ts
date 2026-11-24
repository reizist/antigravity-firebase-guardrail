// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { normalizeUrl, urlHash } from "../src/lib/url.js";

describe("normalizeUrl", () => {
  it("追跡用のクエリ・フラグメント・末尾のスラッシュを取り除き、クエリを並べ替える", () => {
    expect(normalizeUrl("https://Example.COM/news/1/?utm_source=x&b=2&a=1#top")).toBe("https://example.com/news/1?a=1&b=2");
  });

  it("相対 URL を base で解決する", () => {
    expect(normalizeUrl("/a/b", "https://example.com/list")).toBe("https://example.com/a/b");
  });

  it("同じ記事なら同じハッシュになる", () => {
    expect(urlHash("https://example.com/a?utm_medium=rss")).toBe(urlHash("https://example.com/a/#comments"));
    expect(urlHash("https://example.com/a")).toHaveLength(32);
  });
});
