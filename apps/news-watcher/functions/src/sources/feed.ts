// ==============================================================================
// RSS 2.0 / Atom / RSS 1.0（RDF）の解析
// ==============================================================================

import { XMLParser } from "fast-xml-parser";

export interface FeedItem {
  title: string;
  url: string;
  publishedAt: Date | null;
  /** 概要（HTML タグを除き、500 文字まで）。本文は保存しない */
  summary: string;
}

export interface ParsedFeed {
  title: string;
  items: FeedItem[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  removeNSPrefix: true,
  processEntities: true,
  htmlEntities: true,
  // 巨大なエンティティ展開（XML 爆弾）を避ける
  allowBooleanAttributes: true,
});

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function text(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v).trim();
  if (typeof v === "object" && "#text" in (v as Record<string, unknown>)) return text((v as Record<string, unknown>)["#text"]);
  return "";
}

/** HTML タグと連続する空白を取り除き、max 文字に切り詰める */
export function stripHtml(html: string, max = 500): string {
  const plain = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

function parseDate(v: unknown): Date | null {
  const s = text(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function atomLink(links: unknown): string {
  const list = asArray(links as Record<string, string> | Record<string, string>[]);
  const alternate = list.find((l) => !l["@_rel"] || l["@_rel"] === "alternate") ?? list[0];
  return alternate?.["@_href"] ?? text(alternate);
}

/** XML がフィードかどうか（ルート要素で判定） */
export function looksLikeFeed(body: string): boolean {
  const head = body.slice(0, 2048).replace(/<\?xml[^>]*\?>/, "").replace(/<!--[\s\S]*?-->/g, "").trimStart();
  return /^<(rss|feed|rdf:RDF|RDF)[\s>]/i.test(head);
}

/** フィードを解析する。フィードでなければ null */
export function parseFeed(xml: string, baseUrl?: string): ParsedFeed | null {
  if (!looksLikeFeed(xml)) return null;
  const doc = parser.parse(xml) as Record<string, any>;

  const resolve = (u: string) => {
    if (!u) return "";
    try {
      return new URL(u, baseUrl).toString();
    } catch {
      return "";
    }
  };

  // RSS 2.0
  if (doc.rss?.channel) {
    const ch = doc.rss.channel;
    return {
      title: text(ch.title),
      items: asArray(ch.item).map((it: any) => ({
        title: stripHtml(text(it.title), 300),
        url: resolve(text(it.link) || (it.guid?.["@_isPermaLink"] !== "false" ? text(it.guid) : "")),
        publishedAt: parseDate(it.pubDate ?? it.date),
        summary: stripHtml(text(it.description ?? it.encoded)),
      })),
    };
  }

  // Atom
  if (doc.feed) {
    const feed = doc.feed;
    return {
      title: text(feed.title),
      items: asArray(feed.entry).map((e: any) => ({
        title: stripHtml(text(e.title), 300),
        url: resolve(atomLink(e.link)),
        publishedAt: parseDate(e.published ?? e.updated),
        summary: stripHtml(text(e.summary ?? e.content)),
      })),
    };
  }

  // RSS 1.0（RDF）
  if (doc.RDF) {
    const rdf = doc.RDF;
    return {
      title: text(rdf.channel?.title),
      items: asArray(rdf.item).map((it: any) => ({
        title: stripHtml(text(it.title), 300),
        url: resolve(text(it.link)),
        publishedAt: parseDate(it.date ?? it.pubDate),
        summary: stripHtml(text(it.description)),
      })),
    };
  }

  return null;
}
