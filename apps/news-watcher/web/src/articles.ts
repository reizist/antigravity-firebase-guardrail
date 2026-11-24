// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0
// 記事一覧：絞り込み・要約・判定理由・👍/👎・今すぐ共有
import {
  addDoc, collection, deleteDoc, doc, limit, onSnapshot, orderBy, query, serverTimestamp, setDoc,
} from "firebase/firestore";
import type { AppState, Article } from "./types";
import { $, enableLightDismissFallback, errorMessage, formatDate, h, notify, relative } from "./ui";

const MAX_ARTICLES = 200;

export function initArticles(state: AppState): { refresh: () => void } {
  const list = $("article-list");
  const count = $("articles-count");
  const form = $("article-filters") as HTMLFormElement;
  const topicSelect = form.elements.namedItem("topic") as HTMLSelectElement;
  const sourceSelect = form.elements.namedItem("source") as HTMLSelectElement;
  const minScore = form.elements.namedItem("minScore") as HTMLInputElement;
  const minScoreOut = form.elements.namedItem("minScoreOut") as HTMLOutputElement;
  const q = form.elements.namedItem("q") as HTMLInputElement;
  let articles: Article[] = [];

  onSnapshot(
    query(collection(state.db, "articles"), orderBy("fetchedAt", "desc"), limit(MAX_ARTICLES)),
    (snap) => {
      articles = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Article, "id">) }));
      render();
    },
    (e) => notify(`記事を読み込めませんでした：${errorMessage(e)}`, "error"),
  );

  form.addEventListener("input", () => {
    minScoreOut.value = minScore.value;
    render();
  });
  form.addEventListener("submit", (e) => e.preventDefault());

  setupShareDialog(state);

  function syncOptions(select: HTMLSelectElement, entries: [string, string][]) {
    const current = select.value;
    select.replaceChildren(h("option", { attrs: { value: "" }, text: "すべて" }), ...entries.map(([v, label]) => h("option", { attrs: { value: v }, text: label })));
    select.value = entries.some(([v]) => v === current) ? current : "";
  }

  function render() {
    syncOptions(topicSelect, [...state.topics.values()].map((t) => [t.id, t.name]));
    syncOptions(sourceSelect, [...state.sources.values()].map((s) => [s.id, s.displayName ?? s.url]));

    const topicId = topicSelect.value;
    const min = Number(minScore.value);
    const keyword = q.value.trim().toLowerCase();
    const shown = articles.filter((a) => {
      if (sourceSelect.value && a.sourceId !== sourceSelect.value) return false;
      const scores = topicId ? [a.scores?.[topicId]] : Object.values(a.scores ?? {});
      const best = Math.max(-1, ...scores.filter((s): s is number => typeof s === "number"));
      if (best < min || (topicId && best < 0)) return false;
      if (keyword && !`${a.title} ${a.summary}`.toLowerCase().includes(keyword)) return false;
      return true;
    });
    count.textContent = `${shown.length} 件（新しく取得した順。最大 ${MAX_ARTICLES} 件）`;
    list.replaceChildren(...shown.map((a) => card(a, topicId)));
    if (shown.length === 0) list.append(h("li", { class: "card muted", text: "条件に合う記事はありません。" }));
  }

  function card(a: Article, topicId: string): HTMLLIElement {
    const scores = Object.entries(a.scores ?? {})
      .filter(([t]) => !topicId || t === topicId)
      .sort((x, y) => y[1] - x[1]);
    const vote = state.votes.get(a.id);
    return h(
      "li",
      { class: "card" },
      h("h3", {}, h("a", { attrs: { href: a.url, target: "_blank", rel: "noopener noreferrer" }, text: a.title })),
      h(
        "div",
        { class: "meta" },
        h("span", { text: a.sourceName ?? state.sources.get(a.sourceId)?.displayName ?? a.sourceId }),
        h("span", { text: `公開 ${formatDate(a.publishedAt)}` }),
        h("span", { text: `取得 ${relative(a.fetchedAt)}` }),
        a.deliveredTo?.length ? h("span", { text: `配信済み（${a.deliveredTo.length}）` }) : null,
      ),
      h(
        "div",
        { class: "tags" },
        ...scores.map(([t, s]) =>
          h("span", { class: `badge ${s >= 70 ? "score-high" : s >= 40 ? "score-mid" : ""}`, text: `${state.topics.get(t)?.name ?? t}：${s}` }),
        ),
      ),
      a.summary ? h("p", { class: "summary", text: a.summary }) : null,
      scores.length
        ? h(
            "details",
            {},
            h("summary", { text: "判定理由" }),
            h("ul", {}, ...scores.map(([t]) => h("li", { text: `${state.topics.get(t)?.name ?? t}：${a.reasons?.[t] ?? "—"}` }))),
          )
        : null,
      a.tags?.length ? h("div", { class: "tags" }, ...a.tags.map((t) => h("span", { class: "badge", text: `#${t}` }))) : null,
      h(
        "div",
        { class: "actions" },
        voteButton(a, "up", "👍", "役に立った", vote),
        voteButton(a, "down", "👎", "役に立たなかった", vote),
        state.channels.size
          ? h("button", { attrs: { type: "button" }, text: "今すぐ共有", on: { click: () => openShare(state, a) } })
          : null,
      ),
    );
  }

  function voteButton(a: Article, value: "up" | "down", icon: string, label: string, current?: "up" | "down") {
    return h("button", {
      attrs: { type: "button", "aria-pressed": String(current === value), "aria-label": label, title: label },
      text: icon,
      on: { click: () => void toggleVote(state, a, value, topicSelect.value) },
    });
  }

  return { refresh: render };
}

