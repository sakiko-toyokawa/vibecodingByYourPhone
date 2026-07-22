/**
 * Minimal 5-field cron matcher (spec: docs/spec/05-分阶段计划.md phase 0 —
 * in-process scheduler, no third-party cron dependency).
 *
 * Supported syntax per field: `*`, `* /n` (step), plain numbers, comma
 * lists, and hyphen ranges (ranges also accept an optional `/n` step).
 * Fields: minute (0-59), hour (0-23), day-of-month (1-31), month (1-12),
 * day-of-week (0-6; 7 is accepted and mapped to Sunday).
 *
 * Deliberate simplification vs Vixie cron: when BOTH day-of-month and
 * day-of-week are restricted, this matcher requires both to match (AND),
 * where classic cron ORs them. Phase-0 loops use `*` for at least one of
 * the two, where both semantics agree.
 */

export class CronParseError extends Error {
  constructor(
    message: string,
    readonly expression: string,
  ) {
    super(message);
    this.name = "CronParseError";
  }
}

interface CronField {
  min: number;
  max: number;
  values: ReadonlySet<number>;
}

export interface CronSchedule {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

const FIELD_BOUNDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  // 7 is accepted as an alias for Sunday (0) at parse time
  { name: "day-of-week", min: 0, max: 6 },
] as const;

type FieldBounds = (typeof FIELD_BOUNDS)[number];

function parseField(
  raw: string,
  bounds: FieldBounds,
  expression: string,
): CronField {
  const fail = (reason: string): never => {
    throw new CronParseError(
      `Invalid cron field '${raw}' (${bounds.name}): ${reason}`,
      expression,
    );
  };

  const values = new Set<number>();
  for (const part of raw.split(",")) {
    if (part.length === 0) {
      fail("empty list element");
    }
    const match = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part);
    if (!match || match[1] === undefined) {
      fail("expected '*', a number, a range, or an optional '/step'");
      throw new CronParseError("unreachable", expression);
    }
    const startToken: string = match[1];
    const endToken = match[2];
    const stepToken = match[3];
    const step = stepToken !== undefined ? Number(stepToken) : 1;
    if (step < 1) {
      fail("step must be >= 1");
    }

    let lo: number;
    let hi: number;
    if (startToken === "*") {
      if (endToken !== undefined) {
        fail("'*' cannot be used in a range");
      }
      lo = bounds.min;
      hi = bounds.max;
    } else {
      lo = Number(startToken);
      hi = endToken !== undefined ? Number(endToken) : lo;
      // A step without a range (e.g. "5/2") is ambiguous — reject it.
      if (endToken === undefined && stepToken !== undefined) {
        fail("step requires '*' or a range");
      }
    }

    // day-of-week alias: 7 means Sunday
    const normalize = (v: number): number =>
      bounds.name === "day-of-week" && v === 7 ? 0 : v;
    if (lo > hi) {
      fail(`range start ${lo} is greater than range end ${hi}`);
    }
    if (
      lo < bounds.min ||
      hi > bounds.max + (bounds.name === "day-of-week" ? 1 : 0)
    ) {
      fail(`value out of range ${bounds.min}-${bounds.max}`);
    }

    for (let v = lo; v <= hi; v += step) {
      values.add(normalize(v));
    }
  }

  if (values.size === 0) {
    fail("field matches nothing");
  }
  return { min: bounds.min, max: bounds.max, values };
}

/**
 * Parse a 5-field cron expression. Throws CronParseError on anything
 * outside the supported subset.
 */
export function parseCronExpression(expression: string): CronSchedule {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronParseError(
      `Cron expression must have exactly 5 fields, got ${fields.length}`,
      expression,
    );
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields.map(
    (field, i) => {
      const bounds = FIELD_BOUNDS[i];
      if (!bounds) {
        throw new CronParseError(`Unexpected field index ${i}`, expression);
      }
      return parseField(field, bounds, expression);
    },
  );
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) {
    throw new CronParseError("Failed to parse cron fields", expression);
  }
  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

/** True when the expression is parseable in the supported subset. */
export function isValidCronExpression(expression: string): boolean {
  try {
    parseCronExpression(expression);
    return true;
  } catch {
    return false;
  }
}

/**
 * Test a parsed schedule against a Date (local server time — cron is
 * evaluated in the server's timezone, matching how the loop operator
 * reads "0 2 * * *").
 */
export function matchesCron(schedule: CronSchedule, date: Date): boolean {
  return (
    schedule.minute.values.has(date.getMinutes()) &&
    schedule.hour.values.has(date.getHours()) &&
    schedule.dayOfMonth.values.has(date.getDate()) &&
    schedule.month.values.has(date.getMonth() + 1) &&
    schedule.dayOfWeek.values.has(date.getDay())
  );
}
