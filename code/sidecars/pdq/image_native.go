// Native image path for the bulk directory scan (scan.go, perceptual_fingerprint.mdx §FD.8).
//
// The per-file path decodes images in Node with sharp (libvips) and sends a 128×128 RGB frame here. A bulk
// scan cannot afford that round trip per file, so it decodes IN THIS PROCESS instead and hands PDQ the SAME
// input the Node path builds:
//
//	decode → 128×128 "fill" area-average resample (premultiplied alpha) → EXIF orientation → flatten on
//	WHITE (value) and, when ≥0.5% of pixels are see-through, on BLACK (value_alt) → PDQ + quality
//
// Area averaging is what libvips does for a large shrink (shrink-on-load + box shrink, then a short lanczos
// reduce), so the two decoders land within a few bits of each other — measured in §FD.8, far inside the
// 24-bit strict threshold. Results carry strategy "go-area" so a reader can always tell which decoder made
// a value.
//
// Go decodes jpeg/png/gif/webp(still)/bmp/tiff. Anything it cannot decode (HEIC/HEIF/AVIF, animated WebP, a
// file the stdlib rejects) is DEFERRED: the scan reports it and the backend runs it through the per-file
// sharp path, so no file loses its fingerprint because of this decoder.
package main

import (
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/color"
	"io"
	"math"
	"os"
	"strings"

	"github.com/ajdnik/imghash/v2/hashtype"
)

const (
	hashEdge            = 128   // the Node path's HASH_EDGE: every image becomes 128×128 before PDQ
	maxDecodePixels     = 64e6  // the Node path's MAX_DECODE_PIXELS
	alphaAltMinFraction = 0.005 // the Node path's ALPHA_ALT_MIN_FRACTION
	imageStrategy       = "go-area"
)

// errDefer marks an image this decoder cannot read; the backend's sharp path takes it instead.
type errDefer struct{ why string }

func (e errDefer) Error() string { return e.why }

// errTooLarge mirrors the Node path's decode-ceiling refusal (code too_large).
type errTooLarge struct{ why string }

func (e errTooLarge) Error() string { return e.why }

type nativeImageResult struct {
	hash    string
	hashAlt string
	quality int
}

// sniffKind is media-sniff.ts in Go: what a file's first 16 bytes say it is. "" = no opinion.
// "heif" is an ISO-BMFF still (HEIC/AVIF) — an image this decoder must defer.
func sniffKind(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	b := make([]byte, 16)
	n, _ := io.ReadFull(f, b)
	b = b[:n]
	if n < 4 {
		return ""
	}
	ascii := func(start, l int) string {
		if len(b) < start+l {
			return ""
		}
		return string(b[start : start+l])
	}
	switch {
	case b[0] == 0xff && b[1] == 0xd8 && b[2] == 0xff,
		b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4e && b[3] == 0x47,
		ascii(0, 3) == "GIF",
		b[0] == 0x42 && b[1] == 0x4d,
		b[0] == 0x49 && b[1] == 0x49 && b[2] == 0x2a && b[3] == 0x00,
		b[0] == 0x4d && b[1] == 0x4d && b[2] == 0x00 && b[3] == 0x2a:
		return "image"
	case ascii(0, 4) == "RIFF":
		switch ascii(8, 4) {
		case "WEBP":
			return "image"
		case "WAVE":
			return "audio"
		case "AVI ":
			return "video"
		}
		return ""
	case ascii(4, 4) == "ftyp":
		switch strings.ToLower(ascii(8, 4)) {
		case "heic", "heix", "heim", "heis", "hevc", "hevm", "hevs", "mif1", "msf1", "avif", "avis":
			return "heif"
		}
		return "video"
	case ascii(0, 5) == "%PDF-":
		return "pdf"
	case ascii(0, 3) == "ID3", ascii(0, 4) == "OggS", ascii(0, 4) == "fLaC",
		b[0] == 0xff && (b[1]&0xe0) == 0xe0:
		return "audio"
	case b[0] == 0x1a && b[1] == 0x45 && b[2] == 0xdf && b[3] == 0xa3,
		b[0] == 0x30 && b[1] == 0x26 && b[2] == 0xb2 && b[3] == 0x75,
		ascii(0, 3) == "FLV":
		return "video"
	}
	return ""
}

