// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0
// news-watcher の画面のエントリーポイント：ログイン・役割の確認・共通データの購読・画面の切り替え
import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut, type User } from "firebase/auth";
import { collection, doc, getDoc, onSnapshot, query, where, type Firestore } from "firebase/firestore";
import { initArticles } from "./articles";
import { initDeliveries } from "./deliveries";
import { initDigests } from "./digests";
import { INTERNAL_DOMAIN, initFirebase } from "./firebase";
import { initSources } from "./sources";
import { initTopics } from "./topics";
import type { AppState, Channel, Digest, Role, Source, Topic } from "./types";
import { $, errorMessage, notify } from "./ui";

const VIEWS = ["articles", "topics", "digests", "sources", "deliveries"] as const;
type View = (typeof VIEWS)[number];
const ROLE_LABEL: Record<Role, string> = { viewer: "閲覧", editor: "編集", admin: "管理者" };

async function main() {
  const { auth, db } = await initFirebase();

  $("sign-in").addEventListener("click", async () => {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ hd: INTERNAL_DOMAIN, prompt: "select_account" });
    try {
      await signInWithPopup(auth, provider);
    } catch (e) {
      showSigninError(`ログインできませんでした：${errorMessage(e)}`);
    }
  });
  // 購読を確実に止めるため、ログアウト後はページを読み込み直す
  $("sign-out").addEventListener("click", () => void signOut(auth).then(() => location.reload()));

  let unsubscribers: (() => void)[] = [];
  onAuthStateChanged(auth, async (user) => {
    for (const u of unsubscribers) u();
    unsubscribers = [];
    if (!user) return showSignin();
    const email = (user.email ?? "").toLowerCase();
    if (!email.endsWith(`@${INTERNAL_DOMAIN}`) || !user.emailVerified) {
      await signOut(auth);
      return showSigninError(`社内アカウント（@${INTERNAL_DOMAIN}）でログインしてください。`);
    }
    unsubscribers = await startApp(db, user, email);
  });
}

function showSignin() {
  $("view-signin").hidden = false;
  $("nav").hidden = true;
  $("user").hidden = true;
  for (const v of VIEWS) $(`view-${v}`).hidden = true;
}

function showSigninError(message: string) {
  showSignin();
  const el = $("signin-error");
  el.textContent = message;
  el.hidden = false;
}

async function loadRole(db: Firestore, email: string): Promise<Role> {
  try {
    const snap = await getDoc(doc(db, "members", email));
    const role = snap.data()?.role;
    return role === "editor" || role === "admin" ? role : "viewer";
  } catch {
    return "viewer";
  }
}

async function startApp(db: Firestore, user: User, email: string): Promise<(() => void)[]> {
  const state: AppState = {
    db,
    uid: user.uid,
    email,
    role: await loadRole(db, email),
    topics: new Map(),
    sources: new Map(),
    channels: new Map(),
    digests: new Map(),
    votes: new Map(),
  };

  $("view-signin").hidden = true;
  $("signin-error").hidden = true;
  $("nav").hidden = false;
  $("user").hidden = false;
  $("user-email").textContent = email;
  $("user-role").textContent = ROLE_LABEL[state.role];

  const views = {
    articles: initArticles(state),
    topics: initTopics(state),
    digests: initDigests(state),
    sources: initSources(state),
    deliveries: initDeliveries(state),
  };
  const refreshAll = () => Object.values(views).forEach((v) => v.refresh());

  const onError = (what: string) => (e: unknown) => notify(`${what}を読み込めませんでした：${errorMessage(e)}`, "error");
  const unsubscribers = [
    onSnapshot(collection(db, "topics"), (snap) => {
      state.topics = new Map(snap.docs.map((d) => [d.id, { id: d.id, ...(d.data() as Omit<Topic, "id">) }]));
      refreshAll();
    }, onError("トピック")),
    onSnapshot(collection(db, "sources"), (snap) => {
      state.sources = new Map(snap.docs.map((d) => [d.id, { id: d.id, ...(d.data() as Omit<Source, "id">) }]));
      refreshAll();
    }, onError("情報源")),
    onSnapshot(collection(db, "channels"), (snap) => {
      state.channels = new Map(snap.docs.map((d) => [d.id, { id: d.id, ...(d.data() as Omit<Channel, "id">) }]));
      refreshAll();
    }, onError("配信先")),
    onSnapshot(collection(db, "digests"), (snap) => {
      state.digests = new Map(snap.docs.map((d) => [d.id, { id: d.id, ...(d.data() as Omit<Digest, "id">) }]));
      refreshAll();
    }, onError("配信設定")),
    onSnapshot(query(collection(db, "feedback"), where("uid", "==", user.uid)), (snap) => {
      state.votes = new Map(snap.docs.map((d) => [d.data().articleId as string, d.data().vote as "up" | "down"]));
      views.articles.refresh();
    }, onError("フィードバック")),
  ];

  const route = () => {
    const view: View = (VIEWS as readonly string[]).includes(location.hash.slice(1)) ? (location.hash.slice(1) as View) : "articles";
    for (const v of VIEWS) $(`view-${v}`).hidden = v !== view;
    for (const a of document.querySelectorAll<HTMLAnchorElement>("#nav a")) {
      if (a.dataset.view === view) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
  };
  window.addEventListener("hashchange", route);
  route();
  return [...unsubscribers, () => window.removeEventListener("hashchange", route)];
}

main().catch((e) => notify(errorMessage(e), "error"));
