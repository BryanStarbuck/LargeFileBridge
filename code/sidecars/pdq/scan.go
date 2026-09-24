// Bulk directory scan: `lfb-pdq --scan` (perceptual_fingerprint.mdx §FD.8, apis.mdx §7.9).
//
// WHY THIS EXISTS. The per-file path (Node → this process over NDJSON, one request per file) tops out near
// 5 files/s on a real 7,000-file media tree: Node gates images at 12 and videos at 3, every image is decoded
// by sharp in Node and shipped here as base64, and every result crosses the pipe twice. For "fingerprint this
// whole directory and give me a CSV" none of that is needed. This mode does the whole job in ONE Go process:
//
//  1. WALK the directory (recursive, never following symlinks, skipping what the backend says to skip),
//     keeping only files whose extension is in the requested list. The walk finishes before any hashing
//     starts — it takes well under a second for ten thousand files — so the total is exact from the start.
//  2. SCHEDULE the longest work first: videos by size (largest first), then images. A single big video that
//     started last would otherwise be the whole tail of the run.
//  3. HASH on a pool of goroutines sized to ~80% of the cores (cpu_percent, or an explicit workers count).
//     Each worker calls the PDQ library in-process: images are decoded natively (image_native.go), videos
//     run the same ffmpeg keyframe sampler as the per-file path (video.go) with ffmpeg's threads capped so
//     all the concurrent decoders together fit the core budget.
//  4. STREAM one NDJSON event per file to stdout as it finishes. The backend turns them into job results,
//     stores them, and writes the CSV.
//
// Files it cannot decode natively (HEIC/AVIF, animated WebP, anything the Go decoders reject) are DEFERRED
// back to the backend's sharp path instead of failing. Files the backend already holds a still-valid value
// for (same size + mtime) are passed in as `known` and answered without being read.
//
// REQUEST: one JSON object on stdin (the backend's form), or command-line flags (hand testing):
//
//	lfb-pdq --scan DIR [--ext jpg,mp4] [--workers N] [--cpu-percent 80] [--no-recursive] [--max-files N]
//
// NO NETWORK: the walk reads the local filesystem, ffmpeg runs with a file-only protocol whitelist, and
// this file imports no net package (perceptual_fingerprint.mdx §6).
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

type scanKnown struct {
	Path    string  `json:"path"`
	Size    int64   `json:"size"`
	MtimeMs float64 `json:"mtime_ms"`
}

type scanRequest struct {
	Dir        string   `json:"dir"`
	Recursive  *bool    `json:"recursive,omitempty"`
	Extensions []string `json:"extensions,omitempty"` // lowercase, no dot; empty = every image and video extension
	Kinds      []string `json:"kinds,omitempty"`      // "image", "video"; empty = both
	ImageExts  []string `json:"image_exts,omitempty"` // the backend's media.ts lists; defaults below
	VideoExts  []string `json:"video_exts,omitempty"`
	SkipDirs   []string `json:"skip_dirs,omitempty"`         // exact directory names never entered
	SkipSuffix []string `json:"skip_dir_suffixes,omitempty"` // e.g. ".app": macOS bundles
	SkipHidden *bool    `json:"skip_hidden,omitempty"`       // directories starting with "." (default true)
	SkipPaths  []string `json:"skip_paths,omitempty"`        // absolute directories never entered
	// Read online-only cloud placeholders anyway (forces a download). Default false: they are reported
	// as not_downloaded without being opened.
	IncludeDataless bool        `json:"include_dataless,omitempty"`
	Workers         int         `json:"workers,omitempty"`
	CPUPercent      int         `json:"cpu_percent,omitempty"`
	FFThreads       int         `json:"ff_threads,omitempty"`
	MaxFiles        int         `json:"max_files,omitempty"`
	Interval        float64     `json:"interval,omitempty"`
	MaxFrames       int         `json:"max_frames,omitempty"`
	TimeoutS        int         `json:"timeout_s,omitempty"`
	Known           []scanKnown `json:"known,omitempty"`
	// DeferImages sends EVERY image back to the backend (sharp) and hashes only videos here. A switch for
	// comparing decoders; normal scans leave it off.
	DeferImages bool `json:"defer_images,omitempty"`
	// Never try the VideoToolbox hardware decoder (benchmarks, or a machine whose hardware decoder misbehaves).
	NoHW bool `json:"no_hw,omitempty"`
}

