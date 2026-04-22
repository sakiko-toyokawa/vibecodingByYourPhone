package stream

import (
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

// ICECandidateJSON is the JSON-serializable form of an ICE candidate.
type ICECandidateJSON struct {
	Candidate        string  `json:"candidate"`
	SDPMid           *string `json:"sdpMid,omitempty"`
	SDPMLineIndex    *uint16 `json:"sdpMLineIndex,omitempty"`
	UsernameFragment *string `json:"usernameFragment,omitempty"`
}

// PeerSession represents one WebRTC connection to a browser.
type PeerSession struct {
	pc          *webrtc.PeerConnection
	videoTrack  *webrtc.TrackLocalStaticSample
	dataChannel *webrtc.DataChannel
	onInput     func(msg []byte)
	closed      chan struct{}
	connected   chan struct{} // closed when ICE reaches "connected" state
	pli         chan struct{}
	label       string // session ID prefix for log messages
	mu          sync.Mutex
	discTimer   *time.Timer
}

const iceDisconnectGrace = 12 * time.Second

// NewPeerSession creates a PeerConnection with an h264 video track and a "control" DataChannel.
// label is used as a prefix in log messages (typically the session ID).
// onICE is called for each trickle ICE candidate (nil candidate means gathering complete).
func NewPeerSession(label string, stunServers []string, onInput func(msg []byte), onICE func(*ICECandidateJSON)) (*PeerSession, error) {
	iceServers := []webrtc.ICEServer{}
	if len(stunServers) > 0 {
		iceServers = append(iceServers, webrtc.ICEServer{URLs: stunServers})
	}

	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{
		ICEServers: iceServers,
	})
	if err != nil {
		return nil, fmt.Errorf("creating peer connection: %w", err)
	}

	videoTrack, err := webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264},
		"video", "emulator",
	)
	if err != nil {
		pc.Close()
		return nil, fmt.Errorf("creating video track: %w", err)
	}

	rtpSender, err := pc.AddTrack(videoTrack)
	if err != nil {
		pc.Close()
		return nil, fmt.Errorf("adding video track: %w", err)
	}

	dc, err := pc.CreateDataChannel("control", nil)
	if err != nil {
		pc.Close()
		return nil, fmt.Errorf("creating data channel: %w", err)
	}

	ps := &PeerSession{
		pc:          pc,
		videoTrack:  videoTrack,
		dataChannel: dc,
		onInput:     onInput,
		closed:      make(chan struct{}),
		connected:   make(chan struct{}),
		pli:         make(chan struct{}, 8),
		label:       label,
	}

	// Drain incoming RTCP packets. Pion requires this: RTCP packets are
	// processed by interceptors (NACK, PLI, etc.) before being returned.
	// Without reading, the RTCP buffer fills up and back-pressures the
	// RTP write path, causing WriteSample to silently stall after a few seconds.
	go func() {
		buf := make([]byte, 1500)
		for {
			n, _, rtcpErr := rtpSender.Read(buf)
			if rtcpErr != nil {
				return
			}
			packets, unmarshalErr := rtcp.Unmarshal(buf[:n])
			if unmarshalErr != nil {
				continue
			}
			for _, packet := range packets {
				switch packet.(type) {
				case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
					select {
					case ps.pli <- struct{}{}:
					default:
					}
				}
			}
		}
	}()

	dc.OnOpen(func() {
		log.Printf("[peer %s] DataChannel '%s' opened", label, dc.Label())
	})

	dc.OnClose(func() {
		log.Printf("[peer %s] DataChannel '%s' closed", label, dc.Label())
	})

	dc.OnError(func(err error) {
		log.Printf("[peer %s] DataChannel '%s' error: %v", label, dc.Label(), err)
	})

	dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		if ps.onInput != nil {
			ps.onInput(msg.Data)
		}
	})

	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		log.Printf("[peer %s] connectionState: %s", label, state.String())
	})

	pc.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
		log.Printf("[peer %s] iceConnectionState: %s", label, state.String())
		switch state {
		case webrtc.ICEConnectionStateConnected, webrtc.ICEConnectionStateCompleted:
			ps.cancelDisconnectTimer()
			select {
			case <-ps.connected:
			default:
				close(ps.connected)
			}
		case webrtc.ICEConnectionStateDisconnected:
			ps.armDisconnectTimer()
		case webrtc.ICEConnectionStateFailed, webrtc.ICEConnectionStateClosed:
			ps.cancelDisconnectTimer()
			ps.closeDone()
		}
	})

	// Trickle ICE: emit candidates as they are discovered.
	if onICE != nil {
		pc.OnICECandidate(func(c *webrtc.ICECandidate) {
			if c == nil {
				// Gathering complete.
				onICE(nil)
				return
			}
			init := c.ToJSON()
			onICE(&ICECandidateJSON{
				Candidate:        init.Candidate,
				SDPMid:           init.SDPMid,
				SDPMLineIndex:    init.SDPMLineIndex,
				UsernameFragment: init.UsernameFragment,
			})
		})
	}

	return ps, nil
}

