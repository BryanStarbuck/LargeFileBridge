// Video mode: PDQ per sampled frame on our own ffmpeg sampler (perceptual_fingerprint.mdx §A.0, the FINAL
// video decision, video rank #1). It was chosen over vPDQ (#3) and Thorn `perception` (#2) because it is the
// FASTEST of the three by measurement (§A.0.2). Where the speed comes from:
//
//  1. KEYFRAMES FIRST. `-skip_frame nokey` makes the decoder decode only the intra frames. Most real-world
//     encodes place a keyframe every 1–2 s, which already is our 1 fps sample grid, so the P/B frames
//     between them (the other ~97% of the decode work) are skipped entirely.
//  2. HARDWARE DECODE WHEN IT WORKS. On macOS the keyframe pass first tries VideoToolbox, and scales on the
//     GPU (`scale_vt`) so only a 128×128 frame is copied back to memory. Measured 2.3× faster than software on
//     a 4K H.264 file. Some streams (e.g. 10-bit HEVC) refuse this path, so any failure falls back to
//     software. The failure is quiet but recorded in `tried`.
//  3. TINY FRAMES, NO FILES. ffmpeg scales to 128×128 and pipes raw RGB straight into this process: no JPEG
//     or PNG per frame, no temp directory, no second decode. PDQ reduces every frame to 64×64 anyway.
//  4. HASHING IN PARALLEL with decoding, across all cores.
//
// When keyframes are too sparse to cover the timeline (a long-GOP encode), the pass is redone with a full
// decode that samples every `interval` seconds. It is still fast: loop filtering is skipped and frames
// stay tiny.
//
// NO NETWORK: ffmpeg is invoked with `-protocol_whitelist file,pipe` and a `file:` input, so even a playlist
// that references URLs cannot make it open a socket (perceptual_fingerprint.mdx §6).
package main

import (
	"bufio"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ajdnik/imghash/v2/hashtype"
)

const (
	frameEdge        = 128 // ffmpeg scales every sample to frameEdge × frameEdge (PDQ then reduces to 64×64)
	frameBytes       = frameEdge * frameEdge * 3
	defaultInterval  = 1.0
	defaultMaxFrames = 3600
	defaultTimeoutS  = 900
)

type videoFrame struct {
	N  int     `json:"n"`
	H  string  `json:"h"`  // 64-hex PDQ
	Q  int     `json:"q"`  // PDQ quality 0..100
	TS float64 `json:"ts"` // seconds into the video
}

type plan struct {
	name   string
	pre    []string // input-side options
	vf     string
	hw     bool
	sparse bool // keyframe plan: must be checked for coverage
}

var ptsRe = regexp.MustCompile(`pts_time:\s*(-?[0-9.]+)`)

// baseCtx parents every ffprobe/ffmpeg this process starts. The NDJSON server leaves it at Background; the
// bulk scan (scan.go) swaps in a context that SIGTERM cancels, so cancelling a scan kills its decoders too.
var baseCtx = context.Background()

// vtRefused remembers the (codec, pixel format) pairs VideoToolbox could not decode in this process, so a
// folder full of the same kind of file pays for the failed attempt once, not once per file.
var (
	vtRefusedMu sync.Mutex
	vtRefused   = map[string]string{}
)

func vtKnownBad(key string) (string, bool) {
	vtRefusedMu.Lock()
	defer vtRefusedMu.Unlock()
	why, bad := vtRefused[key]
	return why, bad
}

func noteVTRefused(key, why string) {
	vtRefusedMu.Lock()
	defer vtRefusedMu.Unlock()
	if len(vtRefused) < 256 {
		vtRefused[key] = why
	}
}

// vtDownloadFormat is the software format a VideoToolbox frame must be downloaded as. It follows the
// stream's bit depth: 10-bit HEVC/ProRes decode to P010, 8-bit to NV12. Asking for NV12 on a 10-bit
// stream is exactly the "nothing was written" failure measured on Dolby Vision HEVC; with P010 the same
// file decodes in hardware in 0.36 s instead of 1.4 s in software.
func vtDownloadFormat(pixFmt string) string {
	if strings.Contains(pixFmt, "10") || strings.Contains(pixFmt, "p010") {
		return "p010le"
	}
	return "nv12"
}

