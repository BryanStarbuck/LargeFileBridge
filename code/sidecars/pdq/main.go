// lfb-pdq — Large File Bridge's PDQ perceptual-fingerprint sidecar (perceptual_fingerprint.mdx §A.0,
// the FINAL image decision: "PDQ via ajdnik/imghash (Go v2)", image rank #1, MIT).
//
// A single static Go binary with no C dependencies. The Node backend keeps ONE long-lived instance and
// talks to it over stdin/stdout, one JSON object per line (NDJSON):
//
//	request : {"id":7,"raw":"<base64 RGB bytes>","w":512,"h":341}   (pixels already decoded by sharp)
//	          {"id":8,"path":"/abs/file.jpg"}                        (Go decodes: jpeg/png/gif/webp/bmp/tiff)
//	response: {"id":7,"hash":"<64 hex = 256 bits>","quality":87,"ms":1.4}
//	          {"id":8,"error":"..."}
//
// A second mode, `lfb-pdq --scan`, is the BULK DIRECTORY SCAN (scan.go): one process walks a directory and
// fingerprints every matching file in-process on ~80% of the cores, streaming one NDJSON event per file.
//
// The backend always sends "raw": sharp already decodes every format we care about (HEIC included) at a
// bounded size (perceptual.service.ts decodeForHash, the to_fix.mdx §3.3 memory gate), so the sidecar
// never has to read a user's file. "path" exists for hand-testing: `lfb-pdq FILE...` prints one line per
// file.
//
// NO NETWORK. This program imports no net/http and opens no socket (perceptual_fingerprint.mdx §6). It
// reads stdin, writes stdout, and in one-shot mode opens the files named on its command line. Nothing else.
package main

import (
	"bufio"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"math"
	"os"
	"runtime"
	"sync"
	"time"

	"github.com/ajdnik/imghash/v2"
	"github.com/ajdnik/imghash/v2/hashtype"
	_ "golang.org/x/image/bmp"
	_ "golang.org/x/image/tiff"
	_ "golang.org/x/image/webp"
)

// Bumped whenever the hash or quality computation changes. The backend stores it beside every value, so a
// fingerprint computed by an older sidecar is recognizably stale instead of silently incomparable.
const version = "lfb-pdq/2 imghash/v2 pdq-256"

// Refuse absurd raw frames outright. The backend never sends more than 512×512 (HASH_DECODE_MAX_EDGE), so
// anything past this is a protocol bug, and decoding it would be a memory hazard.
const maxRawPixels = 4096 * 4096

type request struct {
	ID   int64  `json:"id"`
	Raw  string `json:"raw,omitempty"`
	W    int    `json:"w,omitempty"`
	H    int    `json:"h,omitempty"`
	Path string `json:"path,omitempty"`
	// Video mode (video.go): the absolute path of a video, and optional sampling knobs.
	Video     string  `json:"video,omitempty"`
	Interval  float64 `json:"interval,omitempty"`   // seconds between samples (default 1)
	MaxFrames int     `json:"max_frames,omitempty"` // cap on samples (default 3600)
	TimeoutS  int     `json:"timeout_s,omitempty"`  // hard kill for ffmpeg (default 900)
	NoHW      bool    `json:"no_hw,omitempty"`      // skip the VideoToolbox attempt
	FFThreads int     `json:"ff_threads,omitempty"` // cap ffmpeg decoder threads (0 = ffmpeg default)
	// Decoder threads for the software-full plan only (0 = FFThreads). A full decode is the one plan whose
	// cost is minutes, and it is the tail of a bulk scan, so the scan gives it a bigger share.
	FullThreads int `json:"full_threads,omitempty"`
}

