// トピックに合う情報源を Gemini に提案させる（docs/news_watcher_design.md §5.4）
//   sourceSuggestions に依頼を書く → 関数 onSuggestRequest が候補を書く → 画面で選んで「追加」
import { addDoc, collection, onSnapshot, serverTimestamp } from "firebase/firestore";
import type { AppState, Topic } from "./types";
import { $, enableLightDismissFallback, errorMessage, h, notify } from "./ui";

interface Candidate {
  url: string;
  feedUrl: string | null;
  type: "rss" | "web" | "google_news";
  title: string;
  reason: string;
  sample: { title: string; url: string }[];
}

const TYPE_LABEL: Record<string, string> = { rss: "RSS", web: "Web ページ", google_news: "Google ニュース" };
let initialized = false;
let unsubscribe: (() => void) | null = null;

export async function suggestSources(state: AppState, topic: Topic): Promise<void> {
  const dialog = $("suggest-dialog") as HTMLDialogElement;
  const status = $("suggest-status");
  const list = $("suggest-list");
  if (!initialized) {
    enableLightDismissFallback(dialog);
    dialog.addEventListener("close", () => {
      unsubscribe?.();
      unsubscribe = null;
    });
    initialized = true;
  }
  $("suggest-title").textContent = `「${topic.name}」の情報源の候補`;
  status.textContent = "Gemini が情報源を探し、実際に記事が取れるかを確かめています…（1〜2 分かかります）";
  list.replaceChildren();
  dialog.showModal();

  try {
    const ref = await addDoc(collection(state.db, "sourceSuggestions"), {
      topicId: topic.id,
      requestedBy: state.email,
      status: "pending",
      createdAt: serverTimestamp(),
    });
    unsubscribe = onSnapshot(ref, (snap) => {
      const d = snap.data() as { status?: string; error?: string; candidates?: Candidate[]; suggested?: number; rejected?: number } | undefined;
      if (d?.status === "error") {
        status.textContent = `エラー：${d.error ?? "不明なエラー"}`;
      } else if (d?.status === "done") {
        const candidates = d.candidates ?? [];
        status.textContent = candidates.length
          ? `${candidates.length} 件見つかりました（Gemini の提案 ${d.suggested ?? 0} 件のうち、記事が取れないもの・登録済みのもの ${d.rejected ?? 0} 件を除きました）。追加すると全トピックの採点に使われます。`
          : `使える候補は見つかりませんでした（Gemini の提案 ${d.suggested ?? 0} 件は、記事が取れないか登録済みでした）。`;
        list.replaceChildren(...candidates.map((c) => card(state, topic, c)));
      }
    });
  } catch (e) {
    status.textContent = `エラー：${errorMessage(e)}`;
  }
}

function card(state: AppState, topic: Topic, c: Candidate): HTMLLIElement {
  const url = c.feedUrl ?? c.url;
  const already = [...state.sources.values()].some((s) => s.url === url || s.url === c.url);
  const button = h("button", { attrs: { type: "button", disabled: already }, class: "primary", text: already ? "登録済み" : "追加" });
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await addDoc(collection(state.db, "sources"), {
        url,
        displayName: c.title.slice(0, 100) || new URL(url).hostname,
        tags: [topic.name].slice(0, 10),
        enabled: true,
        fetchIntervalMin: 60,
        status: "pending",
        createdBy: state.email,
        updatedAt: serverTimestamp(),
      });
      button.textContent = "追加しました";
      notify(`情報源「${c.title}」を追加しました`);
    } catch (e) {
      button.disabled = false;
      notify(`追加できませんでした：${errorMessage(e)}`, "error");
    }
  });
  return h(
    "li",
    { class: "card" },
    h("h3", { text: c.title || url }),
    h("div", { class: "meta" }, h("span", { class: "badge ok", text: TYPE_LABEL[c.type] ?? c.type }), h("a", { attrs: { href: url, target: "_blank", rel: "noopener noreferrer" }, text: url })),
    c.reason ? h("p", { class: "summary", text: c.reason }) : null,
    c.sample?.length
      ? h(
          "details",
          {},
          h("summary", { text: "取得できた記事の例" }),
          h("ul", {}, ...c.sample.map((x) => h("li", {}, h("a", { attrs: { href: x.url, target: "_blank", rel: "noopener noreferrer" }, text: x.title })))),
        )
      : null,
    h("div", { class: "actions" }, button),
  );
}