// One NDJSON line per event. Field names are the backend's contract (fingerprint.native-scan.ts).
type scanEvent struct {
	T        string       `json:"t"`
	Path     string       `json:"path,omitempty"`
	Kind     string       `json:"kind,omitempty"`
	Size     int64        `json:"size,omitempty"`
	MtimeMs  float64      `json:"mtime_ms,omitempty"`
	Hash     string       `json:"hash,omitempty"`
	HashAlt  string       `json:"hash_alt,omitempty"`
	Quality  *int         `json:"quality,omitempty"`
	Frames   []videoFrame `json:"frames,omitempty"`
	Duration float64      `json:"duration,omitempty"`
	Strategy string       `json:"strategy,omitempty"`
	Tried    []string     `json:"tried,omitempty"`
	Ms       float64      `json:"ms,omitempty"`
	Stable   *bool        `json:"stable,omitempty"`
	Code     string       `json:"code,omitempty"`
	Error    string       `json:"error,omitempty"`
	Why      string       `json:"why,omitempty"`
	Msg      string       `json:"msg,omitempty"`
	// walk / start / done
	Total          int    `json:"total,omitempty"`
	Images         int    `json:"images,omitempty"`
	Videos         int    `json:"videos,omitempty"`
	KnownCount     int    `json:"known,omitempty"`
	UnreadableDirs int    `json:"unreadable_dirs,omitempty"`
	Truncated      bool   `json:"truncated,omitempty"`
	Workers        int    `json:"workers,omitempty"`
	Cores          int    `json:"cores,omitempty"`
	Version        string `json:"version,omitempty"`
	Cancelled      bool   `json:"cancelled,omitempty"`
}

var defaultImageExts = []string{"png", "bmp", "tif", "tiff", "gif", "jpg", "jpeg", "webp", "heic", "heif", "avif"}
var defaultVideoExts = []string{"mp4", "mov", "mkv", "avi", "webm", "m4v", "mpg", "mpeg", "wmv", "flv"}

type scanFile struct {
	path     string
	kind     string // by name: image | video
	size     int64
	mtimeMs  float64
	dataless bool    // an online-only cloud placeholder (dataless_darwin.go)
	duration float64 // videos: container seconds from the pre-probe (0 = unknown)
}

// cost orders the queue and shares out ffmpeg threads: a video's duration in seconds (bytes stand in when
// ffprobe could not read it: ~1 s per 250 KB), an image's bytes.
func (f scanFile) cost() float64 {
	if f.kind == "video" {
		if f.duration > 0 {
			return f.duration
		}
		return float64(f.size) / 250_000
	}
	return float64(f.size)
}

// probeDurations fills in every video's duration with ffprobe, on `workers` goroutines.
func probeDurations(ctx context.Context, files []scanFile, workers int) {
	_, ffprobe, err := findTools()
	if err != nil || ffprobe == "" {
		return
	}
	idx := make(chan int)
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range idx {
				if ctx.Err() == nil {
					files[i].duration = probe(ffprobe, files[i].path).duration
				}
			}
		}()
	}
	for i := range files {
		if files[i].kind == "video" && !files[i].dataless {
			idx <- i
		}
	}
	close(idx)
	wg.Wait()
}

