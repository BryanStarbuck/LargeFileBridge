package main

import (
	"context"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

func writePNG(t *testing.T, path string, w, h int, fn func(x, y int) color.NRGBA) {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.SetNRGBA(x, y, fn(x, y))
		}
	}
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := png.Encode(f, img); err != nil {
		t.Fatal(err)
	}
}

func scene(x, y int) color.NRGBA {
	return color.NRGBA{uint8(x*3 + y), uint8(y * 2), uint8((x ^ y) * 5), 255}
}

func init() {
	var err error
	if hasher, err = newHasherForTest(); err != nil {
		panic(err)
	}
}

// The walk keeps only the requested extensions, skips hidden/skip-listed/bundle directories and symlinks,
// and never descends when recursive is false.
func TestWalkFilters(t *testing.T) {
	root := t.TempDir()
	mk := func(rel string) string {
		p := filepath.Join(root, rel)
		os.MkdirAll(filepath.Dir(p), 0o755)
		os.WriteFile(p, []byte("x"), 0o644)
		return p
	}
	mk("a.jpg")
	mk("b.PNG")
	mk("c.mp4")
	mk("notes.txt")
	mk("sub/d.jpeg")
	mk(".hidden/e.jpg")
	mk("node_modules/f.jpg")
	mk("site/build/g.jpg")
	mk("Thing.app/h.png")
	os.Symlink(filepath.Join(root, "sub"), filepath.Join(root, "link"))

	req := scanRequest{Dir: root, SkipDirs: []string{"node_modules"}, SkipSuffix: []string{".app"},
		SkipPaths: []string{filepath.Join(root, "site/build")}}
	files, _, _ := walkScan(context.Background(), req)
	got := map[string]string{}
	for _, f := range files {
		rel, _ := filepath.Rel(root, f.path)
		got[rel] = f.kind
	}
	want := map[string]string{"a.jpg": "image", "b.PNG": "image", "c.mp4": "video", "sub/d.jpeg": "image"}
	if len(got) != len(want) {
		t.Fatalf("walk found %v, want %v", got, want)
	}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("walk found %v, want %v", got, want)
		}
	}

	req.Extensions = []string{".JPG", "jpeg"}
	files, _, _ = walkScan(context.Background(), req)
	if len(files) != 2 {
		t.Fatalf("extension filter kept %d files, want 2 (a.jpg, sub/d.jpeg)", len(files))
	}

	no := false
	req.Extensions, req.Recursive = nil, &no
	files, _, _ = walkScan(context.Background(), req)
	if len(files) != 3 {
		t.Fatalf("non-recursive walk kept %d files, want 3", len(files))
	}
}

// A JPEG re-encode of a PNG hashes within a few bits natively, and a different picture does not.
func TestNativeImageHash(t *testing.T) {
	dir := t.TempDir()
	orig := filepath.Join(dir, "orig.png")
	writePNG(t, orig, 400, 300, scene)
	other := filepath.Join(dir, "other.png")
	writePNG(t, other, 400, 300, func(x, y int) color.NRGBA { return color.NRGBA{uint8(x * y), uint8(255 - x), uint8(y * 7), 255} })

	src, _ := os.Open(orig)
	img, _ := png.Decode(src)
	src.Close()
	jf, _ := os.Create(filepath.Join(dir, "copy.jpg"))
	jpeg.Encode(jf, img, &jpeg.Options{Quality: 30})
	jf.Close()

	a, err := hashImageNative(orig)
	if err != nil {
		t.Fatal(err)
	}
	b, err := hashImageNative(filepath.Join(dir, "copy.jpg"))
	if err != nil {
		t.Fatal(err)
	}
	c, err := hashImageNative(other)
	if err != nil {
		t.Fatal(err)
	}
	if d := hamming(a.hash, b.hash); d > 24 {
		t.Fatalf("PNG vs its JPEG copy: %d bits apart, want ≤ 24", d)
	}
	if d := hamming(a.hash, c.hash); d <= 32 {
		t.Fatalf("different pictures only %d bits apart", d)
	}
	if a.hashAlt != "" {
		t.Fatalf("an opaque image must not get a black-background hash")
	}
}

