import { describe, expect, it } from "vitest";
import {
  mapKeyboardEventToDeviceKey,
  mapKeyboardEventToEmulatorKey,
} from "../EmulatorStream";

function makeEvent(
  partial: Partial<{
    key: string;
    code: string;
    isComposing: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
  }> = {},
) {
  return {
    key: "",
    code: "",
    isComposing: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...partial,
  };
}

describe("mapKeyboardEventToDeviceKey", () => {
  it("preserves printable characters for Android text injection", () => {
    expect(mapKeyboardEventToDeviceKey(makeEvent({ key: "a" }))).toBe("a");
    expect(mapKeyboardEventToDeviceKey(makeEvent({ key: "7" }))).toBe("7");
    expect(mapKeyboardEventToDeviceKey(makeEvent({ key: "A" }))).toBe("A");
    expect(mapKeyboardEventToDeviceKey(makeEvent({ key: "!" }))).toBe("!");
  });

  it("maps common navigation/editing keys", () => {
    expect(mapKeyboardEventToDeviceKey(makeEvent({ key: "Backspace" }))).toBe(
      "KEYCODE_DEL",
    );
    expect(mapKeyboardEventToDeviceKey(makeEvent({ key: "Enter" }))).toBe(
      "KEYCODE_ENTER",
    );
    expect(mapKeyboardEventToDeviceKey(makeEvent({ key: "ArrowLeft" }))).toBe(
      "KEYCODE_DPAD_LEFT",
    );
  });

  it("maps punctuation using key values", () => {
    expect(mapKeyboardEventToDeviceKey(makeEvent({ key: "." }))).toBe(".");
    expect(mapKeyboardEventToDeviceKey(makeEvent({ key: " " }))).toBe(" ");
  });

  it("falls back to keyboard code mapping when needed", () => {
    expect(
      mapKeyboardEventToDeviceKey(makeEvent({ key: "!", code: "Digit1" })),
    ).toBe("!");
    expect(
      mapKeyboardEventToDeviceKey(makeEvent({ key: "_", code: "Minus" })),
    ).toBe("_");
  });

  it("ignores composing and modifier chords", () => {
    expect(
      mapKeyboardEventToDeviceKey(makeEvent({ key: "a", isComposing: true })),
    ).toBeNull();
    expect(
      mapKeyboardEventToDeviceKey(makeEvent({ key: "c", ctrlKey: true })),
    ).toBeNull();
    expect(
      mapKeyboardEventToDeviceKey(makeEvent({ key: "v", metaKey: true })),
    ).toBeNull();
  });

  it("uses emulator key semantics for emulator device type", () => {
    expect(
      mapKeyboardEventToDeviceKey(makeEvent({ key: "A" }), "emulator"),
    ).toBe("A");
    expect(
      mapKeyboardEventToDeviceKey(makeEvent({ key: "!" }), "emulator"),
    ).toBe("!");
    expect(
      mapKeyboardEventToDeviceKey(makeEvent({ key: "ArrowLeft" }), "emulator"),
    ).toBe("ArrowLeft");
  });

  it("uses emulator-style key semantics for ios simulator device type", () => {
    expect(
      mapKeyboardEventToDeviceKey(makeEvent({ key: "A" }), "ios-simulator"),
    ).toBe("A");
    expect(
      mapKeyboardEventToDeviceKey(makeEvent({ key: "Enter" }), "ios-simulator"),
    ).toBe("Enter");
  });
});

describe("mapKeyboardEventToEmulatorKey", () => {
  it("preserves shifted printable characters", () => {
    expect(mapKeyboardEventToEmulatorKey(makeEvent({ key: "A" }))).toBe("A");
    expect(mapKeyboardEventToEmulatorKey(makeEvent({ key: "@" }))).toBe("@");
  });

  it("ignores standalone modifier keys", () => {
    expect(
      mapKeyboardEventToEmulatorKey(makeEvent({ key: "Shift" })),
    ).toBeNull();
    expect(
      mapKeyboardEventToEmulatorKey(makeEvent({ key: "Control" })),
    ).toBeNull();
  });
});