func scanMain(args []string) int {
	req, err := readScanRequest(args)
	if err != nil {
		fmt.Fprintln(os.Stderr, "lfb-pdq --scan:", err)
		return 2
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	baseCtx = ctx
	out := newEmitter(os.Stdout)
	if err := runScan(ctx, req, out); err != nil {
		out.emit(scanEvent{T: "error", Error: err.Error()})
		out.flush()
		return 1
	}
	out.flush()
	return 0
}

func readScanRequest(args []string) (scanRequest, error) {
	var req scanRequest
	if len(args) == 0 {
		// The backend's form: one JSON object on stdin.
		dec := json.NewDecoder(bufio.NewReaderSize(os.Stdin, 1<<20))
		if err := dec.Decode(&req); err != nil {
			return req, fmt.Errorf("reading the scan request from stdin: %w", err)
		}
		return req, nil
	}
	fs := flag.NewFlagSet("scan", flag.ContinueOnError)
	ext := fs.String("ext", "", "comma-separated extensions to include (default: every image and video extension)")
	workers := fs.Int("workers", 0, "worker goroutines (default: cpu-percent of the cores)")
	cpu := fs.Int("cpu-percent", 80, "share of the cores to use when --workers is not given")
	noRec := fs.Bool("no-recursive", false, "only the directory itself")
	maxFiles := fs.Int("max-files", 0, "stop the walk after this many files")
	deferImages := fs.Bool("defer-images", false, "hash videos only; report images as deferred")
	noHW := fs.Bool("no-hw", false, "never try the VideoToolbox hardware decoder")
	dir := args[0]
	if err := fs.Parse(args[1:]); err != nil {
		return req, err
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return req, err
	}
	req.Dir = abs
	if *ext != "" {
		req.Extensions = strings.Split(*ext, ",")
	}
	req.Workers, req.CPUPercent, req.MaxFiles, req.DeferImages, req.NoHW = *workers, *cpu, *maxFiles, *deferImages, *noHW
	rec := !*noRec
	req.Recursive = &rec
	req.SkipDirs = []string{".git", "node_modules", ".Trash", ".cache", "Caches", ".claude"}
	req.SkipSuffix = []string{".app", ".photoslibrary", ".fcpbundle", ".band", ".imovielibrary", ".bundle", ".framework", ".plugin", ".xcarchive"}
	return req, nil
}

// workerCount: an explicit count wins; otherwise cpu_percent (default 80) of the logical cores, at least 1.
func workerCount(req scanRequest) (workers, cores int) {
	cores = runtime.NumCPU()
	if req.Workers > 0 {
		return min(req.Workers, 256), cores
	}
	pct := req.CPUPercent
	if pct <= 0 || pct > 100 {
		pct = 80
	}
	return max(1, int(math.Floor(float64(cores)*float64(pct)/100))), cores
}

func normExt(e string) string {
	return strings.ToLower(strings.TrimPrefix(strings.TrimSpace(e), "."))
}

func toSet(list []string) map[string]bool {
	m := make(map[string]bool, len(list))
	for _, e := range list {
		if n := normExt(e); n != "" {
			m[n] = true
		}
	}
	return m
}

func runScan(ctx context.Context, req scanRequest, out *emitter) error {
	t0 := time.Now()
	if req.Dir == "" || !filepath.IsAbs(req.Dir) {
		return errors.New("dir must be an absolute path")
	}
	st, err := os.Stat(req.Dir)
	if err != nil {
		return err
	}
	if !st.IsDir() {
		return fmt.Errorf("%s is not a directory", req.Dir)
	}
	workers, cores := workerCount(req)
	out.emit(scanEvent{T: "start", Workers: workers, Cores: cores, Version: version, Path: req.Dir})

	files, unreadable, truncated := walkScan(ctx, req)
	known := make(map[string]scanKnown, len(req.Known))
	for _, k := range req.Known {
		known[k.Path] = k
	}
	var todo []scanFile
	var nImg, nVid, nKnown int
	for _, f := range files {
		if f.kind == "image" {
			nImg++
		} else {
			nVid++
		}
		if k, ok := known[f.path]; ok && k.Size == f.size && math.Abs(k.MtimeMs-f.mtimeMs) < 1 {
			nKnown++
			continue
		}
		if f.dataless && !req.IncludeDataless {
			continue // reported below, never opened
		}
		todo = append(todo, f)
	}
	out.emit(scanEvent{T: "walk", Total: len(files), Images: nImg, Videos: nVid, KnownCount: nKnown,
		UnreadableDirs: unreadable, Truncated: truncated, Ms: msSince(t0)})
	for _, f := range files {
		if k, ok := known[f.path]; ok && k.Size == f.size && math.Abs(k.MtimeMs-f.mtimeMs) < 1 {
			out.emit(scanEvent{T: "known", Path: f.path, Kind: f.kind, Size: f.size, MtimeMs: f.mtimeMs})
		} else if f.dataless && !req.IncludeDataless {
			out.emit(scanEvent{T: "fail", Path: f.path, Kind: f.kind, Size: f.size, MtimeMs: f.mtimeMs, Code: "not_downloaded",
				Error: "online-only cloud file (its bytes are not on this disk); not read, so it was not downloaded"})
		}
	}

	// Longest work first. A video's cost follows its DURATION, not its bytes: measured on the mirror, an
	// 80-minute talk of only 0.38 GB (a full VP9 decode) was the whole tail when ordered by size. So probe
	// every video's duration first (ffprobe, a few ms each, in parallel), then run videos longest first,
	// then images largest first.
	probeDurations(ctx, todo, workers)
	sort.SliceStable(todo, func(i, j int) bool {
		if todo[i].kind != todo[j].kind {
			return todo[i].kind == "video"
		}
		return todo[i].cost() > todo[j].cost()
	})

	threadsFor := videoThreadPlan(req, todo, workers, cores)

	queue := make(chan scanFile)
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for f := range queue {
				out.emit(hashOne(ctx, req, f, threadsFor(f)))
			}
		}()
	}
	cancelled := false
