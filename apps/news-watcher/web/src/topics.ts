// トピック：一覧（キーワード・自動検索の情報源の状態）、追加・編集・停止・削除
import { addDoc, collection, deleteDoc, doc, serverTimestamp, updateDoc } from "firebase/firestore";
import { canEdit, type AppState, type Topic } from "./types";
import { suggestSources } from "./suggest";
import { $, confirmDialog, errorMessage, h, notify, relative } from "./ui";

const STATUS_LABEL: Record<string, string> = { pending: "確認中", ok: "OK", error: "エラー" };
const splitList = (v: FormDataEntryValue | null) =>
  String(v ?? "")
    .split(/[,、]/)
    .map((t) => t.trim())
    .filter(Boolean);

export function initTopics(state: AppState): { refresh: () => void } {
  const list = $("topic-list");
  const addButton = $("add-topic") as HTMLButtonElement;
  const dialog = $("topic-dialog") as HTMLDialogElement;
  const form = $("topic-form") as HTMLFormElement;
  let editing: Topic | null = null;

  addButton.addEventListener("click", () => open(null));
  dialog.addEventListener("close", () => {
    const value = dialog.returnValue;
    dialog.returnValue = "";
    if (value === "save") void save(editing);
  });

  function open(t: Topic | null) {
    editing = t;
    $("topic-dialog-title").textContent = t ? "トピックを編集" : "トピックを追加";
    form.reset();
    const f = form.elements;
    (f.namedItem("name") as HTMLInputElement).value = t?.name ?? "";
    (f.namedItem("description") as HTMLTextAreaElement).value = t?.description ?? "";
    (f.namedItem("keywords") as HTMLInputElement).value = (t?.keywords ?? []).join(", ");
    (f.namedItem("excludeKeywords") as HTMLInputElement).value = (t?.excludeKeywords ?? []).join(", ");
    (f.namedItem("autoSearch") as HTMLInputElement).checked = t?.autoSearch !== false;
    (f.namedItem("enabled") as HTMLInputElement).checked = t?.enabled !== false;
    dialog.showModal();
  }

  async function save(t: Topic | null) {
    const fd = new FormData(form);
    const data: Record<string, unknown> = {
      name: String(fd.get("name") ?? "").trim(),
      description: String(fd.get("description") ?? "").trim(),
      keywords: splitList(fd.get("keywords")).slice(0, 50),
      excludeKeywords: splitList(fd.get("excludeKeywords")).slice(0, 50),
      autoSearch: fd.get("autoSearch") === "on",
      enabled: fd.get("enabled") === "on",
      updatedAt: serverTimestamp(),
    };
    try {
      if (t) {
        await updateDoc(doc(state.db, "topics", t.id), data);
        notify(`トピック「${data.name}」を保存しました。次の取得から反映されます`);
      } else {
        await addDoc(collection(state.db, "topics"), { ...data, createdBy: state.email });
        notify(`トピック「${data.name}」を追加しました。Google ニュースの情報源を作っています…`);
      }
    } catch (e) {
      notify(`保存できませんでした：${errorMessage(e)}`, "error");
    }
  }

  async function remove(t: Topic) {
    if (!(await confirmDialog(`トピック「${t.name}」を削除しますか？ 自動で作った Google ニュースの情報源も削除されます。`))) return;
    try {
      await deleteDoc(doc(state.db, "topics", t.id));
      notify(`トピック「${t.name}」を削除しました`);
    } catch (e) {
      notify(`削除できませんでした：${errorMessage(e)}`, "error");
    }
  }

  function render() {
    addButton.hidden = !canEdit(state);
    const topics = [...state.topics.values()].sort((a, b) => a.name.localeCompare(b.name, "ja"));
    list.replaceChildren(...topics.map(card));
    if (topics.length === 0) list.append(h("li", { class: "card muted", text: "トピックはまだありません。" }));
  }

  function card(t: Topic): HTMLLIElement {
    const yaml = t.managedBy === "yaml";
    const auto = [...state.sources.values()].find((s) => s.topicId === t.id);
    const usedBy = [...state.digests.values()].filter((d) => d.topicIds?.includes(t.id)).map((d) => d.name);
    return h(
      "li",
      { class: "card" },
      h("h3", { text: t.name }),
      h(
        "div",
        { class: "meta" },
        t.enabled === false ? h("span", { class: "badge", text: "停止中" }) : h("span", { class: "badge ok", text: "有効" }),
        yaml ? h("span", { class: "badge", text: "watchlist.yaml で管理" }) : null,
        usedBy.length ? h("span", { text: `配信：${usedBy.join("、")}` }) : h("span", { text: "配信設定なし" }),
      ),
      t.description ? h("p", { class: "summary", text: t.description }) : null,
      h("div", { class: "tags" }, ...(t.keywords ?? []).map((k) => h("span", { class: "badge", text: k }))),
      t.excludeKeywords?.length ? h("p", { class: "hint", text: `除外：${t.excludeKeywords.join("、")}` }) : null,
      h(
        "p",
        { class: "hint" },
        t.autoSearch === false
          ? "Google ニュースの自動検索：オフ（共通の情報源だけで採点）"
          : auto
            ? `Google ニュースの自動検索：${STATUS_LABEL[auto.status] ?? auto.status}・最終取得 ${relative(auto.lastFetchedAt)}${auto.lastError ? `・エラー：${auto.lastError}` : ""}`
            : "Google ニュースの自動検索：準備中",
      ),
      canEdit(state) && !yaml
        ? h(
            "div",
            { class: "actions" },
            h("button", { attrs: { type: "button" }, class: "primary", text: "情報源を探す（Gemini）", on: { click: () => void suggestSources(state, t) } }),
            h("button", { attrs: { type: "button" }, text: "編集", on: { click: () => open(t) } }),
            h("button", { attrs: { type: "button" }, text: "削除", on: { click: () => void remove(t) } }),
          )
        : yaml
          ? h("p", { class: "hint", text: "このトピックは watchlist.yaml で管理しています。変更はリポジトリの YAML で行ってください。" })
          : null,
    );
  }

  return { refresh: render };
}
