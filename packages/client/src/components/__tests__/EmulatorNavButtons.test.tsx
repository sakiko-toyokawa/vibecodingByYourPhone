import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmulatorNavButtons } from "../EmulatorNavButtons";

function createDataChannel() {
  return {
    readyState: "open",
    send: vi.fn(),
  } as unknown as RTCDataChannel;
}

describe("EmulatorNavButtons", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders Android navigation controls for Android devices", () => {
    const dataChannel = createDataChannel();

    render(
      <EmulatorNavButtons dataChannel={dataChannel} deviceType="android" />,
    );

    expect(screen.getByRole("button", { name: "Back" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Home" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Recents" })).toBeDefined();
  });

  it("renders only Home for iOS simulators and sends GoHome", () => {
    const dataChannel = createDataChannel();

    render(
      <EmulatorNavButtons
        dataChannel={dataChannel}
        deviceType="ios-simulator"
      />,
    );

    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(screen.getByRole("button", { name: "Home" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Recents" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    expect(dataChannel.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "key", key: "GoHome" }),
    );
  });

  it("renders nothing for unsupported device types", () => {
    const dataChannel = createDataChannel();
    const { container } = render(
      <EmulatorNavButtons dataChannel={dataChannel} deviceType="chromeos" />,
    );

    expect(container.firstChild).toBeNull();
  });
});
