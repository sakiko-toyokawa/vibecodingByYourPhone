package device

import (
	"bytes"
	"encoding/binary"
	"testing"
)

func TestNormalizeH264PayloadForWebRTC_ConfigRecordToAnnexB(t *testing.T) {
	sps := []byte{0x67, 0x42, 0xC0, 0x1F, 0xDA}
	pps := []byte{0x68, 0xCE, 0x3C, 0x80}

	payload := []byte{
		0x01, 0x42, 0xC0, 0x1F, 0xFF, 0xE1,
		0x00, byte(len(sps)),
	}
	payload = append(payload, sps...)
	payload = append(payload, byte(1))
	payload = append(payload, 0x00, byte(len(pps)))
	payload = append(payload, pps...)

	out, meta := normalizeH264PayloadForWebRTC(payload, true, 4)
	if !meta.Converted {
		t.Fatalf("expected conversion, meta=%+v", meta)
	}
	if meta.Kind != "avcc-config" {
		t.Fatalf("unexpected kind: %s", meta.Kind)
	}
	if meta.LengthSize != 4 {
		t.Fatalf("unexpected length size: %d", meta.LengthSize)
	}

	want := append([]byte{}, h264StartCode4...)
	want = append(want, sps...)
	want = append(want, h264StartCode4...)
	want = append(want, pps...)
	if !bytes.Equal(out, want) {
		t.Fatalf("annexb output mismatch:\nwant=%x\ngot=%x", want, out)
	}
}

func TestNormalizeH264PayloadForWebRTC_LengthPrefixedToAnnexB(t *testing.T) {
	idr := []byte{0x65, 0x88, 0x84, 0x21}
	p := []byte{0x41, 0x9A, 0x22}
	payload := make([]byte, 0, 16)
	payload = appendLengthPrefixedNAL(payload, 4, idr)
	payload = appendLengthPrefixedNAL(payload, 4, p)

	out, meta := normalizeH264PayloadForWebRTC(payload, false, 4)
	if !meta.Converted {
		t.Fatalf("expected conversion, meta=%+v", meta)
	}
	if meta.Kind != "avcc-len4" {
		t.Fatalf("unexpected kind: %s", meta.Kind)
	}
	if meta.NALCount != 2 {
		t.Fatalf("unexpected NAL count: %d", meta.NALCount)
	}
	if meta.FirstNALType != 5 {
		t.Fatalf("unexpected first NAL type: %d", meta.FirstNALType)
	}

	want := append([]byte{}, h264StartCode4...)
	want = append(want, idr...)
	want = append(want, h264StartCode4...)
	want = append(want, p...)
	if !bytes.Equal(out, want) {
		t.Fatalf("annexb output mismatch:\nwant=%x\ngot=%x", want, out)
	}
}

func TestNormalizeH264PayloadForWebRTC_UsesLengthHint2(t *testing.T) {
	idr := []byte{0x65, 0xAA, 0xBB}
	p := []byte{0x41, 0xCC}
	payload := make([]byte, 0, 12)
	payload = appendLengthPrefixedNAL(payload, 2, idr)
	payload = appendLengthPrefixedNAL(payload, 2, p)

	out, meta := normalizeH264PayloadForWebRTC(payload, false, 2)
	if !meta.Converted {
		t.Fatalf("expected conversion, meta=%+v", meta)
	}
	if meta.Kind != "avcc-len2" {
		t.Fatalf("unexpected kind: %s", meta.Kind)
	}
	if meta.LengthSize != 2 {
		t.Fatalf("unexpected length size: %d", meta.LengthSize)
	}
	if !containsAnnexBStartCode(out) {
		t.Fatalf("expected annexb output, got=%x", out)
	}
}

func TestNormalizeH264PayloadForWebRTC_AnnexBPassThrough(t *testing.T) {
	payload := []byte{0x00, 0x00, 0x00, 0x01, 0x67, 0x64, 0x00, 0x1F}
	out, meta := normalizeH264PayloadForWebRTC(payload, true, 4)
	if meta.Converted {
		t.Fatalf("did not expect conversion, meta=%+v", meta)
	}
	if meta.Kind != "annexb" {
		t.Fatalf("unexpected kind: %s", meta.Kind)
	}
	if !bytes.Equal(out, payload) {
		t.Fatalf("expected passthrough")
	}
}

func appendLengthPrefixedNAL(dst []byte, lengthSize int, nalu []byte) []byte {
	if lengthSize <= 0 || lengthSize > 4 {
		panic("invalid lengthSize")
	}
	lenBuf := make([]byte, 4)
	binary.BigEndian.PutUint32(lenBuf, uint32(len(nalu)))
	dst = append(dst, lenBuf[4-lengthSize:]...)
	dst = append(dst, nalu...)
	return dst
}
