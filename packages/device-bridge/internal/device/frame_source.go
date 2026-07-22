package device

import (
	"context"
	"log"
	"sync"
	"sync/atomic"
	"time"
)

// FrameSource polls Device.GetFrame and distributes frames to subscribers.
// Polling pauses automatically when there are no subscribers.
type FrameSource struct {
	device        Device
	maxWidth      int
	frameInterval time.Duration
	lastFrame     atomic.Pointer[Frame]
	mu            sync.RWMutex
	subs          map[int]chan<- *Frame
	nextID        int
	cancel        context.CancelFunc
	wakeup        chan struct{}
}

// NewFrameSource starts a frame polling loop for a Device.
// maxWidth is forwarded to Device.GetFrame.
// fps limits poll rate; 0 means no explicit limit.
func NewFrameSource(device Device, maxWidth, fps int) *FrameSource {
	ctx, cancel := context.WithCancel(context.Background())

	var frameInterval time.Duration
	if fps > 0 {
		frameInterval = time.Second / time.Duration(fps)
	}

	fs := &FrameSource{
		device:        device,
		maxWidth:      maxWidth,
		frameInterval: frameInterval,
		subs:          make(map[int]chan<- *Frame),
		cancel:        cancel,
		wakeup:        make(chan struct{}, 1),
	}
	go fs.run(ctx)
	return fs
}

// Subscribe returns a channel for receiving frames.
func (fs *FrameSource) Subscribe() (id int, ch <-chan *Frame) {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	id = fs.nextID
	fs.nextID++
	c := make(chan *Frame, 2)
	fs.subs[id] = c

	if len(fs.subs) == 1 {
		select {
		case fs.wakeup <- struct{}{}:
		default:
		}
	}

	if last := fs.lastFrame.Load(); last != nil {
		c <- last
	}

	return id, c
}

// Unsubscribe removes a frame subscriber.
func (fs *FrameSource) Unsubscribe(id int) {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	if ch, ok := fs.subs[id]; ok {
		close(ch)
		delete(fs.subs, id)
	}
	if len(fs.subs) == 0 {
		log.Printf("[FrameSource] no subscribers, pausing polling")
	}
}

// LastFrame returns the most recently published frame.
func (fs *FrameSource) LastFrame() *Frame {
	return fs.lastFrame.Load()
}

// Stop shuts down the polling loop.
func (fs *FrameSource) Stop() {
	fs.cancel()
}

func (fs *FrameSource) subscriberCount() int {
	fs.mu.RLock()
	defer fs.mu.RUnlock()
	return len(fs.subs)
}

func (fs *FrameSource) run(ctx context.Context) {
	var seq uint32
	for {
		if fs.subscriberCount() == 0 {
			select {
			case <-fs.wakeup:
				log.Printf("[FrameSource] subscriber arrived, resuming polling")
			case <-ctx.Done():
				return
			}
		}

		pollStart := time.Now()
		frame, err := fs.device.GetFrame(ctx, fs.maxWidth)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Printf("[FrameSource] poll error: %v", err)
			continue
		}

		seq++
		frame.Seq = seq
		fs.lastFrame.Store(frame)
		fs.dispatch(frame)

		if fs.frameInterval > 0 {
			if sleep := fs.frameInterval - time.Since(pollStart); sleep > 0 {
				select {
				case <-time.After(sleep):
				case <-ctx.Done():
					return
				}
			}
		}
	}
}

func (fs *FrameSource) dispatch(frame *Frame) {
	fs.mu.RLock()
	defer fs.mu.RUnlock()

	for _, ch := range fs.subs {
		select {
		case ch <- frame:
		default:
		}
	}
}
