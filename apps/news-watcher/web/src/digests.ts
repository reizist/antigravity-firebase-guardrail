// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0
// 配信設定：どのトピックの記事を・何件・いつ・どこへ（docs/news_watcher_design.md §5.3）
import { addDoc, collection, deleteDoc, doc, serverTimestamp, updateDoc } from "firebase/firestore";
import { canEdit, type AppState, type Digest } from "./types";
import { openPreview } from "./preview";
import { $, confirmDialog, errorMessage, formatDate, h, notify } from "./ui";

const DAYS_LABEL: Record<string, string> = { "1-5": "平日", "*": "毎日", "1": "毎週月曜" };
const CRON_FIELD = /^[\d*,\-/]+$/;

/** "M H * * D" の形なら { days, time } に分ける（画面の簡易入力で扱える形） */
function parseSimpleCron(cron: string): { days: string; time: string } | null {
  const m = cron.trim().split(/\s+/);
  if (m.length !== 5) return null;
  const [min, hour, dom, mon, dow] = m as [string, string, string, string, string];
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour) || dom !== "*" || mon !== "*" || !(dow in DAYS_LABEL)) return null;
  return { days: dow, time: `${hour.padStart(2, "0")}:${min.padStart(2, "0")}` };
}

export function describeCron(cron: string): string {
  const s = parseSimpleCron(cron);
  return s ? `${DAYS_LABEL[s.days]} ${s.time}` : `cron: ${cron}`;
}

