// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0
// 配信履歴：まとめ配信と「今すぐ共有」の記録
import { collection, limit, onSnapshot, orderBy, query } from "firebase/firestore";
import type { AppState, Delivery } from "./types";
import { $, errorMessage, formatDate, h, notify } from "./ui";

export function initDeliveries(state: AppState): { refresh: () => void } {
  const tbody = $("delivery-list");
  let deliveries: Delivery[] = [];

  onSnapshot(
    query(collection(state.db, "deliveries"), orderBy("postedAt", "desc"), limit(50)),
    (snap) => {
      deliveries = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Delivery, "id">) }));
      render();
    },
    (e) => notify(`配信履歴を読み込めませんでした：${errorMessage(e)}`, "error"),
  );

  function render() {
    tbody.replaceChildren(
      ...deliveries.map((d) =>
        h(
          "tr",
          {},
          h("td", { text: formatDate(d.postedAt) }),
          h("td", { text: d.trigger === "manual" ? `今すぐ共有${d.requestedBy ? `（${d.requestedBy}）` : ""}` : "まとめ配信" }),
          h("td", {
            text: d.digestId
              ? (state.digests.get(d.digestId)?.name ?? d.digestId)
              : d.topicId
                ? (state.topics.get(d.topicId)?.name ?? d.topicId)
                : "—",
          }),
          h("td", { text: state.channels.get(d.channelId)?.displayName ?? d.channelId }),
          h("td", { text: String(d.articleIds?.length ?? 0) }),
          h("td", {}, h("span", { class: `badge ${d.status === "ok" ? "ok" : "error"}`, text: d.status === "ok" ? "成功" : "失敗" }), d.error ? ` ${d.error}` : null),
        ),
      ),
    );
    if (deliveries.length === 0) tbody.append(h("tr", {}, h("td", { attrs: { colspan: "6" }, class: "muted", text: "まだ配信はありません。" })));
  }

  return { refresh: render };
}
