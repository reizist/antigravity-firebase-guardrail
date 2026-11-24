// 関数を 1 ファイル（lib/index.js）にまとめる。
// firebase-functions / firebase-admin だけはバンドルせず、クラウド側のビルドでインストールする（package.json の dependencies）。
// それ以外の依存（@google/genai / fast-xml-parser / node-html-parser）はバンドルに含めるので、
// クラウド側でインストールされる依存は最小限になる（docs/platform_design.md §7.2）。
import { build } from "esbuild";
import { readFile } from "node:fs/promises";

const pkg = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));
const external = Object.keys(pkg.dependencies ?? {}).flatMap((name) => [name, `${name}/*`]);

await build({
  entryPoints: ["src/index.ts"],
  outfile: "lib/index.js",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: true,
  external,
  // ESM のバンドル内で CommonJS の依存が require を使えるようにする
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: "info",
});
