// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0
// 画面のビルド：src/main.ts を esbuild で 1 ファイルにまとめ、index.html・style.css と一緒に dist/ に置く
//   node build.mjs          # 本番用（ミニファイ）
//   node build.mjs --watch  # ローカル開発用（エミュレータの Hosting が dist/ を配信する）
import { context, build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const watch = process.argv.includes("--watch");
const options = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "esm",
  target: "es2023",
  outfile: "dist/app.js",
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  legalComments: "none",
  logLevel: "info",
};

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await cp("index.html", "dist/index.html");
await cp("style.css", "dist/style.css");

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
