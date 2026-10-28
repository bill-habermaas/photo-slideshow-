package main

import (
	"crypto/sha1"
	"encoding/hex"
	"io/fs"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Photo is an image file found under the photo folder.
type Photo struct {
	ID      string    // stable id derived from the absolute path
	Name    string    // file name
	RelPath string    // path relative to the scanned folder, forward slashes
	AbsPath string    // absolute path on disk
	ModTime time.Time // used to invalidate cached thumbnails
}

var imageExts = map[string]bool{
	".jpg": true, ".jpeg": true, ".png": true, ".gif": true,
	".webp": true, ".bmp": true, ".tif": true, ".tiff": true,
}

func photoID(relPath string) string {
	sum := sha1.Sum([]byte(relPath))
	return hex.EncodeToString(sum[:])[:16]
}

// scanPhotos walks root recursively and returns every supported image,
// sorted by relative path. Hidden files and folders are skipped.
func scanPhotos(root string) ([]Photo, error) {
	var photos []Photo
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // unreadable entry: skip it, keep scanning
		}
		name := d.Name()
		if path != root && strings.HasPrefix(name, ".") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() || !imageExts[strings.ToLower(filepath.Ext(name))] {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		photos = append(photos, Photo{
			ID:      photoID(filepath.ToSlash(path)),
			Name:    name,
			RelPath: rel,
			AbsPath: path,
			ModTime: info.ModTime(),
		})
		return nil
	})
	sort.Slice(photos, func(i, j int) bool {
		return strings.ToLower(photos[i].RelPath) < strings.ToLower(photos[j].RelPath)
	})
	return photos, err
}
