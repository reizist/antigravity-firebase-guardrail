// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { fromFields, toFields } from "../src/watchlist/firestoreRest.js";
import { formatPlan, planSync, type CurrentState } from "../src/watchlist/plan.js";
import { parseWatchlist, WatchlistError } from "../src/watchlist/schema.js";

const YAML = `
channels:
  general:
    type: slack
    secretName: NEWS_WATCHER_SLACK_WEBHOOK_GENERAL
sources:
  blog:
    url: https://example.com/feed
    tags: [a]
  gnews:
    query: " Firebase "
topics:
  cloud:
    name: クラウド
    keywords: [GCP]
    sourceIds: [blog]
digests:
  morning:
    name: 朝のまとめ
    topicIds: [cloud]
    maxItems: 5
    minScore: 70
    cron: "0 9 * * 1-5"
    channelId: general
`;

const empty = (): CurrentState => ({ channels: {}, sources: {}, topics: {}, digests: {} });

describe("parseWatchlist", () => {
  it("既定値を補い、google_news は検索語から url を作る", () => {
    const w = parseWatchlist(YAML);
    expect(w.sources.blog).toEqual({ url: "https://example.com/feed", tags: ["a"], enabled: true });
    expect(w.sources.gnews).toMatchObject({ query: "Firebase", enabled: true });
    expect(w.sources.gnews!.url).toContain("news.google.com/rss/search?q=Firebase");
    expect(w.topics.cloud).toEqual({ name: "クラウド", keywords: ["GCP"], sourceIds: ["blog"], autoSearch: true, enabled: true });
    expect(w.digests.morning).toEqual({
      name: "朝のまとめ", topicIds: ["cloud"], maxItems: 5, minScore: 70, cron: "0 9 * * 1-5", channelId: "general", enabled: true,
    });
  });

  it("問題をまとめて報告する", () => {
    const bad = `
channels:
  Bad_ID:
    type: teams
    secretName: SOMETHING
sources:
  s1:
    url: http://example.com/
  s2:
    url: https://example.com/
    query: both
  s3:
    url: https://169.254.169.254/
    fetchIntervalMin: 5
    color: red
topics:
  t1:
    keywords: x
    sourceIds: [nope]
    autoSearch: "yes"
digests:
  d1:
    topicIds: [nope]
    maxItems: 50
    minScore: 101
    cron: "every day"
    channelId: missing
extra: {}
`;
    try {
      parseWatchlist(bad);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(WatchlistError);
      const p = (e as WatchlistError).problems.join("\n");
      for (const s of [
        "不明な項目です: extra",
        "channels.Bad_ID: キーは英小文字",
        "channels.Bad_ID.type",
        "channels.Bad_ID.secretName",
        "sources.s1.url: https://",
        "sources.s2: url か query のどちらか一方",
        "sources.s3.url: 内部向けのアドレス",
        "sources.s3.fetchIntervalMin",
        "sources.s3: 不明な項目です: color",
        "topics.t1.name",
        "topics.t1.keywords",
        "topics.t1.sourceIds: 情報源 nope",
        "topics.t1.autoSearch",
        "digests.d1.name",
        "digests.d1.topicIds: トピック nope",
        "digests.d1.maxItems",
        "digests.d1.minScore",
        "digests.d1.cron",
        "digests.d1.channelId: 配信先 missing",
      ]) {
        expect(p).toContain(s);
      }
    }
  });
});

describe("planSync", () => {
  const desired = parseWatchlist(YAML);

  it("空の Firestore には全部を追加し、情報源は判定を依頼する", () => {
    const ops = planSync(desired, empty());
    expect(ops.map((o) => `${o.kind} ${o.collection}/${o.id}`)).toEqual([
      "create channels/general",
      "create sources/blog",
      "create sources/gnews",
      "create topics/cloud",
      "create digests/morning",
    ]);
    const blog = ops.find((o) => o.id === "blog")!;
    expect(blog.data).toMatchObject({ status: "pending", managedBy: "yaml", createdBy: "watchlist.yaml" });
    expect(ops.find((o) => o.id === "cloud")!.data).not.toHaveProperty("status");
  });

  it("同じ内容なら何もしない（関数が書いた項目は比較しない）", () => {
    const current = empty();
    for (const op of planSync(desired, empty())) {
      const fnFields = op.collection === "sources" ? { status: "ok", type: "rss", sample: [] } : {};
      current[op.collection][op.id] = { ...op.data, ...fnFields };
    }
    expect(planSync(desired, current)).toEqual([]);
  });

  it("url が変わったら再判定、enabled だけなら再判定しない。YAML から消えた項目は削除対象に入る", () => {
    const current = empty();
    for (const op of planSync(desired, empty())) current[op.collection][op.id] = { ...op.data, status: "ok" };
    current.sources.blog!.url = "https://example.com/old";
    current.sources.gnews!.enabled = false;
    current.topics.cloud!.description = "古い説明";

    const ops = planSync(desired, current);
    const blog = ops.find((o) => o.id === "blog")!;
    expect(blog).toMatchObject({ kind: "update", changed: ["url"], reinspect: true });
    expect(blog.data!.status).toBe("pending");
    const gnews = ops.find((o) => o.id === "gnews")!;
    expect(gnews).toMatchObject({ kind: "update", changed: ["enabled"], reinspect: false });
    expect(gnews.fieldPaths).not.toContain("status");
    const cloud = ops.find((o) => o.id === "cloud")!;
    expect(cloud.changed).toEqual(["description"]);
    expect(cloud.fieldPaths).toContain("description"); // data にないので Firestore から消える
    expect(cloud.data).not.toHaveProperty("description");
  });

  it("廃止した項目（トピックごとの配信）が残っていたら消す", () => {
    const current = empty();
    for (const op of planSync(desired, empty())) current[op.collection][op.id] = { ...op.data, status: "ok" };
    current.topics.cloud!.digestCron = "0 9 * * 1";
    current.topics.cloud!.minScore = 70;
    const cloud = planSync(desired, current).find((o) => o.id === "cloud")!;
    expect(cloud.changed).toEqual(["digestCron", "minScore"]);
    expect(cloud.fieldPaths).toEqual(expect.arrayContaining(["digestCron", "minScore"]));
    expect(cloud.data).not.toHaveProperty("digestCron");
  });

  it("managedBy が yaml でないものは上書きも削除もしない。--prune は yaml 管理のものだけ消す", () => {
    const current = empty();
    current.sources.blog = { url: "https://example.com/feed", managedBy: "ui" };
    current.sources.old = { url: "https://example.com/old", managedBy: "yaml" };
    current.sources.fromUi = { url: "https://example.com/ui", managedBy: "ui" };

    const ops = planSync(desired, current, { prune: true });
    expect(ops.find((o) => o.id === "blog")!.kind).toBe("skip-unmanaged");
    expect(ops.find((o) => o.id === "old")!.kind).toBe("delete");
    expect(ops.find((o) => o.id === "fromUi")).toBeUndefined();
    expect(planSync(desired, current).find((o) => o.id === "old")).toBeUndefined();

    const text = formatPlan(ops, current, desired);
    expect(text).toContain("- sources/old");
    expect(text).toContain("YAML 管理外のドキュメント（触らない）: sources/fromUi");
  });
});

describe("Firestore REST の値の変換", () => {
  it("往復で同じ値に戻る", () => {
    const data = { s: "x", i: 3, d: 1.5, b: true, n: null, arr: ["a", 1], map: { k: [{ z: false }] } };
    expect(fromFields(toFields(data))).toEqual(data);
    expect(toFields({ i: 3 }).i).toEqual({ integerValue: "3" });
  });
});
