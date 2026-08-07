import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CronParseError,
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

test("'* * * * *' matches every minute", () => {
  const schedule = parseCronExpression("* * * * *");
  assert.equal(matchesCron(schedule, at(2026, 7, 22, 14, 33)), true);
  assert.equal(matchesCron(schedule, at(2026, 1, 1, 0, 0)), true);
});

test("'0 2 * * *' matches exactly 02:00 local time", () => {
  const schedule = parseCronExpression("0 2 * * *");
  assert.equal(matchesCron(schedule, at(2026, 7, 22, 2, 0)), true);
  assert.equal(matchesCron(schedule, at(2026, 7, 22, 2, 1)), false);
  assert.equal(matchesCron(schedule, at(2026, 7, 22, 14, 0)), false);
});

test("minute step '*/5' hits 0/5/55 and rejects others", () => {
  const schedule = parseCronExpression("*/5 * * * *");
  assert.equal(matchesCron(schedule, at(2026, 7, 22, 14, 0)), true);
  assert.equal(matchesCron(schedule, at(2026, 7, 22, 14, 5)), true);
  assert.equal(matchesCron(schedule, at(2026, 7, 22, 14, 55)), true);
  assert.equal(matchesCron(schedule, at(2026, 7, 22, 14, 3)), false);
  assert.equal(matchesCron(schedule, at(2026, 7, 22, 14, 59)), false);
});

test("invalid expressions are rejected", () => {
  const invalid = [
    "",
    "* * * *",
    "* * * * * *",
    "*/0 * * * *",
    "61 * * * *",
    "* 24 * * *",
    "* * 0 * *",
    "* * * 13 *",
    "* * * * 8",
    "5-3 * * * *",
    "5/2 * * * *",
    "a b c d e",
    "1,,2 * * * *",
    "1- * * * *",
  ];
  for (const expr of invalid) {
    assert.equal(
      isValidCronExpression(expr),
      false,
      `expected '${expr}' to be invalid`,
    );
    assert.throws(() => parseCronExpression(expr), CronParseError);
  }
});