// hashImageNative fingerprints one image file in-process. errDefer = hand it to the sharp path.
func hashImageNative(path string) (res nativeImageResult, err error) {
	defer func() {
		if p := recover(); p != nil {
			err = errDefer{fmt.Sprintf("go decoder panicked: %v", p)}
		}
	}()
	f, err := os.Open(path)
	if err != nil {
		return res, err
	}
	defer f.Close()

	// Header first: the pixel ceiling is enforced before a single pixel is decoded (to_fix.mdx §3.3.3).
	cfg, _, err := image.DecodeConfig(f)
	if err != nil {
		return res, errDefer{"go cannot read this image header: " + err.Error()}
	}
	if float64(cfg.Width)*float64(cfg.Height) > maxDecodePixels {
		return res, errTooLarge{fmt.Sprintf("image is %.0fMP — beyond the %.0fMP fingerprint decode ceiling",
			float64(cfg.Width)*float64(cfg.Height)/1e6, maxDecodePixels/1e6)}
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return res, err
	}
	img, format, err := image.Decode(f)
	if err != nil {
		return res, errDefer{"go cannot decode this image: " + err.Error()}
	}
	orient := 1
	if format == "jpeg" {
		orient = jpegOrientation(path)
	}

	prem := areaResample(img, hashEdge, hashEdge) // premultiplied RGBA, 0..255 floats
	prem = applyOrientation(prem, hashEdge, orient)

	white, black := flattenBoth(prem, hashEdge*hashEdge)
	wh, wq, err := pdqRGBA(white)
	if err != nil {
		return res, err
	}
	res.hash, res.quality = wh, wq
	if black != nil {
		bh, _, err := pdqRGBA(black)
		if err == nil && bh != wh {
			res.hashAlt = bh
		}
	}
	return res, nil
}

func pdqRGBA(img *image.RGBA) (string, int, error) {
	h, err := hasher.Calculate(img)
	if err != nil {
		return "", 0, err
	}
	bin, ok := h.(hashtype.Binary)
	if !ok || len(bin) != 32 {
		return "", 0, errors.New("unexpected PDQ hash shape")
	}
	return hex.EncodeToString(bin), pdqQuality(img), nil
}

// flattenBoth is fingerprint.service.ts flattenBoth on premultiplied input: over white = p + 255 − A, over
// black = p. Values are rounded to bytes first, the way sharp hands Node an 8-bit buffer.
func flattenBoth(prem []float32, n int) (*image.RGBA, *image.RGBA) {
	seeThrough := 0
	for i := 0; i < n; i++ {
		if math.Round(float64(prem[i*4+3])) < 250 {
			seeThrough++
		}
	}
	rect := image.Rect(0, 0, hashEdge, hashEdge)
	white := image.NewRGBA(rect)
	var black *image.RGBA
	if float64(seeThrough)/float64(n) >= alphaAltMinFraction {
		black = image.NewRGBA(rect)
	}
	for i := 0; i < n; i++ {
		a := clamp255(prem[i*4+3])
		for c := 0; c < 3; c++ {
			p := clamp255(prem[i*4+c])
			if p > a {
				p = a // premultiplied colour can never exceed its alpha
			}
			white.Pix[i*4+c] = uint8(math.Round(p + 255 - a))
			if black != nil {
				black.Pix[i*4+c] = uint8(math.Round(p))
			}
		}
		white.Pix[i*4+3] = 255
		if black != nil {
			black.Pix[i*4+3] = 255
		}
	}
	return white, black
}

func clamp255(v float32) float64 {
	f := float64(v)
	if f < 0 {
		return 0
	}
	if f > 255 {
		return 255
	}
	return f
}

