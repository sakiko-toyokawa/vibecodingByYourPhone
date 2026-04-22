package device

import (
	"os"
	"strings"
	"sync"
)

var (
	streamDebugOnce sync.Once
	streamDebugOn   bool
)

func streamDebugEnabled() bool {
	streamDebugOnce.Do(func() {
		switch strings.ToLower(strings.TrimSpace(os.Getenv("YEP_BRIDGE_STREAM_DEBUG"))) {
		case "1", "true", "yes", "on":
			streamDebugOn = true
		default:
			streamDebugOn = false
		}
	})
	return streamDebugOn
}
