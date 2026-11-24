// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0
import type { LookupAddress } from "node:dns";
import { describe, expect, it } from "vitest";
import { assertSafeUrlShape, createGuardedLookup, isBlockedAddress, UnsafeUrlError } from "../src/lib/safeFetch.js";

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // メタデータサーバー
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "::ffff:10.0.0.1",
    "::ffff:169.254.169.254",
    "64:ff9b::a00:1",
    "not-an-ip",
  ])("%s は接続しない", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "142.250.196.110", "172.32.0.1", "2001:4860:4860::8888"])("%s は接続してよい", (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe("assertSafeUrlShape", () => {
  it("https の公開ホストは通す", () => {
    expect(assertSafeUrlShape("https://www.example.com/feed.xml").hostname).toBe("www.example.com");
  });

  it.each([
    ["http://example.com/", "https://"],
    ["ftp://example.com/", "https://"],
    ["https://user:pass@example.com/", "ユーザー名"],
    ["https://example.com:8443/", "443"],
    ["https://localhost/", "内部"],
    ["https://metadata.google.internal/computeMetadata/v1/", "内部"],
    ["https://foo.internal/", "内部"],
    ["https://intranet/", "ドメイン名"],
    ["https://127.0.0.1/", "内部"],
    ["https://169.254.169.254/", "内部"],
    ["https://[::1]/", "内部"],
    ["not a url", "形式"],
  ])("%s は拒否する", (url, message) => {
    expect(() => assertSafeUrlShape(url)).toThrow(UnsafeUrlError);
    expect(() => assertSafeUrlShape(url)).toThrow(message);
  });
});

describe("createGuardedLookup", () => {
  const fakeDns =
    (addresses: LookupAddress[]) =>
    (_host: string, _opts: { all: true }, cb: (err: NodeJS.ErrnoException | null, a: LookupAddress[]) => void) =>
      cb(null, addresses);

  const run = (addresses: LookupAddress[], options: { all?: boolean } = {}) =>
    new Promise<unknown>((resolve, reject) => {
      const lookup = createGuardedLookup(fakeDns(addresses)) as unknown as (
        h: string,
        o: object,
        cb: (err: Error | null, ...rest: unknown[]) => void,
      ) => void;
      lookup("example.com", options, (err, ...rest) => (err ? reject(err) : resolve(rest)));
    });

  it("公開アドレスなら接続先を返す", async () => {
    await expect(run([{ address: "93.184.216.34", family: 4 }])).resolves.toEqual(["93.184.216.34", 4]);
  });

  it("all: true なら一覧を返す", async () => {
    const list = [{ address: "93.184.216.34", family: 4 }];
    await expect(run(list, { all: true })).resolves.toEqual([list]);
  });

  it("名前解決の結果に内部アドレスが 1 つでもあれば拒否する（DNS リバインディング対策）", async () => {
    await expect(
      run([
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ]),
    ).rejects.toThrow(UnsafeUrlError);
  });
});
