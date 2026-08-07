import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isValidCronExpression,
  matchesCron,
  parseCronExpression,
} from "../../../../packages/server/src/loop/trigger/cron-matcher.js";

function at(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

test("day-of-week 7 is accepted as Sunday", () => {
  const schedule = parseCronExpression("0 0 * * 7");
  assert.equal(matchesCron(schedule, at(2026, 7, 26, 0, 0)), true); // Sunday
  assert.equal(matchesCron(schedule, at(2026, 7, 22, 0, 0)), false); // Wednesday
});

test("hour range with step hits only stepped values", () => {
  const schedule = parseCronExpression("0 9-17/4 * * *");
  assert.equal(matchesCron(schedule, at(2026, 7, 22, 9, 0)), true);
  assert.equal(matchesCron(schedule, at(2026, 7, 22, 13, 0)), true);
  assert.equal(matchesCron(schedule, at(2026, 7, 22, 17, 0)), true);
  assert.equal(matchesCron(schedule, at(2026, 7, 22, 11, 0)), false);
  assert.equal(matchesCron(schedule, at(2026, 7, 22, 21, 0)), false);
});

test("month list and day-of-week range work together (AND semantics)", () => {
  // 2026-07-22 is a Wednesday (getDay() === 3)
  const weekdaysInJuly = parseCronExpression("30 8 * 1,7 1-5");
  assert.equal(matchesCron(weekdaysInJuly, at(2026, 7, 22, 8, 30)), true);
  assert.equal(matchesCron(weekdaysInJuly, at(2026, 8, 22, 8, 30)), false); // August
  // 2026-07-25 is a Saturday
  assert.equal(matchesCron(weekdaysInJuly, at(2026, 7, 25, 8, 30)), false);
});

test("comma list of plain numbers and ranges can mix", () => {
  const schedule = parseCronExpression("0,30 8-10 * * *");
  assert.equal(matchesCron(schedule, at(2026, 7, 22, 8, 30)), true);
  assert.equal(matchesCron(schedule, at(2026, 7, 22, 10, 0)), true);
  assert.equal(matchesCron(schedule, at(2026, 7, 22, 10, 15)), false);
  assert.equal(matchesCron(schedule, at(2026, 7, 22, 11, 0)), false);
});

test("day-of-month list matches only listed days", () => {
  const schedule = parseCronExpression("0 0 1,15 * *");
  assert.equal(matchesCron(schedule, at(2026, 7, 1, 0, 0)), true);
  assert.equal(matchesCron(schedule, at(2026, 7, 15, 0, 0)), true);
  assert.equal(matchesCron(schedule, at(2026, 7, 2, 0, 0)), false);
});

test("whitespace variants parse correctly", () => {
  assert.equal(isValidCronExpression("  */5   *  * *  *  "), true);
  const schedule = parseCronExpression("  */5   *  * *  *  ");
  assert.equal(matchesCron(schedule, at(2026, 7, 22, 14, 10)), true);
  assert.equal(matchesCron(schedule, at(2026, 7, 22, 14, 11)), false);
});

test("inverted range and dangling range are rejected", () => {
  assert.equal(isValidCronExpression("10-5 * * * *"), false);
  assert.equal(isValidCronExpression("1- * * * *"), false);
});
