// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0
// ==============================================================================
// 配信先（Google Chat / Slack）
//   どちらも Incoming Webhook に JSON を POST するだけ。違うのはメッセージの組み立てだけ
//   （docs/news_watcher_design.md §2）。Webhook URL は Secret Manager から受け取る
// ==============================================================================

import { ALLOWED_WEBHOOK_HOSTS } from "../config.js";
import type { ChannelDoc } from "../types.js";

export interface DigestItem {
  title: string;
  url: string;
  summary: string;
  sourceName?: string;
  score?: number;
  /** トピック名（定期配信で、どのトピックとして選ばれたか） */
  label?: string;
}

export interface DigestMessage {
  /** 見出し（例: 「競合動向」のまとめ） */
  heading: string;
  items: DigestItem[];
  /** 共有した人のコメント（「今すぐ共有」のとき） */
  comment?: string;
  /** アプリの URL（一覧へのリンク） */
  appUrl?: string;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ---- Google Chat（Cards v2） ----------------------------------------------------

/** Chat のテキストで特別な意味を持つ文字を無害化する */
function chatText(s: string): string {
  return s.replace(/[<>]/g, (c) => (c === "<" ? "＜" : "＞"));
}

export function buildGoogleChatPayload(msg: DigestMessage) {
  const sections = msg.items.map((item) => ({
    collapsible: false,
    widgets: [
      {
        decoratedText: {
          topLabel: [item.sourceName, item.label, item.score !== undefined ? `関連度 ${item.score}` : undefined].filter(Boolean).join(" ・ "),
          text: `<b>${chatText(truncate(item.title, 200))}</b>`,
          wrapText: true,
        },
      },
      ...(item.summary ? [{ textParagraph: { text: chatText(truncate(item.summary, 400)) } }] : []),
      { buttonList: { buttons: [{ text: "記事を開く", onClick: { openLink: { url: item.url } } }] } },
    ],
  }));

  return {
    text: msg.comment ? `${chatText(msg.heading)}\n${chatText(truncate(msg.comment, 500))}` : chatText(msg.heading),
    cardsV2: [
      {
        cardId: "news-watcher-digest",
        card: {
          header: { title: truncate(msg.heading, 100), subtitle: `${msg.items.length} 件` },
          sections: [
            ...sections,
            ...(msg.appUrl
              ? [{ widgets: [{ buttonList: { buttons: [{ text: "news-watcher で一覧を見る", onClick: { openLink: { url: msg.appUrl } } }] } }] }]
              : []),
          ],
        },
      },
    ],
  };
}

// ---- Slack（Block Kit） ---------------------------------------------------------

/** Slack の mrkdwn で特別な意味を持つ文字をエスケープする */
function slackText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildSlackPayload(msg: DigestMessage) {
  const blocks: unknown[] = [{ type: "header", text: { type: "plain_text", text: truncate(msg.heading, 150), emoji: true } }];
  if (msg.comment) blocks.push({ type: "section", text: { type: "mrkdwn", text: slackText(truncate(msg.comment, 500)) } });
  for (const item of msg.items) {
    const meta = [item.sourceName, item.label, item.score !== undefined ? `関連度 ${item.score}` : undefined].filter(Boolean).join(" ・ ");
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*<${item.url}|${slackText(truncate(item.title, 200))}>*${item.summary ? `\n${slackText(truncate(item.summary, 400))}` : ""}`,
      },
    });
    if (meta) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: slackText(meta) }] });
  }
  if (msg.appUrl) {
    blocks.push({ type: "divider" });
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `<${msg.appUrl}|news-watcher で一覧を見る>` }] });
  }
  return { text: `${msg.heading}（${msg.items.length} 件）`, blocks };
}

// ---- 送信 ---------------------------------------------------------------------

export function buildPayload(type: ChannelDoc["type"], msg: DigestMessage): unknown {
  switch (type) {
    case "google_chat":
      return buildGoogleChatPayload(msg);
    case "slack":
      return buildSlackPayload(msg);
    default:
      throw new Error(`未対応の配信先です: ${String(type)}`);
  }
}

/** Webhook URL が、認めた送信先（Google Chat / Slack）かを確認する */
export function assertAllowedWebhook(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("Webhook URL は https である必要があります");
  if (!(ALLOWED_WEBHOOK_HOSTS as readonly string[]).includes(url.hostname)) {
    throw new Error(`Webhook の送信先として認めていないホストです: ${url.hostname}`);
  }
  return url;
}

export async function sendWebhook(webhookUrl: string, payload: unknown, fetchImpl: typeof fetch = fetch): Promise<void> {
  const url = assertAllowedWebhook(webhookUrl);
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify(payload),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    // 応答本文に Webhook URL が含まれることはないが、念のため先頭だけ残す
    const body = (await res.text()).slice(0, 200);
    throw new Error(`Webhook への送信に失敗しました（HTTP ${res.status}）: ${body}`);
  }
}