func hashVideo(req request) (res response) {
	start := time.Now()
	res.ID = req.ID
	defer func() {
		if p := recover(); p != nil {
			res.Error = fmt.Sprintf("panic while hashing video: %v", p)
			res.Frames = nil
		}
		res.Ms = math.Round(float64(time.Since(start).Microseconds())/10) / 100
	}()

	path := req.Video
	if strings.Contains(path, "://") || !filepath.IsAbs(path) {
		res.Error = "video must be an absolute local path"
		return
	}
	if st, err := os.Stat(path); err != nil {
		res.Error = err.Error()
		return
	} else if st.IsDir() {
		res.Error = "video path is a directory"
		return
	}
	ffmpeg, ffprobe, err := findTools()
	if err != nil {
		res.Error = err.Error()
		return
	}

	interval := req.Interval
	if interval <= 0 {
		interval = defaultInterval
	}
	maxFrames := req.MaxFrames
	if maxFrames <= 0 {
		maxFrames = defaultMaxFrames
	}
	timeout := time.Duration(req.TimeoutS) * time.Second
	if timeout <= 0 {
		timeout = defaultTimeoutS * time.Second
	}
	deadline := time.Now().Add(timeout)

	pr := probe(ffprobe, path)
	duration, codec := pr.duration, pr.codec
	res.Duration = duration
	// A long video keeps a bounded list: stretch the interval so at most maxFrames samples come out.
	if duration > 0 && duration/interval > float64(maxFrames) {
		interval = duration / float64(maxFrames)
	}

	sel := fmt.Sprintf("select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,%.3f)'", interval*0.9)
	swScale := fmt.Sprintf("scale=%d:%d:flags=area,format=rgb24", frameEdge, frameEdge)
	plans := []plan{}
	vtKey := codec + "/" + pr.pixFmt
	if !req.NoHW && runtime.GOOS == "darwin" {
		if why, bad := vtKnownBad(vtKey); bad {
			res.Tried = append(res.Tried, "videotoolbox-keyframes: skipped, refused earlier for "+vtKey+" ("+why+")")
		} else {
			plans = append(plans, plan{
				name: "videotoolbox-keyframes",
				pre:  []string{"-skip_frame", "nokey", "-hwaccel", "videotoolbox", "-hwaccel_output_format", "videotoolbox_vld"},
				vf: sel + ",showinfo," + fmt.Sprintf("scale_vt=w=%d:h=%d,hwdownload,format=%s,format=rgb24",
					frameEdge, frameEdge, vtDownloadFormat(pr.pixFmt)),
				hw:     true,
				sparse: true,
			})
		}
	}
	plans = append(plans,
		plan{
			name:   "software-keyframes",
			pre:    []string{"-skip_frame", "nokey", "-skip_loop_filter", "all", "-flags2", "fast"},
			vf:     sel + ",showinfo," + swScale,
			sparse: true,
		},
		plan{
			name: "software-full",
			pre:  []string{"-skip_loop_filter", "all", "-flags2", "fast"},
			vf:   sel + ",showinfo," + swScale,
		},
	)

	for _, p := range plans {
		if p.name == "" {
			continue // dropped by an earlier sparse-keyframe verdict
		}
		if time.Now().After(deadline) {
			res.Tried = append(res.Tried, p.name+": skipped, timeout reached")
			break
		}
		if baseCtx.Err() != nil {
			res.Error = "cancelled"
			return
		}
		threads := req.FFThreads
		if !p.sparse && req.FullThreads > threads {
			threads = req.FullThreads
		}
		frames, why := runPlan(ffmpeg, path, p, maxFrames, deadline, pr.startTime, threads)
		if why != "" {
			res.Tried = append(res.Tried, p.name+": "+why)
			if p.hw && why != "timed out" && why != "cancelled" && codec != "" {
				noteVTRefused(vtKey, shortWhy(why))
			}
			continue
		}
		if p.sparse {
			if gap := coverageGap(frames, duration); gap > sparseLimit(interval) {
				res.Tried = append(res.Tried, fmt.Sprintf("%s: keyframes too sparse (%.1fs gap)", p.name, gap))
				// A hardware keyframe pass that is sparse will be just as sparse in software; go straight to full.
				for i := range plans {
					if plans[i].name == "software-keyframes" {
						plans[i].name = "" // marker: skip
					}
				}
				continue
			}
		}
		res.Frames = frames
		res.Strategy = p.name
		if len(frames) > 0 {
			res.Quality = bestQuality(frames)
		}
		return
	}
	if baseCtx.Err() != nil {
		res.Error = "cancelled"
		return
	}
	if res.Error == "" {
		res.Error = "no decode plan produced frames"
		if codec != "" {
			res.Error += " (codec " + codec + ")"
		}
		if len(res.Tried) > 0 {
			res.Error += ": " + strings.Join(res.Tried, "; ")
		}
	}
	return
}

func sparseLimit(interval float64) float64 { return math.Max(5, 4*interval) }