feed:
	for _, f := range todo {
		select {
		case <-ctx.Done():
			cancelled = true
			break feed
		case queue <- f:
		}
	}
	close(queue)
	wg.Wait()
	out.emit(scanEvent{T: "done", Ms: msSince(t0), Cancelled: cancelled || ctx.Err() != nil})
	return nil
}

// videoThreadPlan decides ffmpeg's decoder threads per video, by its share of all the videos' duration.
//
// The floor, ceil(cores/workers) (2 on the 24-core tower), keeps many concurrent ffmpegs near the core
// budget. But a run's wall time is set by its TAIL: measured on the mirror, two 2–3 GB WebM talks with
// sparse keyframes (a full VP9 decode) were still running on 2 threads each minutes after the other 323
// videos had finished, with 20 cores idle. The longest videos start first (the queue is sorted), so give
// each video threads in proportion to its share of all video duration: a file that is 1/8 of the work gets
// ~2×cores/8 threads. Early on that oversubscribes a little (the OS shares fairly); at the tail it is what
// keeps the cores busy. An explicit ff_threads in the request overrides the plan.
func videoThreadPlan(req scanRequest, todo []scanFile, workers, cores int) func(scanFile) int {
	if req.FFThreads > 0 {
		return func(scanFile) int { return req.FFThreads }
	}
	floor := max(2, int(math.Ceil(float64(cores)/float64(workers))))
	var total float64
	for _, f := range todo {
		if f.kind == "video" {
			total += f.cost()
		}
	}
	return func(f scanFile) int {
		if f.kind != "video" || total <= 0 {
			return floor
		}
		share := f.cost() / total
		return min(cores, max(floor, int(math.Ceil(2*float64(cores)*share))))
	}
}

func msSince(t time.Time) float64 {
	return math.Round(float64(time.Since(t).Microseconds())/10) / 100
}

