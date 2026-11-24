// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0
// Firebase の初期化
//   本番：Hosting の予約 URL /__/firebase/init.json から設定を読む（API キーなどをリポジトリに書かない）
//   localhost：エミュレータ（プロジェクト demo-news-watcher）につなぐ
import { initializeApp, type FirebaseOptions } from "firebase/app";
import { connectAuthEmulator, getAuth, type Auth } from "firebase/auth";
import { connectFirestoreEmulator, getFirestore, type Firestore } from "firebase/firestore";
// 社内ドメインは platform/config.json の 1 か所で決める（esbuild がビルド時に埋め込む）
import platform from "../../../../platform/config.json";

export const DATABASE_ID = "news-watcher";
export const INTERNAL_DOMAIN: string = platform.internal_domain;

const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);

async function loadConfig(): Promise<FirebaseOptions> {
  if (isLocal) {
    return { projectId: "demo-news-watcher", apiKey: "demo-api-key", authDomain: location.host, appId: "demo" };
  }
  const res = await fetch("/__/firebase/init.json");
  if (!res.ok) throw new Error(`Firebase の設定を読み込めませんでした（HTTP ${res.status}）`);
  return (await res.json()) as FirebaseOptions;
}

export async function initFirebase(): Promise<{ auth: Auth; db: Firestore }> {
  const app = initializeApp(await loadConfig());
  const auth = getAuth(app);
  const db = getFirestore(app, DATABASE_ID);
  if (isLocal) {
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    connectFirestoreEmulator(db, "127.0.0.1", 8080);
  }
  return { auth, db };
}