// coverageGap is the largest stretch of the timeline with no sample: before the first, between two, or after
// the last (when the duration is known).
func coverageGap(frames []videoFrame, duration float64) float64 {
	if len(frames) == 0 {
		return math.Inf(1)
	}
	gap := frames[0].TS
	for i := 1; i < len(frames); i++ {
		gap = math.Max(gap, frames[i].TS-frames[i-1].TS)
	}
	if duration > 0 {
		gap = math.Max(gap, duration-frames[len(frames)-1].TS)
	}
	return gap
}

func bestQuality(frames []videoFrame) int {
	best := 0
	for _, f := range frames {
		if f.Q > best {
			best = f.Q
		}
	}
	return best
}

func findTools() (string, string, error) {
	ff := os.Getenv("LFB_FFMPEG")
	if ff == "" {
		p, err := exec.LookPath("ffmpeg")
		if err != nil {
			return "", "", errors.New("ffmpeg not installed — install it (brew install ffmpeg) to fingerprint video")
		}
		ff = p
	}
	fp := filepath.Join(filepath.Dir(ff), "ffprobe")
	if _, err := os.Stat(fp); err != nil {
		if p, err2 := exec.LookPath("ffprobe"); err2 == nil {
			fp = p
		} else {
			fp = ""
		}
	}
	return ff, fp, nil
}

type probeResult struct {
	duration  float64
	startTime float64
	codec     string
	pixFmt    string
}

// probe reads the container duration and start time plus the video codec and pixel format. Failure is not
// fatal: the duration stretches the interval for long videos and judges tail coverage, the start time
// makes timestamps start at 0, and codec/pixel format pick the VideoToolbox download format.
func probe(ffprobe, path string) probeResult {
	var pr probeResult
	if ffprobe == "" {
		return pr
	}
	ctx, cancel := context.WithTimeout(baseCtx, 20*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, ffprobe, "-v", "error", "-protocol_whitelist", "file",
		"-select_streams", "v:0", "-show_entries", "format=duration,start_time:stream=codec_name,pix_fmt",
		"-of", "json", "file:"+path).Output()
	if err != nil {
		return pr
	}
	var doc struct {
		Format struct {
			Duration  string `json:"duration"`
			StartTime string `json:"start_time"`
		} `json:"format"`
		Streams []struct {
			CodecName string `json:"codec_name"`
			PixFmt    string `json:"pix_fmt"`
		} `json:"streams"`
	}
	if json.Unmarshal(out, &doc) != nil {
		return pr
	}
	pr.duration, _ = strconv.ParseFloat(doc.Format.Duration, 64)
	pr.startTime, _ = strconv.ParseFloat(doc.Format.StartTime, 64)
	if math.IsNaN(pr.startTime) || math.IsInf(pr.startTime, 0) {
		pr.startTime = 0
	}
	if len(doc.Streams) > 0 {
		pr.codec = doc.Streams[0].CodecName
		pr.pixFmt = doc.Streams[0].PixFmt
	}
	return pr
}

func shortWhy(why string) string {
	if len(why) > 120 {
		return why[:120] + "…"
	}
	return why
}