async function toggleVote(state: AppState, a: Article, value: "up" | "down", topicId: string) {
  const ref = doc(state.db, "feedback", `${a.id}_${state.uid}`);
  try {
    if (state.votes.get(a.id) === value) {
      await deleteDoc(ref);
    } else {
      const top = topicId || Object.entries(a.scores ?? {}).sort((x, y) => y[1] - x[1])[0]?.[0] || null;
      await setDoc(ref, { articleId: a.id, uid: state.uid, vote: value, topicId: top, updatedAt: serverTimestamp() });
    }
  } catch (e) {
    notify(`フィードバックを保存できませんでした：${errorMessage(e)}`, "error");
  }
}

// ---- 今すぐ共有 ---------------------------------------------------------------

let shareTarget: Article | null = null;

function setupShareDialog(state: AppState) {
  const dialog = $("share-dialog") as HTMLDialogElement;
  enableLightDismissFallback(dialog);
  dialog.addEventListener("close", () => {
    const target = shareTarget;
    const value = dialog.returnValue;
    dialog.returnValue = "";
    shareTarget = null;
    if (value !== "share" || !target) return;
    const channelId = ($("share-channel") as HTMLSelectElement).value;
    const comment = ($("share-comment") as HTMLTextAreaElement).value.trim();
    void requestShare(state, target, channelId, comment);
  });
}

function openShare(state: AppState, a: Article) {
  shareTarget = a;
  $("share-article").textContent = a.title;
  const select = $("share-channel") as HTMLSelectElement;
  select.replaceChildren(
    ...[...state.channels.values()].map((c) =>
      h("option", { attrs: { value: c.id }, text: `${c.displayName ?? c.id}（${c.type === "slack" ? "Slack" : "Google Chat"}）` }),
    ),
  );
  ($("share-comment") as HTMLTextAreaElement).value = "";
  const dialog = $("share-dialog") as HTMLDialogElement;
  dialog.returnValue = "";
  dialog.showModal();
}

async function requestShare(state: AppState, a: Article, channelId: string, comment: string) {
  try {
    const data: Record<string, unknown> = {
      articleId: a.id,
      channelId,
      requestedBy: state.email,
      status: "pending",
      createdAt: serverTimestamp(),
    };
    if (comment) data.comment = comment;
    const ref = await addDoc(collection(state.db, "shareRequests"), data);
    notify(`「${a.title}」の共有を依頼しました…`);
    // 関数（onShareRequest）が処理したら結果を知らせる
    const unsubscribe = onSnapshot(ref, (snap) => {
      const s = snap.data() as { status?: string; error?: string } | undefined;
      if (s?.status === "done") {
        notify(`「${a.title}」を共有しました`);
        unsubscribe();
      } else if (s?.status === "error") {
        notify(`共有に失敗しました：${s.error ?? "不明なエラー"}`, "error");
        unsubscribe();
      }
    });
    setTimeout(unsubscribe, 120_000);
  } catch (e) {
    notify(`共有を依頼できませんでした：${errorMessage(e)}`, "error");
  }
}
