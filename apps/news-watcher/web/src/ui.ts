// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0
// 画面の共通部品（DOM の組み立て・お知らせ・確認ダイアログ・日付の表示）
//   データは必ず textContent で入れる（innerHTML は使わない）

type Child = Node | string | number | null | undefined | false;
type Props = {
  class?: string;
  text?: string;
  attrs?: Record<string, string | boolean | undefined>;
  dataset?: Record<string, string>;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (ev: HTMLElementEventMap[K]) => void }>;
};

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs ?? {})) {
    if (v === undefined || v === false) continue;
    el.setAttribute(k, v === true ? "" : v);
  }
  for (const [k, v] of Object.entries(props.dataset ?? {})) el.dataset[k] = v;
  for (const [type, fn] of Object.entries(props.on ?? {})) el.addEventListener(type, fn as EventListener);
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === "number" ? String(c) : c);
  }
  return el;
}

export function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} がありません`);
  return el;
}

/** 画面上部のお知らせ欄（role="status"）にメッセージを出す。エラー以外は 8 秒で消す */
export function notify(message: string, kind: "info" | "error" = "info"): void {
  const region = $("status");
  const msg = h("div", { class: `msg ${kind}`, text: kind === "error" ? `エラー：${message}` : message });
  region.append(msg);
  if (kind !== "error") setTimeout(() => msg.remove(), 8000);
  else setTimeout(() => msg.remove(), 20000);
}

/** 削除などの確認。ネイティブの <dialog> を showModal() で開き、押されたボタンで結果を返す */
export function confirmDialog(message: string, okLabel = "削除する"): Promise<boolean> {
  const dialog = $("confirm-dialog") as HTMLDialogElement;
  $("confirm-message").textContent = message;
  $("confirm-ok").textContent = okLabel;
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener(
      "close",
      () => {
        const ok = dialog.returnValue === "ok";
        dialog.returnValue = "";
        resolve(ok);
      },
      { once: true },
    );
  });
}

/** closedby="any"（背景のクリックで閉じる）に未対応のブラウザ（Safari）向けの代替 */
export function enableLightDismissFallback(dialog: HTMLDialogElement): void {
  if ("closedBy" in HTMLDialogElement.prototype) return;
  const outside = (e: PointerEvent) => {
    const r = dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  let pressedOutside = false;
  dialog.addEventListener("pointerdown", (e) => (pressedOutside = outside(e)));
  dialog.addEventListener("pointerup", (e) => {
    if (pressedOutside && outside(e)) dialog.close();
  });
}

/** 入力欄のエラー文を、:user-invalid のときだけ aria-describedby に入れる（読み上げとの整合） */
export function syncFieldErrors(form: HTMLFormElement): void {
  const update = (input: HTMLInputElement) => {
    const errorId = input.dataset.error;
    if (!errorId) return;
    const invalid = input.matches(":user-invalid");
    input.setAttribute("aria-invalid", String(invalid));
    const ids = (input.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((id) => id && id !== errorId);
    if (invalid) ids.push(errorId);
    if (ids.length) input.setAttribute("aria-describedby", ids.join(" "));
    else input.removeAttribute("aria-describedby");
  };
  for (const type of ["input", "blur", "invalid"] as const) {
    form.addEventListener(type, (e) => e.target instanceof HTMLInputElement && update(e.target), true);
  }
}

type TimestampLike = { toDate(): Date } | null | undefined;

const dateFmt = new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Tokyo" });

export function formatDate(ts: TimestampLike): string {
  if (!ts || typeof ts.toDate !== "function") return "—";
  return dateFmt.format(ts.toDate());
}

export function relative(ts: TimestampLike): string {
  if (!ts || typeof ts.toDate !== "function") return "—";
  const diffMin = Math.round((Date.now() - ts.toDate().getTime()) / 60000);
  if (diffMin < 1) return "たった今";
  if (diffMin < 60) return `${diffMin} 分前`;
  if (diffMin < 60 * 24) return `${Math.round(diffMin / 60)} 時間前`;
  return `${Math.round(diffMin / 60 / 24)} 日前`;
}

export function errorMessage(e: unknown): string {
  const code = (e as { code?: string })?.code;
  if (code === "permission-denied") return "権限がありません（社内アカウントでログインしているか、役割を確認してください）";
  return e instanceof Error ? e.message : String(e);
}