export function initDigests(state: AppState): { refresh: () => void } {
  const list = $("digest-list");
  const addButton = $("add-digest") as HTMLButtonElement;
  const dialog = $("digest-dialog") as HTMLDialogElement;
  const form = $("digest-form") as HTMLFormElement;
  const daysSelect = $("digest-days") as HTMLSelectElement;
  const errorEl = $("digest-error");
  let editing: Digest | null = null;

  const syncSchedule = () => {
    const custom = daysSelect.value === "custom";
    for (const el of form.querySelectorAll<HTMLElement>("[data-schedule]")) el.hidden = (el.dataset.schedule === "custom") !== custom;
    ($("digest-time") as HTMLInputElement).required = !custom;
    ($("digest-cron") as HTMLInputElement).required = custom;
  };
  daysSelect.addEventListener("change", syncSchedule);

  addButton.addEventListener("click", () => open(null));
  // 入力に問題があれば閉じない（cancel 以外の submit を検証する）
  form.addEventListener("submit", (e) => {
    const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
    if (submitter?.value !== "save") return;
    const problem = validate();
    if (problem) {
      e.preventDefault();
      errorEl.textContent = `エラー：${problem}`;
      errorEl.hidden = false;
    }
  });
  dialog.addEventListener("close", () => {
    const value = dialog.returnValue;
    dialog.returnValue = "";
    if (value === "save") void save(editing);
  });

  function open(d: Digest | null) {
    editing = d;
    $("digest-dialog-title").textContent = d ? "配信設定を編集" : "配信設定を追加";
    form.reset();
    errorEl.hidden = true;
    $("digest-topics").replaceChildren(
      ...[...state.topics.values()].map((t) =>
        h(
          "label",
          { class: "check" },
          h("input", { attrs: { type: "checkbox", name: "topicIds", value: t.id, checked: d ? d.topicIds.includes(t.id) : true } }),
          t.name,
        ),
      ),
    );
    ($("digest-channel") as HTMLSelectElement).replaceChildren(
      ...[...state.channels.values()].map((c) => h("option", { attrs: { value: c.id }, text: c.displayName ?? c.id })),
    );
    const f = form.elements;
    (f.namedItem("name") as HTMLInputElement).value = d?.name ?? "";
    (f.namedItem("maxItems") as HTMLInputElement).value = String(d?.maxItems ?? 10);
    (f.namedItem("minScore") as HTMLInputElement).value = String(d?.minScore ?? 60);
    const simple = d ? parseSimpleCron(d.cron) : { days: "1-5", time: "09:00" };
    daysSelect.value = simple ? simple.days : "custom";
    (f.namedItem("time") as HTMLInputElement).value = simple?.time ?? "09:00";
    (f.namedItem("cron") as HTMLInputElement).value = d?.cron ?? "";
    if (d) ($("digest-channel") as HTMLSelectElement).value = d.channelId;
    (f.namedItem("enabled") as HTMLInputElement).checked = d?.enabled !== false;
    syncSchedule();
    dialog.showModal();
  }

  function cronFromForm(fd: FormData): string {
    if (fd.get("days") === "custom") return String(fd.get("cron") ?? "").trim();
    const [hh, mm] = String(fd.get("time") ?? "09:00").split(":");
    return `${Number(mm)} ${Number(hh)} * * ${fd.get("days")}`;
  }

  function validate(): string | null {
    const fd = new FormData(form);
    if (fd.getAll("topicIds").length === 0) return "トピックを 1 つ以上選んでください。";
    const cron = cronFromForm(fd);
    const parts = cron.split(/\s+/);
    if (parts.length !== 5 || !parts.every((p) => CRON_FIELD.test(p))) return "cron は「分 時 日 月 曜日」の 5 つで書いてください（例: 0 9 * * 1-5）。";
    if (!fd.get("channelId")) return "配信先を選んでください。";
    return null;
  }

  async function save(d: Digest | null) {
    const fd = new FormData(form);
    const data: Record<string, unknown> = {
      name: String(fd.get("name") ?? "").trim(),
      topicIds: fd.getAll("topicIds").map(String).slice(0, 10),
      maxItems: Math.min(Math.max(Math.round(Number(fd.get("maxItems"))), 1), 30),
      minScore: Math.min(Math.max(Math.round(Number(fd.get("minScore"))), 0), 100),
      cron: cronFromForm(fd),
      channelId: String(fd.get("channelId")),
      enabled: fd.get("enabled") === "on",
      updatedAt: serverTimestamp(),
    };
    try {
      if (d) await updateDoc(doc(state.db, "digests", d.id), data);
      else await addDoc(collection(state.db, "digests"), { ...data, createdBy: state.email });
      notify(`配信設定「${data.name}」を保存しました。次の配信（${describeCron(String(data.cron))}）から反映されます`);
    } catch (e) {
      notify(`保存できませんでした：${errorMessage(e)}`, "error");
    }
  }

  async function remove(d: Digest) {
    if (!(await confirmDialog(`配信設定「${d.name}」を削除しますか？`))) return;
    try {
      await deleteDoc(doc(state.db, "digests", d.id));
      notify(`配信設定「${d.name}」を削除しました`);
    } catch (e) {
      notify(`削除できませんでした：${errorMessage(e)}`, "error");
    }
  }

  function render() {
    addButton.hidden = !canEdit(state);
    const digests = [...state.digests.values()].sort((a, b) => a.name.localeCompare(b.name, "ja"));
    list.replaceChildren(...digests.map(card));
    if (digests.length === 0) list.append(h("li", { class: "card muted", text: "配信設定はまだありません。" }));
  }

  function card(d: Digest): HTMLLIElement {
    const yaml = d.managedBy === "yaml";
    return h(
      "li",
      { class: "card" },
      h("h3", { text: d.name }),
      h(
        "div",
        { class: "meta" },
        d.enabled === false ? h("span", { class: "badge", text: "停止中" }) : h("span", { class: "badge ok", text: "有効" }),
        h("span", { text: describeCron(d.cron) }),
        h("span", { text: `最大 ${d.maxItems} 件` }),
        h("span", { text: `スコア ${d.minScore} 以上` }),
        h("span", { text: `配信先：${state.channels.get(d.channelId)?.displayName ?? d.channelId}` }),
        h("span", { text: `前回 ${formatDate(d.lastRunAt)}` }),
        yaml ? h("span", { class: "badge", text: "watchlist.yaml で管理" }) : null,
      ),
      h("div", { class: "tags" }, ...d.topicIds.map((t) => h("span", { class: "badge", text: state.topics.get(t)?.name ?? t }))),
      h(
        "div",
        { class: "actions" },
        h("button", { attrs: { type: "button" }, class: "primary", text: "プレビュー・今すぐ配信", on: { click: () => void openPreview(state, d) } }),
      ),
      canEdit(state) && !yaml
        ? h(
            "div",
            { class: "actions" },
            h("button", { attrs: { type: "button" }, text: "編集", on: { click: () => open(d) } }),
            h("button", {
              attrs: { type: "button" },
              text: d.enabled === false ? "再開" : "停止",
              on: {
                click: () =>
                  void updateDoc(doc(state.db, "digests", d.id), { enabled: d.enabled === false, updatedAt: serverTimestamp() }).catch((e) =>
                    notify(`更新できませんでした：${errorMessage(e)}`, "error"),
                  ),
              },
            }),
            h("button", { attrs: { type: "button" }, text: "削除", on: { click: () => void remove(d) } }),
          )
        : yaml
          ? h("p", { class: "hint", text: "この配信設定は watchlist.yaml で管理しています。変更はリポジトリの YAML で行ってください。" })
          : null,
    );
  }

  return { refresh: render };
}