// CreateOffer creates an SDP offer and returns it immediately (without waiting for ICE gathering).
// ICE candidates are delivered via the onICE callback passed to NewPeerSession.
func (ps *PeerSession) CreateOffer() (string, error) {
	offer, err := ps.pc.CreateOffer(nil)
	if err != nil {
		return "", fmt.Errorf("creating offer: %w", err)
	}

	if err := ps.pc.SetLocalDescription(offer); err != nil {
		return "", fmt.Errorf("setting local description: %w", err)
	}

	return offer.SDP, nil
}

// CreateOfferGathered creates an SDP offer and blocks until ICE gathering is complete.
// Returns the SDP with all candidates embedded. Used for standalone (non-IPC) mode.
func (ps *PeerSession) CreateOfferGathered() (string, error) {
	offer, err := ps.pc.CreateOffer(nil)
	if err != nil {
		return "", fmt.Errorf("creating offer: %w", err)
	}

	gatherComplete := webrtc.GatheringCompletePromise(ps.pc)

	if err := ps.pc.SetLocalDescription(offer); err != nil {
		return "", fmt.Errorf("setting local description: %w", err)
	}

	select {
	case <-gatherComplete:
	case <-time.After(10 * time.Second):
		return "", fmt.Errorf("ICE gathering timed out")
	}

	return ps.pc.LocalDescription().SDP, nil
}

// SetAnswer sets the remote SDP answer from the browser.
func (ps *PeerSession) SetAnswer(sdp string) error {
	return ps.pc.SetRemoteDescription(webrtc.SessionDescription{
		Type: webrtc.SDPTypeAnswer,
		SDP:  sdp,
	})
}

// AddICECandidate adds a remote ICE candidate (trickle ICE).
func (ps *PeerSession) AddICECandidate(candidateJSON []byte) error {
	var candidate ICECandidateJSON
	if err := json.Unmarshal(candidateJSON, &candidate); err != nil {
		return fmt.Errorf("parsing ICE candidate: %w", err)
	}
	return ps.pc.AddICECandidate(webrtc.ICECandidateInit{
		Candidate:        candidate.Candidate,
		SDPMid:           candidate.SDPMid,
		SDPMLineIndex:    candidate.SDPMLineIndex,
		UsernameFragment: candidate.UsernameFragment,
	})
}

// WriteVideoSample sends h264 NAL data to the video track.
func (ps *PeerSession) WriteVideoSample(data []byte, duration time.Duration) error {
	return ps.videoTrack.WriteSample(media.Sample{
		Data:     data,
		Duration: duration,
	})
}

// ConnectionState returns the current PeerConnection state.
func (ps *PeerSession) ConnectionState() string {
	return ps.pc.ConnectionState().String()
}

// ICEConnectionState returns the current ICE connection state.
func (ps *PeerSession) ICEConnectionState() string {
	return ps.pc.ICEConnectionState().String()
}

// Close tears down the PeerConnection.
func (ps *PeerSession) Close() error {
	log.Printf("[peer %s] Close() called (iceState=%s, connState=%s)",
		ps.label, ps.pc.ICEConnectionState().String(), ps.pc.ConnectionState().String())
	ps.cancelDisconnectTimer()
	ps.closeDone()
	return ps.pc.Close()
}

// Connected returns a channel that is closed when the ICE connection is established.
func (ps *PeerSession) Connected() <-chan struct{} {
	return ps.connected
}

// Done returns a channel that is closed when the peer disconnects.
func (ps *PeerSession) Done() <-chan struct{} {
	return ps.closed
}

// PLI returns a channel that receives events when remote RTCP requests a keyframe.
func (ps *PeerSession) PLI() <-chan struct{} {
	return ps.pli
}

func (ps *PeerSession) closeDone() {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	select {
	case <-ps.closed:
	default:
		close(ps.closed)
	}
}

func (ps *PeerSession) cancelDisconnectTimer() {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	if ps.discTimer != nil {
		ps.discTimer.Stop()
		ps.discTimer = nil
	}
}

func (ps *PeerSession) armDisconnectTimer() {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	if ps.discTimer != nil {
		return
	}
	ps.discTimer = time.AfterFunc(iceDisconnectGrace, func() {
		ps.mu.Lock()
		ps.discTimer = nil
		iceState := ps.pc.ICEConnectionState()
		if iceState != webrtc.ICEConnectionStateDisconnected {
			ps.mu.Unlock()
			return
		}
		select {
		case <-ps.closed:
		default:
			log.Printf("[peer %s] ICE disconnected for %v, closing session", ps.label, iceDisconnectGrace)
			close(ps.closed)
		}
		ps.mu.Unlock()
	})
}