// areaResample: exact area averaging of premultiplied RGBA into outW×outH ("fill": aspect squashed, as the
// Node path's sharp resize fit:"fill"). Separable — one pass over the source rows (the only O(W×H) work),
// accumulating into outH rows of outW columns. An upscale degrades gracefully into nearest/linear coverage.
func areaResample(img image.Image, outW, outH int) []float32 {
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	// Horizontal coverage table: for each source column, up to two (output column, weight) pairs when
	// shrinking; for an upscale a source column spans several output columns, handled by the general spans.
	type span struct {
		out int
		wt  float32
	}
	colSpans := make([][]span, w)
	sx := float64(outW) / float64(w)
	for x := 0; x < w; x++ {
		x0, x1 := float64(x)*sx, float64(x+1)*sx
		for o := int(x0); o < outW && float64(o) < x1; o++ {
			lo, hi := math.Max(x0, float64(o)), math.Min(x1, float64(o+1))
			if hi > lo {
				colSpans[x] = append(colSpans[x], span{o, float32(hi - lo)})
			}
		}
	}
	acc := make([]float32, outW*outH*4)
	wsum := make([]float32, outW*outH)
	rowOut := make([]float32, outW*4)
	rowW := make([]float32, outW)
	src := make([]float32, w*4)
	sy := float64(outH) / float64(h)
	for y := 0; y < h; y++ {
		readRow(img, b.Min.X, b.Min.Y+y, w, src)
		for i := range rowOut {
			rowOut[i] = 0
		}
		for i := range rowW {
			rowW[i] = 0
		}
		for x := 0; x < w; x++ {
			for _, s := range colSpans[x] {
				o := s.out * 4
				rowOut[o] += src[x*4] * s.wt
				rowOut[o+1] += src[x*4+1] * s.wt
				rowOut[o+2] += src[x*4+2] * s.wt
				rowOut[o+3] += src[x*4+3] * s.wt
				rowW[s.out] += s.wt
			}
		}
		y0, y1 := float64(y)*sy, float64(y+1)*sy
		for oy := int(y0); oy < outH && float64(oy) < y1; oy++ {
			lo, hi := math.Max(y0, float64(oy)), math.Min(y1, float64(oy+1))
			if hi <= lo {
				continue
			}
			wt := float32(hi - lo)
			base := oy * outW
			for ox := 0; ox < outW; ox++ {
				o := (base + ox) * 4
				acc[o] += rowOut[ox*4] * wt
				acc[o+1] += rowOut[ox*4+1] * wt
				acc[o+2] += rowOut[ox*4+2] * wt
				acc[o+3] += rowOut[ox*4+3] * wt
				wsum[base+ox] += rowW[ox] * wt
			}
		}
	}
	for i, ws := range wsum {
		if ws > 0 {
			for c := 0; c < 4; c++ {
				acc[i*4+c] /= ws
			}
		}
	}
	return acc
}

// readRow fills dst with one source row as premultiplied RGBA on a 0..255 scale. Fast paths for the types
// the stdlib decoders actually return (JPEG → YCbCr/Gray, PNG → NRGBA/RGBA/Paletted); anything else goes
// through the generic At(), which already returns premultiplied 16-bit values.
func readRow(img image.Image, x0, y, w int, dst []float32) {
	switch m := img.(type) {
	case *image.YCbCr:
		for x := 0; x < w; x++ {
			yi := m.YOffset(x0+x, y)
			ci := m.COffset(x0+x, y)
			r, g, bl := color.YCbCrToRGB(m.Y[yi], m.Cb[ci], m.Cr[ci])
			dst[x*4], dst[x*4+1], dst[x*4+2], dst[x*4+3] = float32(r), float32(g), float32(bl), 255
		}
	case *image.Gray:
		row := m.Pix[m.PixOffset(x0, y):]
		for x := 0; x < w; x++ {
			v := float32(row[x])
			dst[x*4], dst[x*4+1], dst[x*4+2], dst[x*4+3] = v, v, v, 255
		}
	case *image.NRGBA:
		row := m.Pix[m.PixOffset(x0, y):]
		for x := 0; x < w; x++ {
			a := float32(row[x*4+3]) / 255
			dst[x*4] = float32(row[x*4]) * a
			dst[x*4+1] = float32(row[x*4+1]) * a
			dst[x*4+2] = float32(row[x*4+2]) * a
			dst[x*4+3] = float32(row[x*4+3])
		}
	case *image.RGBA:
		row := m.Pix[m.PixOffset(x0, y):]
		for x := 0; x < w*4; x++ {
			dst[x] = float32(row[x])
		}
	default:
		for x := 0; x < w; x++ {
			r, g, bl, a := img.At(x0+x, y).RGBA()
			dst[x*4], dst[x*4+1], dst[x*4+2], dst[x*4+3] =
				float32(r)/257, float32(g)/257, float32(bl)/257, float32(a)/257
		}
	}
}