// walkScan lists every file under req.Dir whose extension passes the filters. Never follows a symlink.
func walkScan(ctx context.Context, req scanRequest) (files []scanFile, unreadable int, truncated bool) {
	imgExts, vidExts := toSet(req.ImageExts), toSet(req.VideoExts)
	if len(imgExts) == 0 {
		imgExts = toSet(defaultImageExts)
	}
	if len(vidExts) == 0 {
		vidExts = toSet(defaultVideoExts)
	}
	want := toSet(req.Extensions)
	kinds := map[string]bool{"image": true, "video": true}
	if len(req.Kinds) > 0 {
		kinds = map[string]bool{}
		for _, k := range req.Kinds {
			kinds[strings.ToLower(k)] = true
		}
	}
	skipDirs := map[string]bool{}
	for _, d := range req.SkipDirs {
		skipDirs[d] = true
	}
	skipPaths := map[string]bool{}
	for _, p := range req.SkipPaths {
		skipPaths[filepath.Clean(p)] = true
	}
	skipHidden := req.SkipHidden == nil || *req.SkipHidden
	recursive := req.Recursive == nil || *req.Recursive
	maxFiles := req.MaxFiles
	if maxFiles <= 0 {
		maxFiles = 500_000
	}

	stack := []string{req.Dir}
	for len(stack) > 0 {
		if ctx.Err() != nil {
			return
		}
		dir := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		entries, err := os.ReadDir(dir)
		if err != nil {
			unreadable++
			continue
		}
		// ReadDir sorts by name; push subdirectories in reverse so the walk visits them in name order.
		var subdirs []string
		for _, e := range entries {
			name := e.Name()
			typ := e.Type()
			if typ&os.ModeSymlink != 0 {
				continue
			}
			abs := filepath.Join(dir, name)
			if e.IsDir() {
				if !recursive || skipDirs[name] || (skipHidden && strings.HasPrefix(name, ".")) ||
					hasSuffixFold(name, req.SkipSuffix) || skipPaths[abs] {
					continue
				}
				subdirs = append(subdirs, abs)
				continue
			}
			if !typ.IsRegular() {
				continue
			}
			ext := normExt(filepath.Ext(name))
			kind := ""
			if vidExts[ext] {
				kind = "video"
			} else if imgExts[ext] {
				kind = "image"
			}
			if kind == "" || !kinds[kind] || (len(want) > 0 && !want[ext]) {
				continue
			}
			info, err := e.Info()
			if err != nil {
				continue // vanished between the listing and the stat
			}
			files = append(files, scanFile{path: abs, kind: kind, size: info.Size(), mtimeMs: mtimeMs(info), dataless: isDataless(info)})
			if len(files) >= maxFiles {
				return files, unreadable, true
			}
		}
		for i := len(subdirs) - 1; i >= 0; i-- {
			stack = append(stack, subdirs[i])
		}
	}
	return
}

func hasSuffixFold(name string, suffixes []string) bool {
	l := strings.ToLower(name)
	for _, s := range suffixes {
		if s != "" && strings.HasSuffix(l, strings.ToLower(s)) {
			return true
		}
	}
	return false
}

func mtimeMs(info os.FileInfo) float64 {
	return float64(info.ModTime().UnixNano()) / 1e6
}

