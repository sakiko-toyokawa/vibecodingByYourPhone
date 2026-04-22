package device

import (
	"log"
	"sync"
	"sync/atomic"
)

// NalUnit is one encoded H.264 access unit from device hardware encoder.
type NalUnit struct {
	Data     []byte
	Keyframe bool
	Config   bool
	PTSUs    int64
}

// NalSource fans out push-based NAL units to subscribers.
type NalSource struct {
	mu               sync.RWMutex
	subs             map[int]chan *NalUnit
	nextID           int
	closed           bool
	noSubscriberPubs atomic.Uint64
	bootstrapConfig  *NalUnit
	bootstrapKey     *NalUnit
}

func NewNalSource() *NalSource {
	return &NalSource{
		subs: make(map[int]chan *NalUnit),
	}
}

func (ns *NalSource) Subscribe() (id int, ch <-chan *NalUnit) {
	ns.mu.Lock()
	defer ns.mu.Unlock()

	id = ns.nextID
	ns.nextID++
	c := make(chan *NalUnit, 128)
	if ns.closed {
		close(c)
		return id, c
	}
	ns.subs[id] = c
	ns.enqueueBootstrapLocked(c)
	return id, c
}

func (ns *NalSource) Unsubscribe(id int) {
	ns.mu.Lock()
	defer ns.mu.Unlock()
	if ch, ok := ns.subs[id]; ok {
		close(ch)
		delete(ns.subs, id)
	}
}

func (ns *NalSource) Publish(unit *NalUnit) {
	ns.mu.Lock()
	defer ns.mu.Unlock()
	if ns.closed {
		return
	}
	if unit != nil {
		if unit.Config {
			ns.bootstrapConfig = cloneNalUnit(unit)
		}
		if unit.Keyframe {
			ns.bootstrapKey = cloneNalUnit(unit)
		}
	}
	if len(ns.subs) == 0 {
		count := ns.noSubscriberPubs.Add(1)
		if streamDebugEnabled() && (count <= 5 || count%120 == 0) {
			log.Printf(
				"[NalSource] dropped live publish with no subscribers (count=%d config=%v key=%v ptsUs=%d bytes=%d)",
				count,
				unit != nil && unit.Config,
				unit != nil && unit.Keyframe,
				func() int64 {
					if unit == nil {
						return 0
					}
					return unit.PTSUs
				}(),
				func() int {
					if unit == nil {
						return 0
					}
					return len(unit.Data)
				}(),
			)
		}
		return
	}
	for _, ch := range ns.subs {
		select {
		case ch <- unit:
		default:
			// Drop one stale packet to avoid deadlock on slow consumers.
			select {
			case <-ch:
			default:
			}
			select {
			case ch <- unit:
			default:
			}
		}
	}
}

func (ns *NalSource) enqueueBootstrapLocked(ch chan *NalUnit) {
	if ns.bootstrapConfig != nil {
		select {
		case ch <- cloneNalUnit(ns.bootstrapConfig):
		default:
			if streamDebugEnabled() {
				log.Printf("[NalSource] bootstrap enqueue dropped config packet")
			}
		}
	}
	if ns.bootstrapKey != nil {
		select {
		case ch <- cloneNalUnit(ns.bootstrapKey):
		default:
			if streamDebugEnabled() {
				log.Printf("[NalSource] bootstrap enqueue dropped keyframe packet")
			}
		}
	}
}

func cloneNalUnit(unit *NalUnit) *NalUnit {
	if unit == nil {
		return nil
	}
	data := make([]byte, len(unit.Data))
	copy(data, unit.Data)
	return &NalUnit{
		Data:     data,
		Keyframe: unit.Keyframe,
		Config:   unit.Config,
		PTSUs:    unit.PTSUs,
	}
}

func (ns *NalSource) Stop() {
	ns.mu.Lock()
	defer ns.mu.Unlock()
	if ns.closed {
		return
	}
	ns.closed = true
	for id, ch := range ns.subs {
		close(ch)
		delete(ns.subs, id)
	}
}