// runPlan runs one ffmpeg decode plan and hashes its frames as they stream in. It returns the frames, or a
// short reason the plan failed (never both).
//
// ffThreads > 0 caps ffmpeg's decoder threads. The bulk scan runs many videos at once and sets it so the
// ffmpeg processes together fit the scan's core budget; 0 keeps ffmpeg's own default (one video at a time).
// Thread count never changes the decoded pixels, so it never changes a fingerprint.
func runPlan(ffmpeg, path string, p plan, maxFrames int, deadline time.Time, startTime float64, ffThreads int) ([]videoFrame, string) {
	ctx, cancel := context.WithDeadline(baseCtx, deadline)
	defer cancel()
	args := []string{"-nostdin", "-hide_banner", "-loglevel", "info", "-protocol_whitelist", "file,pipe"}
	if ffThreads > 0 {
		args = append(args, "-threads", strconv.Itoa(ffThreads))
	}
	args = append(args, p.pre...)
	args = append(args, "-i", "file:"+path, "-map", "0:v:0", "-an", "-sn", "-dn",
		"-vf", p.vf, "-fps_mode", "passthrough", "-frames:v", strconv.Itoa(maxFrames),
		"-f", "rawvideo", "pipe:1")
	cmd := exec.CommandContext(ctx, ffmpeg, args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err.Error()
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err.Error()
	}
	if err := cmd.Start(); err != nil {
		return nil, err.Error()
	}

	// stderr: the showinfo pts lines (one per emitted frame, in order) plus a bounded tail for errors.
	var pts []float64
	var tail []string
	stderrDone := make(chan struct{})
	go func() {
		defer close(stderrDone)
		sc := bufio.NewScanner(stderr)
		sc.Buffer(make([]byte, 64*1024), 1024*1024)
		for sc.Scan() {
			line := sc.Text()
			if strings.Contains(line, "showinfo") {
				if m := ptsRe.FindStringSubmatch(line); m != nil {
					if v, err := strconv.ParseFloat(m[1], 64); err == nil {
						pts = append(pts, v)
					}
				}
				continue
			}
			tail = append(tail, line)
			if len(tail) > 8 {
				tail = tail[1:]
			}
		}
	}()

	// stdout: raw 128×128 RGB frames. Hash them in parallel while ffmpeg keeps decoding.
	type slot struct {
		hash string
		q    int
		err  error
	}
	var mu sync.Mutex
	results := map[int]slot{}
	sem := make(chan struct{}, runtime.NumCPU())
	var wg sync.WaitGroup
	r := bufio.NewReaderSize(stdout, frameBytes*4)
	n := 0
	for {
		buf := make([]byte, frameBytes)
		if _, err := io.ReadFull(r, buf); err != nil {
			break // EOF (or a short tail frame when ffmpeg was killed): stop reading
		}
		idx := n
		n++
		sem <- struct{}{}
		wg.Add(1)
		go func() {
			defer func() { <-sem; wg.Done() }()
			img := image.NewRGBA(image.Rect(0, 0, frameEdge, frameEdge))
			for i, j := 0, 0; i < len(buf); i, j = i+3, j+4 {
				img.Pix[j], img.Pix[j+1], img.Pix[j+2], img.Pix[j+3] = buf[i], buf[i+1], buf[i+2], 255
			}
			h, err := hasher.Calculate(img)
			s := slot{err: err}
			if err == nil {
				if bin, ok := h.(hashtype.Binary); ok && len(bin) == 32 {
					s.hash = hex.EncodeToString(bin)
					s.q = pdqQuality(img)
				} else {
					s.err = errors.New("unexpected PDQ hash shape")
				}
			}
			mu.Lock()
			results[idx] = s
			mu.Unlock()
		}()
	}
	wg.Wait()
	<-stderrDone
	waitErr := cmd.Wait()

	if ctx.Err() == context.DeadlineExceeded {
		return nil, "timed out"
	}
	if ctx.Err() != nil {
		return nil, "cancelled"
	}
	if waitErr != nil && n == 0 {
		return nil, "ffmpeg failed: " + lastLines(tail)
	}
	if n == 0 {
		return nil, "ffmpeg produced no frames"
	}
	frames := make([]videoFrame, 0, n)
	for i := 0; i < n; i++ {
		s := results[i]
		if s.err != nil || s.hash == "" {
			continue // one bad frame is a lost sample, not a failed video
		}
		// Seconds from the START of the video: showinfo's pts_time counts from the container's start_time,
		// which is not 0 for many MPEG-TS captures and some edits. Without this, a subset's reported offset
		// is wrong by that amount and the coverage check sees a phantom gap at the start.
		ts := float64(i)
		if i < len(pts) {
			ts = math.Max(0, pts[i]-startTime)
		}
		frames = append(frames, videoFrame{N: len(frames), H: s.hash, Q: s.q, TS: math.Round(ts*1000) / 1000})
	}
	if len(frames) == 0 {
		return nil, "no frame could be hashed"
	}
	if waitErr != nil {
		// Frames came out but ffmpeg then failed (e.g. a truncated file). Keep what decoded; the caller sees
		// the frames, and the coverage check still guards a keyframe plan.
		return frames, ""
	}
	return frames, ""
}

func lastLines(lines []string) string {
	s := strings.TrimSpace(strings.Join(lines, " | "))
	if len(s) > 400 {
		s = s[len(s)-400:]
	}
	if s == "" {
		s = "no output"
	}
	return s
}

// oneShotVideo: `lfb-pdq --video a.mp4 …` prints strategy, timing and frame count per file.
func oneShotVideo(paths []string) {
	for _, p := range paths {
		abs, _ := filepath.Abs(p)
		r := hashVideo(request{Video: abs})
		if r.Error != "" {
			fmt.Fprintf(os.Stderr, "%s: %s\n", p, r.Error)
			continue
		}
		fmt.Printf("%s frames=%d strategy=%s ms=%.0f tried=%v\n", p, len(r.Frames), r.Strategy, r.Ms, r.Tried)
	}
}