// hashOne fingerprints one file and returns its event. It never panics out of a worker.
func hashOne(ctx context.Context, req scanRequest, f scanFile, ffThreads int) (ev scanEvent) {
	start := time.Now()
	ev = scanEvent{Path: f.path, Kind: f.kind, Size: f.size, MtimeMs: f.mtimeMs}
	defer func() {
		if p := recover(); p != nil {
			ev = scanEvent{T: "fail", Path: f.path, Kind: f.kind, Code: "internal", Error: fmt.Sprintf("panic: %v", p)}
		}
		ev.Ms = msSince(start)
	}()
	if ctx.Err() != nil {
		ev.T, ev.Code, ev.Error = "fail", "cancelled", "cancelled"
		return
	}

	// The BYTES decide the pipeline (media-sniff.ts): 28 JPEGs named *.mp4 live in one real repo.
	kind := f.kind
	switch sniffKind(f.path) {
	case "image":
		kind = "image"
	case "heif":
		ev.T, ev.Kind, ev.Why = "defer", "image", "HEIC/AVIF: decoded by the backend's sharp path"
		return
	case "video":
		kind = "video"
	case "audio", "pdf":
		ev.T, ev.Code, ev.Error = "fail", "not_media", "not an image or video file (the file's bytes say otherwise)"
		return
	}
	ev.Kind = kind

	if kind == "image" {
		if req.DeferImages {
			ev.T, ev.Why = "defer", "defer_images requested"
			return
		}
		r, err := hashImageNative(f.path)
		if err != nil {
			var d errDefer
			var tl errTooLarge
			switch {
			case errors.As(err, &d):
				ev.T, ev.Why = "defer", d.why
			case errors.As(err, &tl):
				ev.T, ev.Code, ev.Error = "fail", "too_large", tl.why
			case errors.Is(err, os.ErrNotExist):
				ev.T, ev.Code, ev.Error = "fail", "not_found", "file not found"
			default:
				ev.T, ev.Code, ev.Error = "fail", "decode_failed", err.Error()
			}
			return
		}
		q := r.quality
		ev.T, ev.Hash, ev.HashAlt, ev.Quality, ev.Strategy = "file", r.hash, r.hashAlt, &q, imageStrategy
	} else {
		// A full decode (keyframes too sparse) is the tail of the run, so it gets half the cores. Measured: a
		// 14-minute AV1 talk alone took 28 s at 12 threads, 45 s at 4, 37 s at 24; the whole mirror took 375 s
		// at half the cores and 446 s at all of them (24 threads per full decode only adds contention).
		full := max(ffThreads, runtime.NumCPU()/2)
		vr := hashVideo(request{Video: f.path, Interval: req.Interval, MaxFrames: req.MaxFrames, TimeoutS: req.TimeoutS,
			FFThreads: ffThreads, FullThreads: full, NoHW: req.NoHW})
		if vr.Error != "" {
			ev.T, ev.Code, ev.Error, ev.Tried = "fail", videoErrorCode(vr.Error), vr.Error, vr.Tried
			return
		}
		q := vr.Quality
		ev.T, ev.Frames, ev.Duration, ev.Strategy, ev.Tried, ev.Quality = "file", vr.Frames, vr.Duration, vr.Strategy, vr.Tried, &q
	}

	// The file may have changed WHILE we read it: say so, and the backend refuses to store a torn read.
	stable := false
	if after, err := os.Stat(f.path); err == nil {
		stable = after.Size() == f.size && math.Abs(mtimeMs(after)-f.mtimeMs) < 1
	}
	ev.Stable = &stable
	return
}

func videoErrorCode(msg string) string {
	switch {
	case msg == "cancelled":
		return "cancelled"
	case strings.Contains(msg, "ffmpeg not installed"):
		return "ffmpeg_missing"
	case strings.Contains(msg, "timed out") || strings.Contains(msg, "timeout reached"):
		return "timeout"
	case strings.Contains(msg, "no such file"):
		return "not_found"
	}
	return "decode_failed"
}

// emitter serializes NDJSON lines from many workers onto one stdout.
type emitter struct {
	mu sync.Mutex
	w  *bufio.Writer
}

func newEmitter(w io.Writer) *emitter { return &emitter{w: bufio.NewWriterSize(w, 1<<16)} }

func (e *emitter) emit(ev scanEvent) {
	b, err := json.Marshal(ev)
	if err != nil {
		b, _ = json.Marshal(scanEvent{T: "fail", Path: ev.Path, Code: "internal", Error: "cannot encode result: " + err.Error()})
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.w.Write(b)
	e.w.WriteByte('\n')
	// Flush per line so the backend sees progress live; the cost is one write syscall per FILE.
	if err := e.w.Flush(); err != nil {
		// stdout is gone (the backend died or closed us): nobody will read further results. Exit.
		os.Exit(3)
	}
}

func (e *emitter) flush() {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.w.Flush()
}
