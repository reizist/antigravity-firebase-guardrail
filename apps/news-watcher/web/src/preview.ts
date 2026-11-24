// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0
// 配信のプレビューと「この内容で配信」（docs/news_watcher_design.md §5.3）
//   プレビューは画面で計算する（関数の selectDigestItems と同じ条件）。配信は digestRuns に依頼を書き、関数 onDigestRun が投稿する
import { addDoc, collection, FieldPath, getDocs, limit, onSnapshot, orderBy, query, serverTimestamp, where } from "firebase/firestore";
import { canEdit, type AppState, type Article, type Digest } from "./types";
import { $, errorMessage, h, notify, relative } from "./ui";

const LOOKBACK_DAYS = 7;

interface Pick {
  article: Article;
  topicId: string;
  score: number;
}

/** 関数側の functions/src/digest/select.ts の selectDigestItems と同じ条件で選ぶ */
async function computePreview(state: AppState, d: Digest): Promise<Pick[]> {
  const snaps = await Promise.all(
    d.topicIds.map((t) =>
      getDocs(query(collection(state.db, "articles"), where(new FieldPath("scores", t), ">=", d.minScore), orderBy(new FieldPath("scores", t), "desc"), limit(200))),
    ),
  );
  const since = Date.now() - LOOKBACK_DAYS * 86_400_000;
  const seen = new Set<string>();
  const picks: Pick[] = [];
  for (const snap of snaps) {
    for (const doc of snap.docs) {
      if (seen.has(doc.id)) continue;
      seen.add(doc.id);
      const a = { id: doc.id, ...(doc.data() as Omit<Article, "id">) };
      if (a.deliveredTo?.includes(d.id)) continue;
      if (!a.fetchedAt || a.fetchedAt.toMillis() < since) continue;
      let best: { topicId: string; score: number } | null = null;
      for (const t of d.topicIds) {
        const s = a.scores?.[t];
        if (typeof s === "number" && s >= d.minScore && (!best || s > best.score)) best = { topicId: t, score: s };
      }
      if (best) picks.push({ article: a, ...best });
    }
  }
  picks.sort((x, y) => y.score - x.score || y.article.fetchedAt.toMillis() - x.article.fetchedAt.toMillis());
  return picks.slice(0, d.maxItems);
}

let current: { digest: Digest; state: AppState } | null = null;
let initialized = false;

export async function openPreview(state: AppState, d: Digest): Promise<void> {
  const dialog = $("preview-dialog") as HTMLDialogElement;
  const status = $("preview-status");
  const list = $("preview-list");
  const send = $("preview-send") as HTMLButtonElement;
  if (!initialized) {
    dialog.addEventListener("close", () => {
      const value = dialog.returnValue;
      dialog.returnValue = "";
      if (value === "send" && current) void sendSelected(current.state, current.digest);
      current = null;
    });
    $("preview-form").addEventListener("change", updateSendLabel);
    initialized = true;
  }
  current = { digest: d, state };
  $("preview-title").textContent = `プレビュー：${d.name}`;
  status.textContent = "今送られる記事を選んでいます…";
  list.replaceChildren();
  send.hidden = !canEdit(state);
  send.disabled = true;
  dialog.showModal();

  try {
    const picks = await computePreview(state, d);
    status.textContent = picks.length
      ? `スコア ${d.minScore} 以上・過去 ${LOOKBACK_DAYS} 日以内・この設定で未配信の記事を、スコアの高い順に最大 ${d.maxItems} 件。送らない記事はチェックを外してください。`
      : "今送れる記事はありません（しきい値を下げるか、取得を待ってください）。";
    list.replaceChildren(
      ...picks.map((p) =>
        h(
          "li",
          { class: "card" },
          h(
            "label",
            { class: "pick" },
            h("input", { attrs: { type: "checkbox", name: "articleIds", value: p.article.id, checked: true } }),
            h(
              "span",
              { class: "body" },
              h("strong", { text: p.article.title }),
              h(
                "span",
                { class: "meta" },
                h("span", { class: `badge ${p.score >= 70 ? "score-high" : "score-mid"}`, text: `${state.topics.get(p.topicId)?.name ?? p.topicId}：${p.score}` }),
                h("span", { text: p.article.sourceName ?? "" }),
                h("span", { text: `取得 ${relative(p.article.fetchedAt)}` }),
              ),
              p.article.summary ? h("span", { class: "summary", text: p.article.summary }) : null,
            ),
          ),
        ),
      ),
    );
    updateSendLabel();
  } catch (e) {
    status.textContent = `エラー：${errorMessage(e)}`;
  }
}

function selectedIds(): string[] {
  return [...document.querySelectorAll<HTMLInputElement>('#preview-list input[name="articleIds"]:checked')].map((i) => i.value);
}

function updateSendLabel() {
  const send = $("preview-send") as HTMLButtonElement;
  const n = selectedIds().length;
  send.disabled = n === 0;
  send.textContent = `この内容で配信（${n} 件）`;
}

async function sendSelected(state: AppState, d: Digest) {
  const articleIds = selectedIds().slice(0, 30);
  if (articleIds.length === 0) return;
  try {
    const ref = await addDoc(collection(state.db, "digestRuns"), {
      digestId: d.id,
      articleIds,
      requestedBy: state.email,
      status: "pending",
      createdAt: serverTimestamp(),
    });
    notify(`「${d.name}」を ${articleIds.length} 件で配信しています…`);
    const unsubscribe = onSnapshot(ref, (snap) => {
      const r = snap.data() as { status?: string; error?: string; delivered?: number } | undefined;
      if (r?.status === "done") {
        notify(`「${d.name}」を配信しました（${r.delivered ?? articleIds.length} 件）`);
        unsubscribe();
      } else if (r?.status === "error") {
        notify(`配信に失敗しました：${r.error ?? "不明なエラー"}`, "error");
        unsubscribe();
      }
    });
    setTimeout(unsubscribe, 120_000);
  } catch (e) {
    notify(`配信を依頼できませんでした：${errorMessage(e)}`, "error");
  }
}
