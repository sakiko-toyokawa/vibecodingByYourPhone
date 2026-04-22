import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeRuntimePrompt } from "../EmulatorPage";

const { mockDownloadDeviceBridge } = vi.hoisted(() => ({
  mockDownloadDeviceBridge: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  api: {
    downloadDeviceBridge: mockDownloadDeviceBridge,
  },
}));

describe("BridgeRuntimePrompt", () => {
  beforeEach(() => {
    mockDownloadDeviceBridge.mockReset();
    mockDownloadDeviceBridge.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders update copy with version details", () => {
    render(
      <BridgeRuntimePrompt
        mode="update"
        installedVersion="0.1.0"
        latestVersion="0.2.0"
        onDownloaded={() => {}}
      />,
    );

    expect(
      screen.getByText(/needs a bridge runtime update before use/i),
    ).toBeDefined();
    expect(
      screen.getByText(/Installed: v0.1.0. Latest: v0.2.0./i),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "Update Bridge" })).toBeDefined();
  });

  it("calls the shared download endpoint for updates", async () => {
    const onDownloaded = vi.fn();

    render(<BridgeRuntimePrompt mode="update" onDownloaded={onDownloaded} />);

    fireEvent.click(screen.getByRole("button", { name: "Update Bridge" }));

    await waitFor(() => {
      expect(mockDownloadDeviceBridge).toHaveBeenCalledTimes(1);
      expect(onDownloaded).toHaveBeenCalledTimes(1);
    });
  });
});
