package encoder

// ComputeTargetSize calculates the target resolution maintaining aspect ratio.
// Both dimensions are forced to even numbers (required by x264).
func ComputeTargetSize(srcW, srcH, maxWidth int) (targetW, targetH int) {
	if srcW <= maxWidth {
		targetW = srcW
		targetH = srcH
	} else {
		targetW = maxWidth
		targetH = srcH * maxWidth / srcW
	}
	// Force even dimensions for x264.
	targetW &^= 1
	targetH &^= 1
	return
}

// Scale downscales an RGB888 image to the target size using nearest-neighbor sampling.
// The emulator pixels are already top-down despite the proto saying "bottom up"
// (confirmed empirically in Phase 0 validation).
func Scale(src []byte, srcW, srcH, targetW, targetH int) []byte {
	dst := make([]byte, targetW*targetH*3)

	for oy := 0; oy < targetH; oy++ {
		sy := oy * srcH / targetH
		srcRowOffset := sy * srcW * 3
		dstRowOffset := oy * targetW * 3

		for ox := 0; ox < targetW; ox++ {
			sx := ox * srcW / targetW
			si := srcRowOffset + sx*3
			di := dstRowOffset + ox*3

			dst[di] = src[si]
			dst[di+1] = src[si+1]
			dst[di+2] = src[si+2]
		}
	}

	return dst
}
