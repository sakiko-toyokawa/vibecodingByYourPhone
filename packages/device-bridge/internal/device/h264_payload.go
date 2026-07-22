package device

import (
	"bytes"
	"encoding/binary"
	"fmt"
)

var (
	h264StartCode3 = []byte{0x00, 0x00, 0x01}
	h264StartCode4 = []byte{0x00, 0x00, 0x00, 0x01}
)

type h264PayloadMeta struct {
	Kind         string
	Converted    bool
	LengthSize   int
	NALCount     int
	FirstNALType uint8
}

func normalizeH264PayloadForWebRTC(payload []byte, isConfig bool, lengthSizeHint int) ([]byte, h264PayloadMeta) {
	meta := h264PayloadMeta{
		Kind:       "raw",
		LengthSize: lengthSizeHint,
	}
	if len(payload) == 0 {
		return payload, meta
	}

	if containsAnnexBStartCode(payload) {
		meta.Kind = "annexb"
		meta.NALCount, meta.FirstNALType = annexBNALStats(payload)
		return payload, meta
	}

	if isConfig {
		if nalus, lengthSize, ok := parseAVCDecoderConfig(payload); ok {
			out := joinAnnexBNALUs(nalus)
			meta.Kind = "avcc-config"
			meta.Converted = true
			meta.LengthSize = lengthSize
			meta.NALCount = len(nalus)
			meta.FirstNALType = h264NALType(nalus[0])
			return out, meta
		}
	}

	for _, candidate := range lengthSizeCandidates(lengthSizeHint) {
		nalus, ok := parseLengthPrefixedNALUs(payload, candidate)
		if !ok {
			continue
		}
		out := joinAnnexBNALUs(nalus)
		meta.Kind = fmt.Sprintf("avcc-len%d", candidate)
		meta.Converted = true
		meta.LengthSize = candidate
		meta.NALCount = len(nalus)
		meta.FirstNALType = h264NALType(nalus[0])
		return out, meta
	}

	meta.NALCount = 1
	meta.FirstNALType = h264NALType(payload)
	return payload, meta
}

func parseAVCDecoderConfig(payload []byte) (nalus [][]byte, lengthSize int, ok bool) {
	// AVCDecoderConfigurationRecord (ISO/IEC 14496-15)
	if len(payload) < 7 || payload[0] != 1 {
		return nil, 0, false
	}
	lengthSize = int(payload[4]&0x03) + 1
	if lengthSize < 1 || lengthSize > 4 {
		return nil, 0, false
	}

	pos := 5
	spsCount := int(payload[pos] & 0x1F)
	pos++
	if spsCount <= 0 {
		return nil, 0, false
	}

	out := make([][]byte, 0, spsCount+4)
	for i := 0; i < spsCount; i++ {
		if pos+2 > len(payload) {
			return nil, 0, false
		}
		spsLen := int(binary.BigEndian.Uint16(payload[pos : pos+2]))
		pos += 2
		if spsLen <= 0 || pos+spsLen > len(payload) {
			return nil, 0, false
		}
		sps := payload[pos : pos+spsLen]
		if h264NALType(sps) != 7 {
			return nil, 0, false
		}
		out = append(out, sps)
		pos += spsLen
	}

	if pos >= len(payload) {
		return nil, 0, false
	}
	ppsCount := int(payload[pos])
	pos++
	if ppsCount <= 0 {
		return nil, 0, false
	}
	for i := 0; i < ppsCount; i++ {
		if pos+2 > len(payload) {
			return nil, 0, false
		}
		ppsLen := int(binary.BigEndian.Uint16(payload[pos : pos+2]))
		pos += 2
		if ppsLen <= 0 || pos+ppsLen > len(payload) {
			return nil, 0, false
		}
		pps := payload[pos : pos+ppsLen]
		if h264NALType(pps) != 8 {
			return nil, 0, false
		}
		out = append(out, pps)
		pos += ppsLen
	}

	if len(out) == 0 {
		return nil, 0, false
	}
	return out, lengthSize, true
}

func parseLengthPrefixedNALUs(payload []byte, lengthSize int) ([][]byte, bool) {
	if lengthSize < 1 || lengthSize > 4 || len(payload) <= lengthSize {
		return nil, false
	}
	pos := 0
	out := make([][]byte, 0, 4)
	for pos+lengthSize <= len(payload) {
		size := 0
		for i := 0; i < lengthSize; i++ {
			size = (size << 8) | int(payload[pos+i])
		}
		pos += lengthSize
		if size <= 0 || pos+size > len(payload) {
			return nil, false
		}
		nalu := payload[pos : pos+size]
		if !isPlausibleH264NALU(nalu) {
			return nil, false
		}
		out = append(out, nalu)
		pos += size
	}
	if pos != len(payload) || len(out) == 0 {
		return nil, false
	}
	return out, true
}

func containsAnnexBStartCode(payload []byte) bool {
	return bytes.Contains(payload, h264StartCode4) || bytes.Contains(payload, h264StartCode3)
}

func lengthSizeCandidates(hint int) []int {
	out := make([]int, 0, 3)
	if hint >= 1 && hint <= 4 {
		out = append(out, hint)
	}
	for _, n := range []int{4, 2, 1} {
		seen := false
		for _, existing := range out {
			if existing == n {
				seen = true
				break
			}
		}
		if seen {
			continue
		}
		// Length-size=1 has a high false-positive rate; only try when hinted.
		if n == 1 {
			continue
		}
		out = append(out, n)
	}
	return out
}

func joinAnnexBNALUs(nalus [][]byte) []byte {
	total := 0
	for _, nalu := range nalus {
		total += len(h264StartCode4) + len(nalu)
	}
	out := make([]byte, 0, total)
	for _, nalu := range nalus {
		out = append(out, h264StartCode4...)
		out = append(out, nalu...)
	}
	return out
}

func annexBNALStats(payload []byte) (count int, firstType uint8) {
	// Keep this simple for debug logging; not for decode.
	start := bytes.Index(payload, h264StartCode3)
	offset := 3
	if start == -1 {
		return 1, h264NALType(payload)
	}
	for start < len(payload) {
		end := bytes.Index(payload[start+offset:], h264StartCode3)
		if end == -1 {
			nalu := payload[start+offset:]
			if len(nalu) > 0 {
				count++
				if firstType == 0 {
					firstType = h264NALType(nalu)
				}
			}
			break
		}
		nextStart := start + offset + end
		if nextStart > 0 && payload[nextStart-1] == 0 {
			nextStart--
		}
		nalu := payload[start+offset : nextStart]
		if len(nalu) > 0 {
			count++
			if firstType == 0 {
				firstType = h264NALType(nalu)
			}
		}
		start = nextStart
		if nextStart > 0 && payload[nextStart-1] == 0 {
			offset = 4
		} else {
			offset = 3
		}
	}
	return count, firstType
}

func isPlausibleH264NALU(nalu []byte) bool {
	t := h264NALType(nalu)
	return t >= 1 && t <= 23
}

func h264NALType(nalu []byte) uint8 {
	if len(nalu) == 0 {
		return 0
	}
	return nalu[0] & 0x1F
}

func h264HexPrefix(payload []byte, max int) string {
	if max <= 0 || len(payload) == 0 {
		return ""
	}
	if len(payload) > max {
		payload = payload[:max]
	}
	return fmt.Sprintf("%x", payload)
}
