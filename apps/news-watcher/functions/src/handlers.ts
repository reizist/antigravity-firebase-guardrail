// ==============================================================================
// 関数の本体（Firestore を読み書きする部分）
//   画面からの操作はすべて Firestore への書き込みで受け、関数はトリガーと定期実行だけにする
//   （Tier 0 のルール：HTTP 関数は作らない）
// ==============================================================================

import { FieldPath, FieldValue, Timestamp, type Firestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { LIMITS, TIME_ZONE, WEBHOOK_SECRET_NAMES } from "./config.js";
import { isCronDue } from "./digest/cron.js";
import { autoSourceFields, autoSourceId, selectDigestItems } from "./digest/select.js";
import { hostOf, urlHash } from "./lib/url.js";
import { buildPayload, sendWebhook, type DigestItem, type DigestMessage } from "./notifiers/index.js";
import { matchesTopic } from "./scoring/prefilter.js";
import type { Scorer } from "./scoring/gemini.js";
import type { SourceSuggester } from "./scoring/suggest.js";
import { collectItems, inspectSource, isSourceDue, type Fetcher } from "./sources/inspect.js";
import type { ArticleDoc, ChannelDoc, DigestDoc, DigestRunDoc, ShareRequestDoc, SourceDoc, SuggestRequestDoc, TopicDoc } from "./types.js";

export type SecretReader = (name: string) => string;

export interface Deps {
  db: Firestore;
  fetcher?: Fetcher;
  now?: () => Date;
}

function errorMessage(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 500);
}

// ---- 情報源の判定（onSourceWritten） --------------------------------------------

export async function handleSourceWritten(deps: Deps, sourceId: string, after: SourceDoc | undefined): Promise<void> {
  if (!after || after.status !== "pending") return;
  const ref = deps.db.collection("sources").doc(sourceId);
  try {
    const result = await inspectSource(after, deps.fetcher);
    await ref.update({
      status: "ok",
      type: result.type,
      feedUrl: result.feedUrl,
      displayName: after.displayName || result.displayName,
      sample: result.sample,
      lastError: null,
      checkedAt: FieldValue.serverTimestamp(),
    });
    logger.info("source inspected", { sourceId, type: result.type });
  } catch (e) {
    await ref.update({ status: "error", lastError: errorMessage(e), checkedAt: FieldValue.serverTimestamp() });
    logger.warn("source inspection failed", { sourceId, error: errorMessage(e) });
  }
}

// ---- トピックから情報源を自動で作る（onTopicWritten。docs/news_watcher_design.md §5.2） ----------

