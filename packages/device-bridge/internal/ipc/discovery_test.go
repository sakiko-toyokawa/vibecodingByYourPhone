package ipc

import "testing"

func TestParseADBDevicesOutputClassifiesMixedTargets(t *testing.T) {
	input := `List of devices attached
emulator-5554	device
R3CN90ABCDE	device
emulator-5556	offline
FA8X31A01234	unauthorized

`

	got := parseADBDevicesOutput(input, func(serial string) string {
		if serial == "emulator-5554" {
			return "Pixel_7_API_34"
		}
		return serial
	})

	if len(got) != 2 {
		t.Fatalf("expected 2 devices, got %d", len(got))
	}

	if got[0].ID != "emulator-5554" || got[0].Type != "emulator" || got[0].Label != "Pixel_7_API_34" || got[0].AVD != "Pixel_7_API_34" || got[0].State != "running" {
		t.Fatalf("unexpected emulator entry: %+v", got[0])
	}
	if got[1].ID != "R3CN90ABCDE" || got[1].Type != "android" || got[1].Label != "R3CN90ABCDE" || got[1].AVD != "R3CN90ABCDE" || got[1].State != "running" {
		t.Fatalf("unexpected android entry: %+v", got[1])
	}
}

func TestParseSimctlDevicesOutputClassifiesBootedIOSSimulators(t *testing.T) {
	input := []byte(`{
  "devices": {
    "com.apple.CoreSimulator.SimRuntime.iOS-26-2": [
      {
        "udid": "F87D9B80-78AD-4398-B7D4-CA5E74D5474A",
        "name": "iPhone 17",
        "state": "Booted"
      },
      {
        "udid": "D8147CD8-A240-40C2-BC5F-6706D0C9BC31",
        "name": "iPhone 17 Pro Max",
        "state": "Shutdown"
      }
    ]
  }
}`)

	got, err := parseSimctlDevicesOutput(input)
	if err != nil {
		t.Fatalf("parseSimctlDevicesOutput: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("expected 1 booted simulator, got %d", len(got))
	}

	if got[0].ID != "F87D9B80-78AD-4398-B7D4-CA5E74D5474A" {
		t.Fatalf("unexpected simulator id: %+v", got[0])
	}
	if got[0].Type != "ios-simulator" || got[0].State != "booted" {
		t.Fatalf("unexpected simulator classification: %+v", got[0])
	}
	if got[0].Label != "iPhone 17 (iOS 26.2)" {
		t.Fatalf("unexpected simulator label: %+v", got[0])
	}
}
