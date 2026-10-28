// Command photo-slideshow-api scans a folder for photos, serves thumbnails,
// and stores the photos selected for the slideshow (with their display
// duration, caption, and a cached display-sized copy of the image) in MongoDB.
package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

type Config struct {
	PhotoRoot     string // scans are restricted to this folder ("" = anywhere)
	HostRoot      string // where PhotoRoot lives on the user's computer (for display)
	DefaultFolder string // folder pre-filled on the scan screen
	MongoURI      string
	MongoDB       string
	Addr          string
	ThumbCacheDir string
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func loadConfig() Config {
	var cfg Config
	// PHOTO_ROOT is set inside the Docker container (/photos). When running
	// locally (e.g. the VS Code debugger), PHOTOS_DIR from .env is used, the
	// same variable docker compose mounts, with the same ./photos default.
	flag.StringVar(&cfg.PhotoRoot, "root", envOr("PHOTO_ROOT", envOr("PHOTOS_DIR", "./photos")), "only allow scanning inside this folder (env PHOTO_ROOT, else PHOTOS_DIR, else ./photos)")
	flag.StringVar(&cfg.HostRoot, "host-root", os.Getenv("PHOTOS_HOST_DIR"), "the photo root's path on the host, shown in the UI (env PHOTOS_HOST_DIR)")
	flag.StringVar(&cfg.DefaultFolder, "default-folder", envOr("DEFAULT_FOLDER", ""), "folder suggested on the scan screen (env DEFAULT_FOLDER)")
	flag.StringVar(&cfg.MongoURI, "mongo", envOr("MONGO_URI", "mongodb://localhost:27017"), "MongoDB connection URI (env MONGO_URI)")
	flag.StringVar(&cfg.MongoDB, "db", envOr("MONGO_DB", "photo_slideshow"), "MongoDB database name (env MONGO_DB)")
	flag.StringVar(&cfg.Addr, "addr", envOr("ADDR", ":8080"), "HTTP listen address (env ADDR)")
	flag.StringVar(&cfg.ThumbCacheDir, "thumbs", envOr("THUMB_CACHE_DIR", ""), "thumbnail cache folder (env THUMB_CACHE_DIR; default: user cache dir)")
	flag.Parse()

	if cfg.PhotoRoot != "" {
		cfg.PhotoRoot = expandHome(cfg.PhotoRoot)
		if abs, err := filepath.Abs(cfg.PhotoRoot); err == nil {
			cfg.PhotoRoot = abs
		}
	}
	if cfg.HostRoot == "" {
		cfg.HostRoot = cfg.PhotoRoot // running locally: same path
	}
	if cfg.DefaultFolder == "" {
		cfg.DefaultFolder = cfg.PhotoRoot
	}
	if cfg.ThumbCacheDir == "" {
		base, err := os.UserCacheDir()
		if err != nil {
			base = os.TempDir()
		}
		cfg.ThumbCacheDir = filepath.Join(base, "photo-slideshow", "thumbs")
	}
	return cfg
}

func main() {
	cfg := loadConfig()
	if err := os.MkdirAll(cfg.ThumbCacheDir, 0o755); err != nil {
		log.Fatalf("create thumbnail cache %q: %v", cfg.ThumbCacheDir, err)
	}

	// MongoDB may still be starting when this container comes up; retry for a while.
	var store *Store
	var err error
	for attempt := 1; attempt <= 30; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		store, err = NewStore(ctx, cfg.MongoURI, cfg.MongoDB)
		cancel()
		if err == nil {
			break
		}
		log.Printf("waiting for MongoDB at %s (%d/30): %v", cfg.MongoURI, attempt, err)
		time.Sleep(2 * time.Second)
	}
	if err != nil {
		log.Fatalf("connect to MongoDB at %s: %v", cfg.MongoURI, err)
	}
	defer store.Close(context.Background())

	app := NewServer(cfg, store)
	app.restoreFolder(context.Background())

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           app.Routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("photo root:   %s", orAnywhere(cfg.PhotoRoot))
		if cfg.HostRoot != cfg.PhotoRoot {
			log.Printf("  on host:    %s", cfg.HostRoot)
		}
		logRootContents(cfg.PhotoRoot)
		log.Printf("MongoDB:      %s / %s", cfg.MongoURI, cfg.MongoDB)
		log.Printf("listening on  %s", cfg.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	shutdownCtx, done := context.WithTimeout(context.Background(), 5*time.Second)
	defer done()
	_ = srv.Shutdown(shutdownCtx)
}

func orAnywhere(s string) string {
	if s == "" {
		return "(unrestricted)"
	}
	return s
}

// expandHome turns a leading ~ into the user's home folder.
func expandHome(p string) string {
	if p == "~" || strings.HasPrefix(p, "~/") || strings.HasPrefix(p, `~\`) {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, p[1:])
		}
	}
	return p
}

// logRootContents prints what the photo root contains, so a mount that went
// to the wrong place (or is empty) is obvious from `docker compose logs api`.
func logRootContents(root string) {
	if root == "" {
		return
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		log.Printf("WARNING: cannot read photo root %s: %v", root, err)
		return
	}
	if len(entries) == 0 {
		log.Printf("WARNING: photo root %s is empty. Is PHOTOS_DIR set to the right folder, and is it shared with Docker?", root)
		return
	}
	names := make([]string, 0, 8)
	for _, e := range entries {
		if len(names) == 8 {
			names = append(names, "...")
			break
		}
		names = append(names, e.Name())
	}
	log.Printf("  contains:   %s", strings.Join(names, ", "))
}