export async function handleTopicWritten(deps: Deps, topicId: string, _after: TopicDoc | undefined): Promise<void> {
  const ref = deps.db.collection("sources").doc(autoSourceId(topicId));
  // イベントの内容ではなく今のトピックを読む（削除と同じ ID での作成が続くと、イベントの順番が入れ替わることがある）
  const current = (await deps.db.collection("topics").doc(topicId).get()).data() as TopicDoc | undefined;
  const want = autoSourceFields(topicId, current);
  const snap = await ref.get();
  const have = snap.data() as SourceDoc | undefined;
  if (have && have.managedBy !== "topic") {
    logger.warn("auto source id is used by another source", { topicId, sourceId: ref.id });
    return;
  }
  if (!want) {
    if (snap.exists) {
      await ref.delete();
      logger.info("auto source deleted", { topicId });
    }
    return;
  }
  const queryChanged = have?.query !== want.query;
  const changed =
    !have ||
    queryChanged ||
    have.enabled !== want.enabled ||
    have.displayName !== want.displayName ||
    JSON.stringify(have.tags ?? []) !== JSON.stringify(want.tags);
  if (!changed) return;
  // 検索語が変わったとき（と新規）だけ再判定を依頼する（onSourceWritten が判定する）
  await ref.set(
    { ...want, ...(queryChanged ? { status: "pending" } : {}), createdBy: have?.createdBy ?? "topic", updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  logger.info("auto source upserted", { topicId, query: want.query, reinspect: queryChanged });
}

// ---- 記事の取得と採点（fetchSources） ---------------------------------------------

export interface FetchRunResult {
  sources: number;
  items: number;
  scored: number;
  errors: number;
}

export async function runFetchSources(deps: Deps & { scorer: Scorer; maxArticlesPerRun?: number }): Promise<FetchRunResult> {
  const now = deps.now?.() ?? new Date();
  const { db } = deps;
  const maxScore = deps.maxArticlesPerRun ?? LIMITS.maxArticlesPerRun;

  const [sourceSnap, topicSnap] = await Promise.all([
    db.collection("sources").where("enabled", "==", true).where("status", "==", "ok").get(),
    db.collection("topics").where("enabled", "==", true).get(),
  ]);
  const topics = topicSnap.docs.map((d) => ({ id: d.id, ...(d.data() as TopicDoc) }));
  const result: FetchRunResult = { sources: 0, items: 0, scored: 0, errors: 0 };
  if (topics.length === 0) return result;

  const perDomain = new Map<string, number>();
  // 採点の上限はトピックごとに持つ（共通の情報源が先に使い切って、他のトピックが採点されないのを防ぐ）
  const budget = new Map(topics.map((t) => [t.id, maxScore]));
  const exhausted = () => [...budget.values()].every((b) => b <= 0);
  // トピック専用の情報源（自動検索）を先に処理する
  const sourceDocs = [...sourceSnap.docs].sort((a, b) => Number(!(a.data() as SourceDoc).topicId) - Number(!(b.data() as SourceDoc).topicId));

  for (const doc of sourceDocs) {
    const source = doc.data() as SourceDoc;
    if (!isSourceDue(source, now)) continue;
    const domain = hostOf(source.feedUrl ?? source.url);
    const used = perDomain.get(domain) ?? 0;
    if (used >= LIMITS.maxRequestsPerDomain) continue;
    perDomain.set(domain, used + 1);
    result.sources++;

    let items;
    try {
      items = await collectItems(source, deps.fetcher);
      await doc.ref.update({ lastFetchedAt: Timestamp.fromDate(now), lastError: null });
    } catch (e) {
      result.errors++;
      await doc.ref.update({ lastFetchedAt: Timestamp.fromDate(now), lastError: errorMessage(e) });
      logger.warn("fetch failed", { sourceId: doc.id, error: errorMessage(e) });
      continue;
    }

    // トピックから自動で作った情報源は、そのトピックだけで採点する（§5.2）
    const relevantTopics = source.topicId
      ? topics.filter((t) => t.id === source.topicId)
      : topics.filter((t) => !t.sourceIds?.length || t.sourceIds.includes(doc.id));
    for (const item of items) {
      result.items++;
      const id = urlHash(item.url);
      const ref = db.collection("articles").doc(id);
      const existing = (await ref.get()).data() as ArticleDoc | undefined;
      const targets = relevantTopics.filter(
        (t) => existing?.scores?.[t.id] === undefined && (budget.get(t.id) ?? 0) > 0 && matchesTopic(item, t),
      );
      if (targets.length === 0) continue;

      const scores: Record<string, number> = { ...(existing?.scores ?? {}) };
      const reasons: Record<string, string> = { ...(existing?.reasons ?? {}) };
      let summary = existing?.summary ?? "";
      let tags = existing?.tags ?? [];
      for (const topic of targets) {
        budget.set(topic.id, (budget.get(topic.id) ?? 0) - 1);
        try {
          const r = await deps.scorer(
            { title: item.title, summary: item.summary, url: item.url, sourceName: source.displayName },
            topic,
          );
          scores[topic.id] = r.score;
          reasons[topic.id] = r.reason;
          if (!summary) summary = r.summary;
          if (tags.length === 0) tags = r.tags;
          result.scored++;
        } catch (e) {
          result.errors++;
          logger.warn("scoring failed", { articleId: id, topicId: topic.id, error: errorMessage(e) });
        }
      }
      if (Object.keys(scores).length === Object.keys(existing?.scores ?? {}).length) continue;

      const doc2: Partial<ArticleDoc> = {
        url: item.url,
        title: item.title,
        sourceId: doc.id,
        sourceName: source.displayName ?? domain,
        publishedAt: item.publishedAt ? Timestamp.fromDate(item.publishedAt) : null,
        summary,
        tags,
        scores,
        reasons,
      };
      if (!existing) {
        Object.assign(doc2, {
          fetchedAt: Timestamp.fromDate(now),
          deliveredTo: [],
          expireAt: Timestamp.fromMillis(now.getTime() + LIMITS.articleRetentionDays * 86_400_000),
        });
      }
      await ref.set(doc2, { merge: true });
    }
    if (exhausted()) {
      logger.info("scoring budget exhausted", { maxArticlesPerRun: maxScore });
      break;
    }
  }
  logger.info("fetchSources finished", { ...result });
  return result;
}

// ---- 配信 ---------------------------------------------------------------------

async function loadChannel(db: Firestore, channelId: string): Promise<ChannelDoc> {
  const snap = await db.collection("channels").doc(channelId).get();
  if (!snap.exists) throw new Error(`配信先 ${channelId} がありません`);
  const channel = snap.data() as ChannelDoc;
  if (!(WEBHOOK_SECRET_NAMES as readonly string[]).includes(channel.secretName)) {
    throw new Error(`配信先 ${channelId} のシークレット ${channel.secretName} は、関数で宣言されていません（config.ts）`);
  }
  return channel;
}

async function post(channel: ChannelDoc, msg: DigestMessage, readSecret: SecretReader, fetchImpl?: typeof fetch) {
  const webhookUrl = readSecret(channel.secretName);
  if (!webhookUrl) throw new Error(`シークレット ${channel.secretName} に値が登録されていません`);
  await sendWebhook(webhookUrl, buildPayload(channel.type, msg), fetchImpl);
}

function toDigestItem(a: ArticleDoc, topicId?: string, topicName?: string): DigestItem {
  return {
    title: a.title,
    url: a.url,
    summary: a.summary,
    sourceName: a.sourceName,
    score: topicId ? a.scores?.[topicId] : undefined,
    label: topicName,
  };
}

export interface DeliverDeps extends Deps {
  readSecret: SecretReader;
  appUrl?: string;
  fetchImpl?: typeof fetch;
  /** deliverDigests の起動間隔（分） */
  windowMinutes?: number;
}

export async function runDeliverDigests(deps: DeliverDeps): Promise<{ delivered: number; skipped: number; errors: number }> {
  const now = deps.now?.() ?? new Date();
  const window = deps.windowMinutes ?? 15;
  const { db } = deps;
  const out = { delivered: 0, skipped: 0, errors: 0 };
  const [digestSnap, topicSnap] = await Promise.all([
    db.collection("digests").where("enabled", "==", true).get(),
    db.collection("topics").get(),
  ]);
  const topicNames = new Map(topicSnap.docs.map((d) => [d.id, (d.data() as TopicDoc).name]));

  for (const ddoc of digestSnap.docs) {
    const digest = ddoc.data() as DigestDoc;
    if (!digest.cron || !digest.channelId || !digest.topicIds?.length) continue;
    try {
      if (!isCronDue(digest.cron, now, window, TIME_ZONE)) continue;
    } catch (e) {
      out.errors++;
      logger.warn("invalid digest cron", { digestId: ddoc.id, error: errorMessage(e) });
      continue;
    }
    // スケジューラの再試行などで二重に配信しない
    const last = digest.lastRunAt?.toDate();
    if (last && now.getTime() - last.getTime() < (window - 1) * 60_000) continue;

    // 対象トピックごとに、しきい値以上の記事をスコアの高い順に集める（まとめて選び直す）
    const minScore = digest.minScore ?? 60;
    const maxItems = Math.min(Math.max(digest.maxItems ?? LIMITS.maxItemsPerDigest, 1), 30);
    const snaps = await Promise.all(
      digest.topicIds.map((t) =>
        // トピック ID にハイフンなどが入っても安全なように、項目は FieldPath で指定する
        db.collection("articles").where(new FieldPath("scores", t), ">=", minScore).orderBy(new FieldPath("scores", t), "desc").limit(200).get(),
      ),
    );
    const candidates = snaps.flatMap((snap) => snap.docs.map((d) => ({ id: d.id, article: d.data() as ArticleDoc })));
    const picks = selectDigestItems(candidates, ddoc.id, { topicIds: digest.topicIds, minScore, maxItems }, now, LIMITS.digestLookbackDays);

    await ddoc.ref.update({ lastRunAt: Timestamp.fromDate(now) });
    if (picks.length === 0) {
      out.skipped++;
      continue;
    }

    const deliveryRef = db.collection("deliveries").doc();
    const record = {
      digestId: ddoc.id,
      topicIds: digest.topicIds,
      channelId: digest.channelId,
      articleIds: picks.map((p) => p.id),
      postedAt: Timestamp.fromDate(now),
      trigger: "digest",
    };
    try {
      const channel = await loadChannel(db, digest.channelId);
      await post(
        channel,
        {
          heading: `📰 ${digest.name}`,
          items: picks.map((p) => toDigestItem(p.article, p.topicId, topicNames.get(p.topicId))),
          appUrl: deps.appUrl,
        },
        deps.readSecret,
        deps.fetchImpl,
      );
      const batch = db.batch();
      for (const p of picks) batch.update(db.collection("articles").doc(p.id), { deliveredTo: FieldValue.arrayUnion(ddoc.id) });
      batch.set(deliveryRef, { ...record, status: "ok", error: null });
      await batch.commit();
      out.delivered++;
    } catch (e) {
      out.errors++;
      await deliveryRef.set({ ...record, status: "error", error: errorMessage(e) });
      logger.error("digest delivery failed", { digestId: ddoc.id, error: errorMessage(e) });
    }
  }
  return out;
}

// ---- 今すぐ共有（onShareRequest） --------------------------------------------------

export async function handleShareRequest(deps: DeliverDeps, requestId: string, req: ShareRequestDoc): Promise<void> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const reqRef = db.collection("shareRequests").doc(requestId);
  if (req.status !== "pending") return;
  try {
    const articleSnap = await db.collection("articles").doc(req.articleId).get();
    if (!articleSnap.exists) throw new Error(`記事 ${req.articleId} がありません`);
    const article = articleSnap.data() as ArticleDoc;
    const channel = await loadChannel(db, req.channelId);
    await post(
      channel,
      { heading: `🔗 ${req.requestedBy} さんが共有しました`, comment: req.comment, items: [toDigestItem(article)], appUrl: deps.appUrl },
      deps.readSecret,
      deps.fetchImpl,
    );
    await db.collection("deliveries").add({
      topicId: null,
      channelId: req.channelId,
      articleIds: [req.articleId],
      postedAt: Timestamp.fromDate(now),
      status: "ok",
      error: null,
      trigger: "manual",
      requestedBy: req.requestedBy,
    });
    await reqRef.update({ status: "done", processedAt: Timestamp.fromDate(now) });
  } catch (e) {
    await reqRef.update({ status: "error", error: errorMessage(e), processedAt: Timestamp.fromDate(now) });
    logger.error("share request failed", { requestId, error: errorMessage(e) });
  }
}

// ---- トピックに合う情報源の提案（onSuggestRequest。docs/news_watcher_design.md §5.4） -------------------

export async function handleSuggestRequest(
  deps: Deps & { suggester: SourceSuggester },
  requestId: string,
  req: SuggestRequestDoc,
): Promise<void> {
  if (req.status !== "pending") return;
  const { db } = deps;
  const reqRef = db.collection("sourceSuggestions").doc(requestId);
  try {
    const topic = (await db.collection("topics").doc(req.topicId).get()).data() as TopicDoc | undefined;
    if (!topic) throw new Error(`トピック ${req.topicId} がありません`);
    const suggestions = await deps.suggester(topic);

    // 既に登録済みの情報源は除く（url / feedUrl で比べる）
    const norm = (u: string) => u.replace(/\/+$/, "").toLowerCase();
    const existing = new Set<string>();
    for (const d of (await db.collection("sources").get()).docs) {
      const s = d.data() as SourceDoc;
      existing.add(norm(s.url));
      if (s.feedUrl) existing.add(norm(s.feedUrl));
    }

    // 提案された URL を実際に取りに行って確かめる（同時に 4 件まで）
    const candidates: Record<string, unknown>[] = [];
    let rejected = 0;
    const queue = suggestions.filter((s) => !existing.has(norm(s.url)));
    const workers = Array.from({ length: 4 }, async () => {
      for (let s = queue.shift(); s; s = queue.shift()) {
        try {
          const r = await inspectSource({ url: s.url }, deps.fetcher);
          if (r.sample.length === 0 || (r.feedUrl && existing.has(norm(r.feedUrl)))) {
            rejected++;
            continue;
          }
          candidates.push({ url: s.url, feedUrl: r.feedUrl, type: r.type, title: s.title || r.displayName, reason: s.reason, sample: r.sample });
        } catch {
          rejected++;
        }
      }
    });
    await Promise.all(workers);
    await reqRef.update({
      status: "done",
      candidates,
      suggested: suggestions.length,
      rejected,
      processedAt: FieldValue.serverTimestamp(),
    });
    logger.info("sources suggested", { requestId, topicId: req.topicId, suggested: suggestions.length, valid: candidates.length });
  } catch (e) {
    await reqRef.update({ status: "error", error: errorMessage(e), processedAt: FieldValue.serverTimestamp() });
    logger.error("source suggestion failed", { requestId, error: errorMessage(e) });
  }
}

// ---- 配信設定の「今すぐ配信」（onDigestRun。画面でプレビューして選んだ記事を送る。§5.3） ----------------

export async function handleDigestRun(deps: DeliverDeps, runId: string, req: DigestRunDoc): Promise<void> {
  if (req.status !== "pending") return;
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const runRef = db.collection("digestRuns").doc(runId);
  try {
    const digestSnap = await db.collection("digests").doc(req.digestId).get();
    if (!digestSnap.exists) throw new Error(`配信設定 ${req.digestId} がありません`);
    const digest = digestSnap.data() as DigestDoc;
    const ids = [...new Set(req.articleIds)].slice(0, 30);
    if (ids.length === 0) throw new Error("配信する記事がありません");
    const snaps = await db.getAll(...ids.map((id) => db.collection("articles").doc(id)));
    const articles = snaps.filter((d) => d.exists).map((d) => ({ id: d.id, a: d.data() as ArticleDoc }));
    if (articles.length === 0) throw new Error("選んだ記事が見つかりません（保存期間が過ぎた可能性があります）");

    const topicNames = new Map((await db.collection("topics").get()).docs.map((d) => [d.id, (d.data() as TopicDoc).name]));
    const bestTopic = (a: ArticleDoc) =>
      digest.topicIds
        .map((t) => [t, a.scores?.[t]] as const)
        .filter((x): x is readonly [string, number] => typeof x[1] === "number")
        .sort((x, y) => y[1] - x[1])[0]?.[0];

    const channel = await loadChannel(db, digest.channelId);
    await post(
      channel,
      {
        heading: `📰 ${digest.name}`,
        items: articles.map(({ a }) => {
          const t = bestTopic(a);
          return toDigestItem(a, t, t ? topicNames.get(t) : undefined);
        }),
        appUrl: deps.appUrl,
      },
      deps.readSecret,
      deps.fetchImpl,
    );
    const batch = db.batch();
    for (const { id } of articles) batch.update(db.collection("articles").doc(id), { deliveredTo: FieldValue.arrayUnion(req.digestId) });
    batch.set(db.collection("deliveries").doc(), {
      digestId: req.digestId,
      topicIds: digest.topicIds,
      channelId: digest.channelId,
      articleIds: articles.map(({ id }) => id),
      postedAt: Timestamp.fromDate(now),
      status: "ok",
      error: null,
      trigger: "manual",
      requestedBy: req.requestedBy,
    });
    batch.update(runRef, { status: "done", delivered: articles.length, processedAt: Timestamp.fromDate(now) });
    await batch.commit();
  } catch (e) {
    await runRef.update({ status: "error", error: errorMessage(e), processedAt: Timestamp.fromDate(now) });
    logger.error("digest run failed", { runId, error: errorMessage(e) });
  }
}
