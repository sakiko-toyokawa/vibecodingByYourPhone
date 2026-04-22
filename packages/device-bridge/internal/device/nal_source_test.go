package device

import (
	"testing"
	"time"
)

func readUnit(t *testing.T, ch <-chan *NalUnit) *NalUnit {
	t.Helper()
	select {
	case unit, ok := <-ch:
		if !ok {
			t.Fatal("channel closed unexpectedly")
		}
		if unit == nil {
			t.Fatal("received nil NAL unit")
		}
		return unit
	case <-time.After(250 * time.Millisecond):
		t.Fatal("timed out waiting for NAL unit")
		return nil
	}
}

func TestNalSourceSubscribeReplaysBootstrapPackets(t *testing.T) {
	ns := NewNalSource()
	config := &NalUnit{Data: []byte{1, 2, 3}, Config: true, PTSUs: 100}
	key := &NalUnit{Data: []byte{4, 5, 6}, Keyframe: true, PTSUs: 100}
	inter := &NalUnit{Data: []byte{7, 8, 9}, PTSUs: 133}

	ns.Publish(config)
	ns.Publish(key)
	ns.Publish(inter)

	// Prove bootstrap cache is immutable from source packet mutation.
	config.Data[0] = 9
	key.Data[0] = 8

	id, ch := ns.Subscribe()
	defer ns.Unsubscribe(id)

	gotConfig := readUnit(t, ch)
	if !gotConfig.Config {
		t.Fatalf("expected bootstrap config packet, got config=%v key=%v", gotConfig.Config, gotConfig.Keyframe)
	}
	if gotConfig.Data[0] != 1 {
		t.Fatalf("expected cloned config payload, got first byte=%d", gotConfig.Data[0])
	}

	gotKey := readUnit(t, ch)
	if !gotKey.Keyframe {
		t.Fatalf("expected bootstrap keyframe packet, got config=%v key=%v", gotKey.Config, gotKey.Keyframe)
	}
	if gotKey.Data[0] != 4 {
		t.Fatalf("expected cloned keyframe payload, got first byte=%d", gotKey.Data[0])
	}

	live := &NalUnit{Data: []byte{10, 11, 12}, PTSUs: 166}
	ns.Publish(live)
	gotLive := readUnit(t, ch)
	if gotLive.Config || gotLive.Keyframe {
		t.Fatalf("expected live inter-frame packet, got config=%v key=%v", gotLive.Config, gotLive.Keyframe)
	}
}

func TestNalSourceSubscribeReplaysLatestKeyframe(t *testing.T) {
	ns := NewNalSource()
	ns.Publish(&NalUnit{Data: []byte{1}, Config: true, PTSUs: 100})
	ns.Publish(&NalUnit{Data: []byte{2}, Keyframe: true, PTSUs: 100})
	ns.Publish(&NalUnit{Data: []byte{3}, Keyframe: true, PTSUs: 200})

	id, ch := ns.Subscribe()
	defer ns.Unsubscribe(id)

	_ = readUnit(t, ch) // bootstrap config
	gotKey := readUnit(t, ch)
	if !gotKey.Keyframe {
		t.Fatalf("expected keyframe replay, got config=%v key=%v", gotKey.Config, gotKey.Keyframe)
	}
	if len(gotKey.Data) != 1 || gotKey.Data[0] != 3 {
		t.Fatalf("expected latest keyframe payload 3, got %v", gotKey.Data)
	}
}
