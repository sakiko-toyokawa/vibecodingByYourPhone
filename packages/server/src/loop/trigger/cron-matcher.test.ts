import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CronParseError,
  isValidCronExpression,
  matchesCron,
  parseCronExpression,
} from "./cron-matcher.js";

// Helper: local-time date (matcher uses server-local time)
function at(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

test("'* * * * *' matches every minute", () => {
  const schedule = parseCronExpression("* * * * *");
  assert.equal(matchesCron(schedule, at(2026, 7, 22, 14, 33)), true);
  assert.equal(matchesCron(schedule, at(2026, 1, 1, 0, 0)), true);
});

test("'*/5' in minute field matches 0/5/55 but not 3 or 59", () => {
  const schedule = parseCronExpression("*/5 * * * *");
  assert.equal(matchesCron(schedule, at(2026, 7, 22, 14, 0)), true);
  assert.equal(matchesCron(schedule, at(2026, 7, 22, 14, 5)), true);
  assert.equal(matchesCron(schedule, at(2026, 7, 22, 14, 55)), true);
  assert.equal(matchesCron(schedule, at(2026, 7, 22, 14, 3)), false);
  assert.equal(matchesCron(schedule, at(2026, 7, 22, 14, 59)), false);
});

test("'0 2 * * *' matches exactly 02:00", () => {
  const schedule = parseCronExpression("0 2 * * *");
  assert.equal(matchesCron(schedule, at(2026, 7, 22, 2, 0)), true);
  assert.equal(matchesCron(schedule, at(2026, 7, 22, 2, 1)), false);
  assert.equal(matchesCron(schedule, at(2026, 7, 22, 14, 0)), false);
});

test("hour range '0 9-17 * * *' matches bounds and rejects outside", () => {
  const schedule = parseCronExpression("0 9-17 * * *");
  assert.equal(matchesCron(schedule, at(2026, 7, 22, 9, 0)), true);
  assert.equal(matchesCron(schedule, at(2026, 7, 22, 17, 0)), true);
  assert.equal(matchesCron(schedule, at(2026, 7, 22, 8, 0)), false);
  assert.equal(matchesCron(schedule, at(2026, 7, 22, 18, 0)), false);
});

test("range with step '0 9-17/4 * * *' hits 9/13/17 only", () => {
  const schedule = parseCronExpression("0 9-17/4 * * *");
  assert.equal(matchesCron(schedule, at(2026, 7, 22, 9, 0)), true);
  assert.equal(matchesCron(schedule, at(2026, 7, 22, 13, 0)), true);
  assert.equal(matchesCron(schedule, at(2026, 7, 22, 17, 0)), true);
  assert.equal(matchesCron(schedule, at(2026, 7, 22, 11, 0)), false);
});

test("comma list '0 0 1,15 * *' matches day 1 and 15", () => {
  const schedule = parseCronExpression("0 0 1,15 * *");
  assert.equal(matchesCron(schedule, at(2026, 7, 1, 0, 0)), true);
  assert.equal(matchesCron(schedule, at(2026, 7, 15, 0, 0)), true);
  assert.equal(matchesCron(schedule, at(2026, 7, 2, 0, 0)), false);
});

test("month list and day-of-week range/list work together", () => {
  // 2026-07-22 is a Wednesday (getDay() === 3)
  const weekdays = parseCronExpression("30 8 * 1,7 1-5");
  assert.equal(matchesCron(weekdays, at(2026, 7, 22, 8, 30)), true);
  assert.equal(matchesCron(weekdays, at(2026, 8, 22, 8, 30)), false); // Aug
  // 2026-07-25 is a Saturday
  assert.equal(matchesCron(weekdays, at(2026, 7, 25, 8, 30)), false);

  const sunday = parseCronExpression("0 0 * * 0");
  assert.equal(matchesCron(sunday, at(2026, 7, 26, 0, 0)), true); // Sunday
  assert.equal(matchesCron(sunday, at(2026, 7, 22, 0, 0)), false);
});

test("day-of-week 7 is accepted as Sunday", () => {
  const schedule = parseCronExpression("0 0 * * 7");
  assert.equal(matchesCron(schedule, at(2026, 7, 26, 0, 0)), true); // Sunday
  assert.equal(matchesCron(schedule, at(2026, 7, 22, 0, 0)), false);
});

test("mixed list of range and numbers '0,30 8-10 * * *'", () => {
  const schedule = parseCronExpression("0,30 8-10 * * *");
  assert.equal(matchesCron(schedule, at(2026, 7, 22, 8, 30)), true);
  assert.equal(matchesCron(schedule, at(2026, 7, 22, 10, 0)), true);
  assert.equal(matchesCron(schedule, at(2026, 7, 22, 10, 15)), false);
  assert.equal(matchesCron(schedule, at(2026, 7, 22, 11, 0)), false);
});

test("invalid expressions are rejected", () => {
  const invalid = [
    "", // empty
    "* * * *", // too few fields
    "* * * * * *", // too many fields
    "*/0 * * * *", // zero step
    "61 * * * *", // minute out of range
    "* 24 * * *", // hour out of range
    "* * 0 * *", // day-of-month below min
    "* * * 13 *", // month out of range
    "* * * * 8", // day-of-week out of range
    "5-3 * * * *", // inverted range
    "5/2 * * * *", // step without range
    "a b c d e", // non-numeric
    "1,,2 * * * *", // empty list element
    "1- * * * *", // dangling range
  ];
  for (const expr of invalid) {
    assert.equal(
      isValidCronExpression(expr),
      false,
      `expected '${expr}' invalid`,
    );
    assert.throws(() => parseCronExpression(expr), CronParseError);
  }
});

test("whitespace variants parse fine", () => {
  assert.equal(isValidCronExpression("  */5   *  * *  *  "), true);
});
