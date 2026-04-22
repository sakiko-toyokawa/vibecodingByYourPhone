package encoder

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
)

// RGBToJPEG encodes raw RGB888 pixels as a JPEG image.
func RGBToJPEG(rgb []byte, width, height int) []byte {
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			i := (y*width + x) * 3
			img.SetRGBA(x, y, color.RGBA{
				R: rgb[i],
				G: rgb[i+1],
				B: rgb[i+2],
				A: 255,
			})
		}
	}

	var buf bytes.Buffer
	jpeg.Encode(&buf, img, &jpeg.Options{Quality: 75})
	return buf.Bytes()
}
