"use strict";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const FORMATTERS = new Map();

function formatterFor(timeZone) {
  if (!FORMATTERS.has(timeZone)) {
    FORMATTERS.set(timeZone, new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }));
  }
  return FORMATTERS.get(timeZone);
}

function zonedClock(date, timeZone) {
  const values = {};
  formatterFor(timeZone).formatToParts(date).forEach((part) => {
    if (part.type !== "literal") values[part.type] = part.value;
  });
  return {
    weekday: values.weekday,
    minuteOfDay: Number(values.hour) * 60 + Number(values.minute),
  };
}

function isWeekday(weekday) {
  return weekday !== "Sat" && weekday !== "Sun";
}

function inWindows(minuteOfDay, windows) {
  return windows.some(([start, end]) => minuteOfDay >= start && minuteOfDay <= end);
}

function marketGroupForHolding(holding) {
  if (!holding) return "other";
  if (holding.market === "sh" || holding.market === "sz") return "cn";
  if (holding.market === "hk") return "hk";
  if (holding.market === "nasdaq" || holding.market === "nyse") return "us";
  if (holding.market === "crypto") return "crypto";
  if (holding.market === "fund") return "fund";
  return "other";
}

function marketSession(group, date = new Date()) {
  if (group === "crypto") return { active: true, label: "24x7" };

  if (group === "us") {
    const clock = zonedClock(date, "America/New_York");
    return {
      active: isWeekday(clock.weekday) && inWindows(clock.minuteOfDay, [[4 * 60, 20 * 60 + 10]]),
      label: "US extended hours",
    };
  }

  const clock = zonedClock(date, "Asia/Shanghai");
  if (group === "cn") {
    return {
      active: isWeekday(clock.weekday) && inWindows(clock.minuteOfDay, [
        [9 * 60 + 15, 11 * 60 + 40],
        [12 * 60 + 55, 15 * 60 + 10],
      ]),
      label: "CN session",
    };
  }
  if (group === "hk") {
    return {
      active: isWeekday(clock.weekday) && inWindows(clock.minuteOfDay, [
        [9 * 60 + 15, 12 * 60 + 10],
        [12 * 60 + 55, 16 * 60 + 20],
      ]),
      label: "HK session",
    };
  }
  if (group === "fund") {
    return {
      // 场外基金盘中很少变化，净值主要在收盘后陆续发布；活跃窗口也只需低频轮询。
      active: isWeekday(clock.weekday) && inWindows(clock.minuteOfDay, [
        [9 * 60, 15 * 60 + 30],
        [17 * 60 + 30, 23 * 60 + 30],
      ]),
      label: "fund NAV window",
    };
  }
  return { active: false, label: "other" };
}

function basePollIntervalMs(group, date = new Date()) {
  const { active } = marketSession(group, date);
  if (group === "crypto") return 12 * SECOND;
  if (group === "fund") return active ? 30 * MINUTE : 4 * HOUR;
  if (group === "other") return 30 * MINUTE;
  // 休市五分钟探测一次，避免开盘边界最多延迟超过五分钟。
  return active ? 12 * SECOND : 5 * MINUTE;
}

function pollDelayMs(group, date = new Date(), consecutiveFailures = 0) {
  const base = basePollIntervalMs(group, date);
  if (consecutiveFailures <= 0) return base;
  const { active } = marketSession(group, date);
  const cap = active ? 2 * MINUTE : Math.max(base, group === "fund" ? 12 * HOUR : 30 * MINUTE);
  return Math.min(base * (2 ** Math.min(consecutiveFailures, 8)), cap);
}

module.exports = {
  basePollIntervalMs,
  marketGroupForHolding,
  marketSession,
  pollDelayMs,
  zonedClock,
};
