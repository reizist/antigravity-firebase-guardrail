// ==============================================================================
// cron 形式（分 時 日 月 曜日）の判定（依存を増やさないための最小実装）
//   対応: *  数値  a-b  a,b  */n  a-b/n。曜日は 0〜7（0 と 7 が日曜）
//   日と曜日の両方が指定されたときは、一般的な cron と同じく「どちらかが合えば」実行する
// ==============================================================================

const FIELD_RANGES: [number, number][] = [
  [0, 59], // 分
  [0, 23], // 時
  [1, 31], // 日
  [1, 12], // 月
  [0, 7], // 曜日
];

function parseField(field: string, [min, max]: [number, number]): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) throw new Error(`cron の書式が正しくありません: ${field}`);
    const [, range, stepStr] = m;
    const step = stepStr ? Number(stepStr) : 1;
    if (step < 1) throw new Error(`cron の間隔が正しくありません: ${field}`);
    let from = min;
    let to = max;
    if (range !== "*") {
      const [a, b] = range!.split("-").map(Number) as [number, number | undefined];
      from = a;
      to = b ?? (stepStr ? max : a);
    }
    if (from < min || to > max || from > to) throw new Error(`cron の値が範囲外です: ${field}`);
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return values;
}

export interface CronSchedule {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  dayRestricted: boolean;
  weekdayRestricted: boolean;
}

export function parseCron(expr: string): CronSchedule {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron は 5 項目（分 時 日 月 曜日）で書いてください: ${expr}`);
  const [mi, h, d, mo, w] = fields as [string, string, string, string, string];
  const weekdays = parseField(w, FIELD_RANGES[4]!);
  if (weekdays.has(7)) weekdays.add(0);
  return {
    minutes: parseField(mi, FIELD_RANGES[0]!),
    hours: parseField(h, FIELD_RANGES[1]!),
    days: parseField(d, FIELD_RANGES[2]!),
    months: parseField(mo, FIELD_RANGES[3]!),
    weekdays,
    dayRestricted: d !== "*",
    weekdayRestricted: w !== "*",
  };
}

/** 指定したタイムゾーンでの日時の各要素 */
export function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    minute: Number(get("minute")),
    hour: Number(get("hour")),
    day: Number(get("day")),
    month: Number(get("month")),
    weekday: weekdayMap[get("weekday")] ?? 0,
  };
}

export function cronMatches(schedule: CronSchedule, date: Date, timeZone: string): boolean {
  const p = zonedParts(date, timeZone);
  if (!schedule.minutes.has(p.minute) || !schedule.hours.has(p.hour) || !schedule.months.has(p.month)) return false;
  const dayOk = schedule.days.has(p.day);
  const weekdayOk = schedule.weekdays.has(p.weekday);
  if (schedule.dayRestricted && schedule.weekdayRestricted) return dayOk || weekdayOk;
  return dayOk && weekdayOk;
}

/**
 * now の直前 windowMinutes 分（now を含み、now - window は含まない）に、cron の時刻が来ていれば true。
 * deliverDigests は 15 分ごとに起動するので、その間に来た配信時刻を拾う
 */
export function isCronDue(expr: string, now: Date, windowMinutes: number, timeZone: string): boolean {
  const schedule = parseCron(expr);
  const end = Math.floor(now.getTime() / 60_000) * 60_000;
  for (let i = 0; i < windowMinutes; i++) {
    if (cronMatches(schedule, new Date(end - i * 60_000), timeZone)) return true;
  }
  return false;
}
