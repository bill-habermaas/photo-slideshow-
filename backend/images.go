package main

import (
	"bytes"
	"fmt"
	"image"
	"os"
	"path/filepath"

	"github.com/disintegration/imaging"
	_ "golang.org/x/image/webp" // register WebP decoder
)

const (
	thumbSize      = 320  // longest side of list thumbnails
	displayMaxSide = 2560 // longest side of the copy cached in MongoDB
)

// openOriented decodes an image and applies its EXIF orientation,
// so phone photos aren't shown sideways.
func openOriented(path string) (image.Image, error) {
	return imaging.Open(path, imaging.AutoOrientation(true))
}

// makeThumbnail writes a JPEG thumbnail of src to dst (atomically).
func makeThumbnail(src, dst string) error {
	img, err := openOriented(src)
	if err != nil {
		return err
	}
	thumb := imaging.Fit(img, thumbSize, thumbSize, imaging.Lanczos)
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(dst), "thumb-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // no-op after a successful rename
	if err := imaging.Encode(tmp, thumb, imaging.JPEG, imaging.JPEGQuality(82)); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), dst)
}

// makeDisplayImage returns a display-sized JPEG of src for caching in MongoDB.
func makeDisplayImage(src string) (data []byte, w, h int, err error) {
	img, err := openOriented(src)
	if err != nil {
		return nil, 0, 0, err
	}
	b := img.Bounds()
	if b.Dx() > displayMaxSide || b.Dy() > displayMaxSide {
		img = imaging.Fit(img, displayMaxSide, displayMaxSide, imaging.Lanczos)
	}
	// MongoDB documents max out at 16 MB; step quality down if ever needed.
	for _, q := range []int{88, 75, 60} {
		var buf bytes.Buffer
		if err := imaging.Encode(&buf, img, imaging.JPEG, imaging.JPEGQuality(q)); err != nil {
			return nil, 0, 0, err
		}
		if buf.Len() < 15<<20 {
			return buf.Bytes(), img.Bounds().Dx(), img.Bounds().Dy(), nil
		}
	}
	return nil, 0, 0, fmt.Errorf("image too large to cache")
}
