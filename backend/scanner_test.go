package main

import (
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

func writePNG(t *testing.T, path string, w, h int) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{uint8(x), uint8(y), 128, 255})
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

func TestScanAndResize(t *testing.T) {
	root := t.TempDir()
	writePNG(t, filepath.Join(root, "b.png"), 800, 600)
	writePNG(t, filepath.Join(root, "sub", "a.PNG"), 100, 50)
	writePNG(t, filepath.Join(root, ".hidden", "x.png"), 10, 10)
	_ = os.WriteFile(filepath.Join(root, "notes.txt"), []byte("hi"), 0o644)

	photos, err := scanPhotos(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(photos) != 2 || photos[0].RelPath != "b.png" || photos[1].RelPath != "sub/a.PNG" {
		t.Fatalf("unexpected scan result: %+v", photos)
	}
	if photos[0].ID == photos[1].ID {
		t.Fatal("ids should differ")
	}

	thumb := filepath.Join(t.TempDir(), "t.jpg")
	if err := makeThumbnail(photos[0].AbsPath, thumb); err != nil {
		t.Fatal(err)
	}
	f, _ := os.Open(thumb)
	cfg, _, err := image.DecodeConfig(f)
	f.Close()
	if err != nil || cfg.Width != thumbSize || cfg.Height != 240 {
		t.Fatalf("thumb %dx%d err=%v", cfg.Width, cfg.Height, err)
	}

	data, w, h, err := makeDisplayImage(photos[0].AbsPath)
	if err != nil || len(data) == 0 || w != 800 || h != 600 {
		t.Fatalf("display image %dx%d len=%d err=%v", w, h, len(data), err)
	}
}

func TestResolveFolderStaysInRoot(t *testing.T) {
	root := t.TempDir()
	_ = os.MkdirAll(filepath.Join(root, "trip"), 0o755)
	s := NewServer(Config{PhotoRoot: root, DefaultFolder: root}, nil)

	if got, err := s.resolveFolder("trip"); err != nil || got != filepath.Join(root, "trip") {
		t.Fatalf("relative path: %q %v", got, err)
	}
	if got, err := s.resolveFolder(""); err != nil || got != root {
		t.Fatalf("default folder: %q %v", got, err)
	}
	for _, bad := range []string{"/etc", "../", filepath.Join(root, "..", "x"), "missing"} {
		if _, err := s.resolveFolder(bad); err == nil {
			t.Fatalf("expected %q to be rejected", bad)
		}
	}
}
