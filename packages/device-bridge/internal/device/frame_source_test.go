package device

import (
	"context"
	"sync"
	"testing"
	"time"
)

type mockDevice struct {
	mu          sync.Mutex
	getCalls    int
	lastMaxW    int
	nextFrame   *Frame
	screenWidth int32
	screenHgt   int32
}

func (m *mockDevice) GetFrame(ctx context.Context, maxWidth int) (*Frame, error) {
	_ = ctx
	m.mu.Lock()
	defer m.mu.Unlock()
	m.getCalls++
	m.lastMaxW = maxWidth
	if m.nextFrame == nil {
		return &Frame{Data: []byte{0, 0, 0}, Width: 1, Height: 1}, nil
	}
	f := *m.nextFrame
	return &f, nil
}

func (m *mockDevice) SendTouch(ctx context.Context, touches []TouchPoint) error {
	_ = ctx
	_ = touches
	return nil
}

func (m *mockDevice) SendKey(ctx context.Context, key string) error {
	_ = ctx
	_ = key
	return nil
}

func (m *mockDevice) ScreenSize() (width, height int32) {
	return m.screenWidth, m.screenHgt
}

func (m *mockDevice) Close() error { return nil }

func (m *mockDevice) callsAndLastWidth() (int, int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.getCalls, m.lastMaxW
}

func TestFrameSourcePublishesFromDeviceInterface(t *testing.T) {
	d := &mockDevice{
		nextFrame:   &Frame{Data: []byte{1, 2, 3, 4, 5, 6}, Width: 2, Height: 1},
		screenWidth: 2,
		screenHgt:   1,
	}
	fs := NewFrameSource(d, 360, 0)
	defer fs.Stop()

	id, frames := fs.Subscribe()
	defer fs.Unsubscribe(id)

	select {
	case frame := <-frames:
		if frame == nil {
			t.Fatal("received nil frame")
		}
		if frame.Width != 2 || frame.Height != 1 {
			t.Fatalf("unexpected frame dimensions: %dx%d", frame.Width, frame.Height)
		}
		if len(frame.Data) != 6 {
			t.Fatalf("unexpected frame data size: %d", len(frame.Data))
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("timed out waiting for frame")
	}

	calls, maxWidth := d.callsAndLastWidth()
	if calls == 0 {
		t.Fatal("expected FrameSource to call Device.GetFrame")
	}
	if maxWidth != 360 {
		t.Fatalf("expected maxWidth=360, got %d", maxWidth)
	}
}