type response struct {
	ID      int64   `json:"id"`
	Hash    string  `json:"hash,omitempty"`
	Quality int     `json:"quality"`
	Ms      float64 `json:"ms"`
	Error   string  `json:"error,omitempty"`
	// Video mode only.
	Frames   []videoFrame `json:"frames,omitempty"`
	Duration float64      `json:"duration,omitempty"` // container duration in seconds, when ffprobe knew it
	Strategy string       `json:"strategy,omitempty"` // which decode plan produced the frames
	Tried    []string     `json:"tried,omitempty"`    // every plan attempted, with why it was abandoned
}

var hasher imghash.PDQ

type imghashPDQ = imghash.PDQ

func newPDQ() (imghash.PDQ, error) { return imghash.NewPDQ() }

func main() {
	var err error
	hasher, err = newPDQ()
	if err != nil {
		fmt.Fprintln(os.Stderr, "lfb-pdq: cannot build PDQ hasher:", err)
		os.Exit(2)
	}
	args := os.Args[1:]
	if len(args) == 1 && (args[0] == "--version" || args[0] == "-v") {
		fmt.Println(version)
		return
	}
	if len(args) >= 1 && args[0] == "--scan" {
		os.Exit(scanMain(args[1:]))
	}
	if len(args) >= 2 && args[0] == "--video" {
		oneShotVideo(args[1:])
		return
	}
	if len(args) > 0 && args[0] != "--serve" {
		oneShot(args)
		return
	}
	serve()
}

// oneShot: `lfb-pdq a.jpg b.png` → "<hash> <quality> <path>" per line. For humans and tests.
func oneShot(paths []string) {
	failed := false
	for _, p := range paths {
		r := hashRequest(request{Path: p})
		if r.Error != "" {
			fmt.Fprintf(os.Stderr, "%s: %s\n", p, r.Error)
			failed = true
			continue
		}
		fmt.Printf("%s %d %s\n", r.Hash, r.Quality, p)
	}
	if failed {
		os.Exit(1)
	}
}

// serve: the NDJSON loop. Requests are hashed concurrently (bounded by the CPU count); responses carry the
// request id, so they may come back out of order and the backend matches them up.
func serve() {
	in := bufio.NewReaderSize(os.Stdin, 1<<20)
	out := bufio.NewWriter(os.Stdout)
	var outMu sync.Mutex
	sem := make(chan struct{}, runtime.NumCPU())
	var wg sync.WaitGroup

	write := func(r response) {
		b, _ := json.Marshal(r)
		outMu.Lock()
		out.Write(b)
		out.WriteByte('\n')
		out.Flush()
		outMu.Unlock()
	}

	for {
		line, err := in.ReadBytes('\n')
		if len(line) > 0 {
			var req request
			if jerr := json.Unmarshal(line, &req); jerr != nil {
				write(response{ID: -1, Error: "bad request json: " + jerr.Error()})
			} else {
				sem <- struct{}{}
				wg.Add(1)
				go func(req request) {
					defer func() { <-sem; wg.Done() }()
					write(hashRequest(req))
				}(req)
			}
		}
		if err != nil {
			break // EOF: the backend closed our stdin — finish in-flight work and exit
		}
	}
	wg.Wait()
}

func hashRequest(req request) (res response) {
	if req.Video != "" {
		return hashVideo(req)
	}
	start := time.Now()
	res.ID = req.ID
	defer func() {
		if p := recover(); p != nil {
			res.Error = fmt.Sprintf("panic while hashing: %v", p)
			res.Hash = ""
		}
		res.Ms = math.Round(float64(time.Since(start).Microseconds())/10) / 100
	}()

	img, err := loadImage(req)
	if err != nil {
		res.Error = err.Error()
		return
	}
	h, err := hasher.Calculate(img)
	if err != nil {
		res.Error = err.Error()
		return
	}
	bin, ok := h.(hashtype.Binary)
	if !ok || len(bin) != 32 {
		res.Error = "unexpected PDQ hash shape"
		return
	}
	res.Hash = hex.EncodeToString(bin)
	res.Quality = pdqQuality(img)
	return
}