// A mostly see-through PNG gets the second (black-background) hash.
func TestNativeAlphaAlt(t *testing.T) {
	p := filepath.Join(t.TempDir(), "window.png")
	writePNG(t, p, 200, 200, func(x, y int) color.NRGBA {
		c := scene(x, y)
		if x < 30 || x > 170 || y < 30 || y > 170 {
			c.A = 60
		}
		return c
	})
	r, err := hashImageNative(p)
	if err != nil {
		t.Fatal(err)
	}
	if r.hashAlt == "" {
		t.Fatalf("transparent image got no value_alt")
	}
}

// HEIC/AVIF are deferred to the backend (sharp), never failed.
func TestSniffDefersHeif(t *testing.T) {
	p := filepath.Join(t.TempDir(), "x.heic")
	os.WriteFile(p, append([]byte{0, 0, 0, 24}, []byte("ftypheic\x00\x00\x00\x00")...), 0o644)
	ev := hashOne(context.Background(), scanRequest{}, scanFile{path: p, kind: "image"}, 2)
	if ev.T != "defer" {
		t.Fatalf("HEIC event = %q, want defer", ev.T)
	}
}

// A JPEG named .mp4 is fingerprinted as an image (the bytes decide), and garbage named .jpg is deferred.
func TestBytesDecideKind(t *testing.T) {
	dir := t.TempDir()
	orig := filepath.Join(dir, "orig.png")
	writePNG(t, orig, 120, 90, scene)
	src, _ := os.Open(orig)
	img, _ := png.Decode(src)
	src.Close()
	fake := filepath.Join(dir, "clip.mp4")
	f, _ := os.Create(fake)
	jpeg.Encode(f, img, nil)
	f.Close()
	st, _ := os.Stat(fake)
	ev := hashOne(context.Background(), scanRequest{}, scanFile{path: fake, kind: "video", size: st.Size(), mtimeMs: mtimeMs(st)}, 2)
	if ev.T != "file" || ev.Kind != "image" || ev.Hash == "" || ev.Stable == nil || !*ev.Stable {
		t.Fatalf("JPEG named .mp4: %+v", ev)
	}
	junk := filepath.Join(dir, "junk.jpg")
	os.WriteFile(junk, []byte("this is not an image at all"), 0o644)
	if ev := hashOne(context.Background(), scanRequest{}, scanFile{path: junk, kind: "image"}, 2); ev.T != "defer" {
		t.Fatalf("undecodable image event = %q, want defer (the sharp path gets a try)", ev.T)
	}
}

func TestOrientationRotatesSquare(t *testing.T) {
	n := 4
	src := make([]float32, n*n*4)
	src[0] = 255                       // stored top-left marked
	out := applyOrientation(src, n, 6) // rotate 90° CW: stored top-left → displayed top-right
	if out[(0*n+(n-1))*4] != 255 {
		t.Fatalf("orientation 6 did not move top-left to top-right")
	}
}

func TestWorkerCount(t *testing.T) {
	w, cores := workerCount(scanRequest{})
	if want := max(1, cores*80/100); w != want {
		t.Fatalf("default workers %d, want 80%% of %d = %d", w, cores, want)
	}
	if w, _ := workerCount(scanRequest{Workers: 3}); w != 3 {
		t.Fatalf("explicit workers ignored: %d", w)
	}
}

func hamming(a, b string) int {
	d := 0
	for i := 0; i < len(a) && i < len(b); i++ {
		x := hexVal(a[i]) ^ hexVal(b[i])
		for ; x != 0; x &= x - 1 {
			d++
		}
	}
	return d
}

func hexVal(c byte) byte {
	switch {
	case c >= '0' && c <= '9':
		return c - '0'
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10
	}
	return 0
}

func newHasherForTest() (imghashPDQ, error) { return newPDQ() }
