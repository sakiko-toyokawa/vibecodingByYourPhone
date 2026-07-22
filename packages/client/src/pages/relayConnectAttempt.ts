export function buildRelayConnectKey(
  hostId: string,
  sessionId: string,
): string {
  return `${hostId}:${sessionId}`;
}

export function tryBeginRelayConnectAttempt(
  activeKey: string | null,
  nextKey: string,
): boolean {
  return activeKey !== nextKey;
}

export function finishRelayConnectAttempt(
  activeKey: string | null,
  completedKey: string,
): string | null {
  return activeKey === completedKey ? null : activeKey;
}
