export const MAINTENANCE_REQUEST_BEGIN = "<<<MAINTENANCE-REQUEST>>>";
export const MAINTENANCE_REQUEST_END = "<<<END-MAINTENANCE-REQUEST>>>";

export interface MaintenanceRequest {
  target_type: string;
  external_ref: Record<string, unknown>;
  wake_policy: {
    trigger_types: string[];
    max_repairs: number;
  };
  context_payload: Record<string, unknown>;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function nonEmptyObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseObject(raw: string): Record<string, unknown> | null {
  const candidates = [raw];
  const objectMatch = raw.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    candidates.push(objectMatch[0]);
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      ) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

export function extractMaintenanceRequest(
  finalText: string,
): MaintenanceRequest | null {
  const start = finalText.indexOf(MAINTENANCE_REQUEST_BEGIN);
  if (start === -1) {
    return null;
  }
  const contentStart = start + MAINTENANCE_REQUEST_BEGIN.length;
  const end = finalText.indexOf(MAINTENANCE_REQUEST_END, contentStart);
  if (end === -1) {
    return null;
  }
  const raw = finalText.slice(contentStart, end).trim();
  const object = parseObject(raw);
  if (!object) {
    return null;
  }
  const targetType = nonEmptyString(object.target_type);
  const externalRef = nonEmptyObject(object.external_ref);
  const contextPayload = nonEmptyObject(object.context_payload);
  const wakePolicy = nonEmptyObject(object.wake_policy);
  const triggerTypes = Array.isArray(wakePolicy?.trigger_types)
    ? wakePolicy.trigger_types.filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      )
    : [];
  const maxRepairs =
    typeof wakePolicy?.max_repairs === "number" &&
    Number.isFinite(wakePolicy.max_repairs) &&
    wakePolicy.max_repairs >= 1
      ? Math.trunc(wakePolicy.max_repairs)
      : 3;
  if (
    !targetType ||
    !externalRef ||
    !contextPayload ||
    triggerTypes.length === 0
  ) {
    return null;
  }
  const source = nonEmptyString(externalRef.source);
  const subjectId = nonEmptyString(externalRef.subject_id);
  if (!source || !subjectId) {
    return null;
  }
  return {
    target_type: targetType,
    external_ref: externalRef,
    wake_policy: { trigger_types: triggerTypes, max_repairs: maxRepairs },
    context_payload: contextPayload,
  };
}
