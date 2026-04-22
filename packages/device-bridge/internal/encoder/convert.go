package encoder

import "sync"

// i420Buf holds reusable I420 plane buffers to avoid per-frame allocation.
type i420Buf struct {
	data []byte
}

var i420Pool = sync.Pool{
	New: func() interface{} { return &i420Buf{} },
}

// ScaleAndConvertToI420 scales an RGB888 source image and converts to I420 in a single pass.
// This avoids the intermediate scaled-RGB buffer and halves memory traffic compared to
// separate Scale + RGBToI420 calls.
// The returned slices share a pooled buffer — call ReleaseI420 when done.
func ScaleAndConvertToI420(src []byte, srcW, srcH, dstW, dstH int) (y, cb, cr []byte) {
	ySize := dstW * dstH
	cSize := (dstW / 2) * (dstH / 2)
	total := ySize + cSize + cSize

	buf := i420Pool.Get().(*i420Buf)
	if cap(buf.data) < total {
		buf.data = make([]byte, total)
	} else {
		buf.data = buf.data[:total]
	}

	yPlane := buf.data[:ySize]
	cbPlane := buf.data[ySize : ySize+cSize]
	crPlane := buf.data[ySize+cSize : total]

	cStride := dstW / 2

	for oy := 0; oy < dstH; oy++ {
		sy := oy * srcH / dstH
		srcRowOffset := sy * srcW * 3
		yRowOffset := oy * dstW

		for ox := 0; ox < dstW; ox++ {
			sx := ox * srcW / dstW
			si := srcRowOffset + sx*3

			r := int(src[si])
			g := int(src[si+1])
			b := int(src[si+2])

			// BT.601 luma
			yPlane[yRowOffset+ox] = uint8((77*r + 150*g + 29*b + 128) >> 8)

			// Subsample chroma: one sample per 2×2 block
			if oy%2 == 0 && ox%2 == 0 {
				ci := (oy/2)*cStride + ox/2
				uVal := ((-43*r - 85*g + 128*b + 128) >> 8) + 128
				vVal := ((128*r - 107*g - 21*b + 128) >> 8) + 128
				if uVal < 0 {
					uVal = 0
				} else if uVal > 255 {
					uVal = 255
				}
				if vVal < 0 {
					vVal = 0
				} else if vVal > 255 {
					vVal = 255
				}
				cbPlane[ci] = uint8(uVal)
				crPlane[ci] = uint8(vVal)
			}
		}
	}

	return yPlane, cbPlane, crPlane
}

// ReleaseI420 returns the backing buffer to the pool.
// Call this after the encoder has consumed the Y/Cb/Cr slices.
func ReleaseI420(y []byte) {
	if y == nil {
		return
	}
	// y is the first slice of the pooled buffer; recover the full allocation.
	buf := &i420Buf{data: y[:cap(y)]}
	i420Pool.Put(buf)
}
