// TypeScript のスクリプトを esbuild でまとめて実行する（tsx などの依存を増やさないため）
//   node scripts/run-ts.mjs scripts/sync-watchlist.ts [引数...]
// まとめたファイルは node_modules/.cache/ に置く（Git 管理外・デプロイ対象外）
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { basename } from "node:path";

const [entry, ...args] = process.argv.slice(2);
if (!entry) {
  console.error("使い方: node scripts/run-ts.mjs <script.ts> [引数...]");
  process.exit(2);
}

const outfile = `node_modules/.cache/news-watcher-scripts/${basename(entry, ".ts")}.mjs`;
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  logLevel: "warning",
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});

const res = spawnSync(process.execPath, [outfile, ...args], { stdio: "inherit" });
process.exit(res.status ?? 1);