// applyOrientation rotates/flips a square n×n premultiplied buffer per EXIF orientation (sharp .rotate()).
// Because the target is square, orienting AFTER the fill resample equals orienting before it.
func applyOrientation(src []float32, n, orient int) []float32 {
	if orient < 2 || orient > 8 {
		return src
	}
	dst := make([]float32, len(src))
	for y := 0; y < n; y++ {
		for x := 0; x < n; x++ {
			// (x, y) in the OUTPUT (displayed) image ← (sx, sy) in the stored image.
			var sx, sy int
			switch orient {
			case 2: // mirror horizontal
				sx, sy = n-1-x, y
			case 3: // rotate 180
				sx, sy = n-1-x, n-1-y
			case 4: // mirror vertical
				sx, sy = x, n-1-y
			case 5: // transpose
				sx, sy = y, x
			case 6: // rotate 90 CW
				sx, sy = y, n-1-x
			case 7: // transverse
				sx, sy = n-1-y, n-1-x
			case 8: // rotate 90 CCW
				sx, sy = n-1-y, x
			}
			copy(dst[(y*n+x)*4:(y*n+x)*4+4], src[(sy*n+sx)*4:(sy*n+sx)*4+4])
		}
	}
	return dst
}

// jpegOrientation reads the EXIF Orientation tag (0x0112) from a JPEG's APP1 segment. 1 when absent.
func jpegOrientation(path string) int {
	f, err := os.Open(path)
	if err != nil {
		return 1
	}
	defer f.Close()
	buf := make([]byte, 256*1024)
	n, _ := io.ReadFull(f, buf)
	b := buf[:n]
	if len(b) < 4 || b[0] != 0xff || b[1] != 0xd8 {
		return 1
	}
	i := 2
	for i+4 <= len(b) {
		if b[i] != 0xff {
			return 1
		}
		marker := b[i+1]
		if marker == 0xda || marker == 0xd9 { // start of scan / end: no EXIF before the image data
			return 1
		}
		segLen := int(binary.BigEndian.Uint16(b[i+2:]))
		if segLen < 2 || i+2+segLen > len(b) {
			return 1
		}
		seg := b[i+4 : i+2+segLen]
		if marker == 0xe1 && len(seg) > 14 && string(seg[:6]) == "Exif\x00\x00" {
			return tiffOrientation(seg[6:])
		}
		i += 2 + segLen
	}
	return 1
}

func tiffOrientation(t []byte) int {
	if len(t) < 8 {
		return 1
	}
	var bo binary.ByteOrder
	switch string(t[:2]) {
	case "II":
		bo = binary.LittleEndian
	case "MM":
		bo = binary.BigEndian
	default:
		return 1
	}
	ifd := int(bo.Uint32(t[4:]))
	if ifd+2 > len(t) {
		return 1
	}
	count := int(bo.Uint16(t[ifd:]))
	for k := 0; k < count; k++ {
		e := ifd + 2 + k*12
		if e+12 > len(t) {
			return 1
		}
		if bo.Uint16(t[e:]) == 0x0112 {
			v := int(bo.Uint16(t[e+8:]))
			if v >= 1 && v <= 8 {
				return v
			}
			return 1
		}
	}
	return 1
}
