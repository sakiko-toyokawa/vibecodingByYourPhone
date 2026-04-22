import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InboxProvider,
  type InboxResponse,
  useInboxContext,
} from "../InboxContext";

const { mockGetInbox, remoteState } = vi.hoisted(() => ({
  mockGetInbox: vi.fn<() => Promise<InboxResponse>>(),
  remoteState: {
    connection: null as { connection: object | null } | null,
  },
}));

vi.mock("../../api/client", () => ({
  api: {
    getInbox: mockGetInbox,
  },
}));

vi.mock("../../hooks/useFileActivity", () => ({
  useFileActivity: vi.fn(),
}));

vi.mock("../../lib/connection", () => ({
  isRemoteClient: () => true,
}));

vi.mock("../RemoteConnectionContext", () => ({
  useOptionalRemoteConnection: () => remoteState.connection,
}));

function InboxConsumer() {
  const { error, loading, totalItems } = useInboxContext();
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="error">{error?.message ?? ""}</span>
      <span data-testid="total">{String(totalItems)}</span>
    </div>
  );
}

describe("InboxProvider", () => {
  beforeEach(() => {
    mockGetInbox.mockReset();
    mockGetInbox.mockResolvedValue({
      needsAttention: [],
      active: [],
      recentActivity: [],
      unread8h: [],
      unread24h: [],
    });
    remoteState.connection = null;
    window.history.replaceState({}, "", "/inbox");
  });

  afterEach(() => {
    remoteState.connection = null;
    vi.clearAllMocks();
  });

  it("does not fetch before remote connection is ready", async () => {
    render(
      <InboxProvider>
        <InboxConsumer />
      </InboxProvider>,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockGetInbox).not.toHaveBeenCalled();
  });

  it("fetches once the remote connection becomes available", async () => {
    const view = render(
      <InboxProvider>
        <InboxConsumer />
      </InboxProvider>,
    );

    expect(mockGetInbox).not.toHaveBeenCalled();

    remoteState.connection = { connection: {} };
    view.rerender(
      <InboxProvider>
        <InboxConsumer />
      </InboxProvider>,
    );

    await waitFor(() => {
      expect(mockGetInbox).toHaveBeenCalledTimes(1);
    });
  });
});