func loadImage(req request) (image.Image, error) {
	if req.Raw != "" {
		if req.W <= 0 || req.H <= 0 || req.W*req.H > maxRawPixels {
			return nil, fmt.Errorf("bad raw dimensions %dx%d", req.W, req.H)
		}
		px, err := base64.StdEncoding.DecodeString(req.Raw)
		if err != nil {
			return nil, errors.New("raw is not base64")
		}
		if len(px) != req.W*req.H*3 {
			return nil, fmt.Errorf("raw is %d bytes, want %d (w*h*3 RGB)", len(px), req.W*req.H*3)
		}
		img := image.NewRGBA(image.Rect(0, 0, req.W, req.H))
		for i, j := 0, 0; i < len(px); i, j = i+3, j+4 {
			img.Pix[j], img.Pix[j+1], img.Pix[j+2], img.Pix[j+3] = px[i], px[i+1], px[i+2], 255
		}
		return img, nil
	}
	if req.Path != "" {
		f, err := os.Open(req.Path)
		if err != nil {
			return nil, err
		}
		defer f.Close()
		img, _, err := image.Decode(f)
		return img, err
	}
	return nil, errors.New("request has neither raw nor path")
}

// pdqQuality is the PDQ reference's image-domain quality metric (ThreatExchange pdqhashing.cpp
// computePDQImageDomainQualityMetric): the summed absolute luminance gradient over a 64×64 downsample,
// scaled so a normal photo lands near 100 and a flat or near-flat frame near 0. imghash computes the hash
// but not this score, so we compute it here the same way. perceptual_fingerprint.mdx §4 gates automatic
// matching on it (the reference README recommends ignoring hashes with quality < 50).
func pdqQuality(img image.Image) int {
	const n = 64
	var luma [n][n]float64
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= 0 || h <= 0 {
		return 0
	}
	// Box-average each of the 64×64 cells, so every source pixel contributes (no aliasing on small text).
	for cy := 0; cy < n; cy++ {
		y0, y1 := b.Min.Y+cy*h/n, b.Min.Y+(cy+1)*h/n
		if y1 <= y0 {
			y1 = y0 + 1
		}
		for cx := 0; cx < n; cx++ {
			x0, x1 := b.Min.X+cx*w/n, b.Min.X+(cx+1)*w/n
			if x1 <= x0 {
				x1 = x0 + 1
			}
			var sum float64
			var cnt int
			for y := y0; y < y1 && y < b.Max.Y; y++ {
				for x := x0; x < x1 && x < b.Max.X; x++ {
					sum += lumaAt(img, x, y)
					cnt++
				}
			}
			if cnt > 0 {
				luma[cy][cx] = sum / float64(cnt)
			}
		}
	}
	gradientSum := 0
	for i := 0; i < n-1; i++ {
		for j := 0; j < n; j++ {
			gradientSum += int(math.Abs((luma[i][j] - luma[i+1][j]) * 100 / 255))
		}
	}
	for i := 0; i < n; i++ {
		for j := 0; j < n-1; j++ {
			gradientSum += int(math.Abs((luma[i][j] - luma[i][j+1]) * 100 / 255))
		}
	}
	q := gradientSum / 90
	if q > 100 {
		q = 100
	}
	return q
}

// lumaAt reads one pixel's luminance, taking the fast path for the *image.RGBA every raw/video frame is.
func lumaAt(img image.Image, x, y int) float64 {
	if rgba, ok := img.(*image.RGBA); ok {
		i := rgba.PixOffset(x, y)
		p := rgba.Pix[i : i+3 : i+3]
		return 0.299*float64(p[0]) + 0.587*float64(p[1]) + 0.114*float64(p[2])
	}
	r, g, b, _ := img.At(x, y).RGBA()
	return 0.299*float64(r>>8) + 0.587*float64(g>>8) + 0.114*float64(b>>8)
}
