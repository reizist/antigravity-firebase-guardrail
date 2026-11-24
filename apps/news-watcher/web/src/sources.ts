// 情報源：一覧（状態・最終取得・エラー・サンプル）、追加（URL を貼るだけ／Google ニュースのキーワード）、停止・再開・再判定・削除
import { addDoc, collection, deleteDoc, doc, serverTimestamp, updateDoc } from "firebase/firestore";
import { canEdit, type AppState, type Source } from "./types";
import { $, confirmDialog, errorMessage, h, notify, relative, syncFieldErrors } from "./ui";

const TYPE_LABEL: Record<string, string> = { rss: "RSS", web: "Web ページ", google_news: "Google ニュース" };
const STATUS_LABEL: Record<string, string> = { pending: "確認中", ok: "OK", error: "エラー" };

/** Google ニュースのキーワード検索の RSS（functions/src/sources/inspect.ts と同じ形） */
function googleNewsFeedUrl(q: string): string {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q.trim())}&hl=ja&gl=JP&ceid=JP:ja`;
}

export function initSources(state: AppState): { refresh: () => void } {
  const list = $("source-list");
  const form = $("add-source") as HTMLFormElement;
  const urlInput = $("src-url") as HTMLInputElement;
  const queryInput = $("src-query") as HTMLInputElement;

  syncFieldErrors(form);
  form.addEventListener("change", (e) => {
    if (!(e.target instanceof HTMLInputElement) || e.target.name !== "kind") return;
    const kind = e.target.value;
    for (const el of form.querySelectorAll<HTMLElement>("[data-kind]")) el.hidden = el.dataset.kind !== kind;
    urlInput.required = kind === "url";
    queryInput.required = kind === "query";
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    void addSource(state, form);
  });

  function render() {
    form.hidden = !canEdit(state);
    // 共通の情報源を先に、トピックから自動で作ったものを後ろに並べる
    const sources = [...state.sources.values()].sort(
      (a, b) =>
        Number(a.managedBy === "topic") - Number(b.managedBy === "topic") ||
        (a.displayName ?? a.url).localeCompare(b.displayName ?? b.url, "ja"),
    );
    list.replaceChildren(...sources.map((s) => card(s)));
    if (sources.length === 0) list.append(h("li", { class: "card muted", text: "情報源はまだありません。" }));
  }

  function card(s: Source): HTMLLIElement {
    const yaml = s.managedBy === "yaml";
    const fromTopic = s.managedBy === "topic";
    const editable = canEdit(state) && !yaml && !fromTopic;
    return h(
      "li",
      { class: "card" },
      h("h3", {}, s.displayName ?? s.query ?? s.url),
      h(
        "div",
        { class: "meta" },
        h("span", { class: `badge ${s.status}`, text: STATUS_LABEL[s.status] ?? s.status }),
        s.enabled === false ? h("span", { class: "badge", text: "停止中" }) : null,
        s.type ? h("span", { text: TYPE_LABEL[s.type] ?? s.type }) : null,
        h("span", { text: `最終取得 ${relative(s.lastFetchedAt)}` }),
        h("span", { text: `間隔 ${formatInterval(s.fetchIntervalMin ?? 60)}` }),
        yaml ? h("span", { class: "badge", text: "watchlist.yaml で管理" }) : null,
        fromTopic ? h("span", { class: "badge", text: `トピック「${state.topics.get(s.topicId ?? "")?.name ?? s.topicId}」から自動作成` }) : null,
      ),
      h("div", { class: "meta" }, h("a", { attrs: { href: s.url, target: "_blank", rel: "noopener noreferrer" }, text: s.query ? `検索語：${s.query}` : s.url })),
      s.tags?.length ? h("div", { class: "tags" }, ...s.tags.map((t) => h("span", { class: "badge", text: `#${t}` }))) : null,
      s.status === "error" && s.lastError ? h("p", { class: "error", text: `エラー：${s.lastError}` }) : null,
      s.sample?.length
        ? h(
            "details",
            {},
            h("summary", { text: `取得できた記事の例（${s.sample.length} 件）` }),
            h("ul", {}, ...s.sample.map((x) => h("li", {}, h("a", { attrs: { href: x.url, target: "_blank", rel: "noopener noreferrer" }, text: x.title })))),
          )
        : null,
      yaml
        ? h("p", { class: "hint", text: "この情報源は watchlist.yaml で管理しています。変更はリポジトリの YAML で行ってください（画面で変えても次の sync で戻ります）。" })
        : fromTopic
          ? h("p", { class: "hint", text: "トピックのキーワードから自動で作った情報源です。変更はトピックの画面で行ってください。" })
          : null,
      editable
        ? h(
            "div",
            { class: "actions" },
            h("button", {
              attrs: { type: "button" },
              text: s.enabled === false ? "再開" : "停止",
              on: { click: () => void update(s, { enabled: s.enabled === false }, s.enabled === false ? "再開しました" : "停止しました") },
            }),
            h("button", {
              attrs: { type: "button" },
              text: "再判定",
              on: { click: () => void update(s, { status: "pending" }, "再判定を依頼しました") },
            }),
            h("button", { attrs: { type: "button" }, text: "削除", on: { click: () => void remove(s) } }),
          )
        : null,
    );
  }

  async function update(s: Source, data: Record<string, unknown>, done: string) {
    try {
      await updateDoc(doc(state.db, "sources", s.id), { ...data, updatedAt: serverTimestamp() });
      notify(`${s.displayName ?? s.url}：${done}`);
    } catch (e) {
      notify(`更新できませんでした：${errorMessage(e)}`, "error");
    }
  }

  async function remove(s: Source) {
    const name = s.displayName ?? s.url;
    if (!(await confirmDialog(`「${name}」を削除しますか？ 取得済みの記事は保存期間（90 日）が来るまで残ります。`))) return;
    try {
      await deleteDoc(doc(state.db, "sources", s.id));
      notify(`「${name}」を削除しました`);
    } catch (e) {
      notify(`削除できませんでした：${errorMessage(e)}`, "error");
    }
  }

  return { refresh: render };
}

async function addSource(state: AppState, form: HTMLFormElement) {
  const fd = new FormData(form);
  const kind = fd.get("kind");
  const query = String(fd.get("query") ?? "").trim();
  const url = kind === "query" ? googleNewsFeedUrl(query) : String(fd.get("url") ?? "").trim();
  const displayName = String(fd.get("displayName") ?? "").trim() || (kind === "query" ? `Google ニュース：${query}` : "");
  const tags = String(fd.get("tags") ?? "")
    .split(/[,、]/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 10);

  const data: Record<string, unknown> = {
    url,
    tags,
    enabled: true,
    fetchIntervalMin: Number(fd.get("fetchIntervalMin") ?? 60),
    status: "pending",
    createdBy: state.email,
    updatedAt: serverTimestamp(),
  };
  if (displayName) data.displayName = displayName.slice(0, 100);
  if (kind === "query") data.query = query;

  const submit = form.querySelector<HTMLButtonElement>("button[type=submit]");
  if (submit) submit.disabled = true;
  try {
    await addDoc(collection(state.db, "sources"), data);
    notify(`「${displayName || url}」を追加しました。形式を確認しています…`);
    form.reset();
    form.dispatchEvent(new Event("change"));
  } catch (e) {
    notify(`追加できませんでした：${errorMessage(e)}`, "error");
  } finally {
    if (submit) submit.disabled = false;
  }
}

function formatInterval(min: number): string {
  return min % 1440 === 0 ? `${min / 1440} 日` : min % 60 === 0 ? `${min / 60} 時間` : `${min} 分`;
}
