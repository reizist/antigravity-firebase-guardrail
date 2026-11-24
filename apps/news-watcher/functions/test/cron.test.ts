import { describe, expect, it } from "vitest";
import { isCronDue, parseCron } from "../src/digest/cron.js";

const TZ = "Asia/Tokyo";

describe("parseCron", () => {
  it("範囲・リスト・間隔を展開する", () => {
    const s = parseCron("*/15 9-18 * * 1-5");
    expect([...s.minutes]).toEqual([0, 15, 30, 45]);
    expect([...s.hours]).toHaveLength(10);
    expect([...s.weekdays]).toEqual([1, 2, 3, 4, 5]);
  });

  it("曜日の 7 は日曜（0）として扱う", () => {
    expect(parseCron("0 9 * * 7").weekdays.has(0)).toBe(true);
  });

  it.each(["0 9 * *", "60 9 * * *", "0 24 * * *", "a b c d e", "0 9 * * */0"])("不正な書式 %s はエラー", (expr) => {
    expect(() => parseCron(expr)).toThrow();
  });
});

describe("isCronDue", () => {
  // 2026-10-30 は金曜日。09:05 JST = 00:05 UTC
  const at = (iso: string) => new Date(iso);

  it("直前 15 分の間に配信時刻（JST 9:00）が来ていれば true", () => {
    expect(isCronDue("0 9 * * 1-5", at("2026-10-30T00:05:00Z"), 15, TZ)).toBe(true);
    expect(isCronDue("0 9 * * 1-5", at("2026-10-30T00:14:59Z"), 15, TZ)).toBe(true);
  });

  it("窓の外なら false（15 分ちょうど前は含まない）", () => {
    expect(isCronDue("0 9 * * 1-5", at("2026-10-30T00:15:00Z"), 15, TZ)).toBe(false);
    expect(isCronDue("0 9 * * 1-5", at("2026-10-29T23:59:00Z"), 15, TZ)).toBe(false);
  });

  it("曜日が合わなければ false（2026-10-31 は土曜日）", () => {
    expect(isCronDue("0 9 * * 1-5", at("2026-10-31T00:05:00Z"), 15, TZ)).toBe(false);
  });

  it("日と曜日の両方を指定したら、どちらかが合えば true", () => {
    // 1 日 または 金曜日
    expect(isCronDue("0 9 1 * 5", at("2026-10-30T00:05:00Z"), 15, TZ)).toBe(true);
  });
});
