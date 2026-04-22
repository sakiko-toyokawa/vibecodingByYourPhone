package ipc

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true }, // localhost only
}

// Handler manages the WebSocket IPC connection from the Yep server.
type Handler struct {
	discovery *Discovery
	sessions  *SessionManager
	mu        sync.Mutex
	conn      *websocket.Conn
	writeMu   sync.Mutex // protects WebSocket writes (gorilla is not concurrent-write-safe)
}

// NewHandler creates an IPC handler.
// onIdle is called when no streaming sessions remain for 10 seconds (nil to disable).
func NewHandler(adbPath string, stunServers []string, onIdle func()) *Handler {
	h := &Handler{
		discovery: NewDiscovery(adbPath),
	}
	h.sessions = NewSessionManager(adbPath, stunServers, h.sendRaw, onIdle)
	return h
}

// ServeWS handles the WebSocket upgrade and message loop.
func (h *Handler) ServeWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ws upgrade error: %v", err)
		return
	}

	h.mu.Lock()
	// Close previous connection if any.
	if h.conn != nil {
		h.conn.Close()
	}
	h.conn = conn
	h.mu.Unlock()

	log.Println("IPC WebSocket connected")
	defer func() {
		if r := recover(); r != nil {
			log.Printf("ws: panic recovered in ServeWS: %v", r)
		}
		log.Println("IPC WebSocket disconnected")
		h.mu.Lock()
		if h.conn == conn {
			h.conn = nil
		}
		h.mu.Unlock()
		conn.Close()
		h.sessions.CloseAll()
	}()

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				log.Printf("ws read error: %v", err)
			}
			return
		}
		h.handleMessage(data)
	}
}

// GetDiscovery returns the discovery instance for REST endpoints.
func (h *Handler) GetDiscovery() *Discovery {
	return h.discovery
}

// ipcMessage is the minimal structure for routing.
type ipcMessage struct {
	Type       string               `json:"type"`
	SessionID  string               `json:"sessionId,omitempty"`
	DeviceID   string               `json:"deviceId,omitempty"`
	DeviceType string               `json:"deviceType,omitempty"`
	SDP        string               `json:"sdp,omitempty"`
	Candidate  json.RawMessage      `json:"candidate,omitempty"`
	Options    *SessionStartOptions `json:"options,omitempty"`
}

func (h *Handler) handleMessage(data []byte) {
	var msg ipcMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		log.Printf("ipc: bad message: %v", err)
		return
	}

	switch msg.Type {
	case "session.start":
		opts := SessionStartOptions{MaxFPS: 30, MaxWidth: 540}
		if msg.Options != nil {
			opts = *msg.Options
		}
		if err := h.sessions.StartSession(msg.SessionID, msg.DeviceID, msg.DeviceType, opts); err != nil {
			log.Printf("ipc: session.start error: %v", err)
		}

	case "session.stop":
		h.sessions.StopSession(msg.SessionID)

	case "webrtc.answer":
		if err := h.sessions.HandleAnswer(msg.SessionID, msg.SDP); err != nil {
			log.Printf("ipc: webrtc.answer error: %v", err)
		}

	case "webrtc.ice":
		if err := h.sessions.HandleICE(msg.SessionID, msg.Candidate); err != nil {
			log.Printf("ipc: webrtc.ice error: %v", err)
		}

	default:
		log.Printf("ipc: unknown message type: %s", msg.Type)
	}
}

// sendRaw sends a raw JSON message to the Yep server WebSocket.
// Safe for concurrent use from multiple goroutines.
func (h *Handler) sendRaw(msg []byte) {
	h.mu.Lock()
	conn := h.conn
	h.mu.Unlock()

	if conn == nil {
		return
	}

	h.writeMu.Lock()
	defer h.writeMu.Unlock()

	if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
		log.Printf("ipc: ws write error: %v", err)
	}
}
