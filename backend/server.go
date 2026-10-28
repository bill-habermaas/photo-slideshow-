package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	defaultSeconds = 5
	maxSeconds     = 3600
	maxCaptionLen  = 500
)

type Server struct {
	cfg   Config
	store SelectionStore

	mu     sync.RWMutex
	folder string           // folder currently scanned ("" until the first scan)
	photos map[string]Photo // id -> photo, from the most recent scan
	order  []Photo          // the same photos, sorted

	thumbSem chan struct{} // limits concurrent thumbnail generation
	thumbMu  sync.Mutex
	inFlight map[string]*sync.WaitGroup
}

func NewServer(cfg Config, store SelectionStore) *Server {
	return &Server{
		cfg:      cfg,
		store:    store,
		photos:   map[string]Photo{},
		thumbSem: make(chan struct{}, max(2, runtime.NumCPU())),
		inFlight: map[string]*sync.WaitGroup{},
	}
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /api/config", s.handleConfig)
	mux.HandleFunc("GET /api/folders", s.handleFolders)
	mux.HandleFunc("POST /api/scan", s.handleScan)
	mux.HandleFunc("GET /api/photos", s.handleListPhotos)
	mux.HandleFunc("GET /api/photos/{id}/thumb", s.handleThumb)
	mux.HandleFunc("GET /api/photos/{id}/original", s.handleOriginal)
	mux.HandleFunc("GET /api/selections", s.handleListSelections)
	mux.HandleFunc("PUT /api/selections/{id}", s.handlePutSelection)
	mux.HandleFunc("DELETE /api/selections/{id}", s.handleDeleteSelection)
	mux.HandleFunc("DELETE /api/selections", s.handleDeleteAllSelections)
	mux.HandleFunc("GET /api/selections/{id}/image", s.handleSelectionImage)
	return logRequests(mux)
}

// ---- folder & scanning -----------------------------------------------------

// resolveFolder turns user input into a clean absolute path and checks it is
// an existing directory inside PHOTO_ROOT (when one is configured).
func (s *Server) resolveFolder(input string) (string, error) {
	input = strings.TrimSpace(input)
	if input == "" {
		input = s.cfg.DefaultFolder
	}
	if input == "" {
		return "", fmt.Errorf("enter a folder path")
	}
	if !filepath.IsAbs(input) && s.cfg.PhotoRoot != "" {
		input = filepath.Join(s.cfg.PhotoRoot, input)
	}
	abs, err := filepath.Abs(input)
	if err != nil {
		return "", err
	}
	if root := s.cfg.PhotoRoot; root != "" && abs != root && !strings.HasPrefix(abs, root+string(filepath.Separator)) {
		return "", fmt.Errorf("%s is outside the photo root %s", abs, root)
	}
	st, err := os.Stat(abs)
	if err != nil {
		return "", fmt.Errorf("folder %s not found", abs)
	}
	if !st.IsDir() {
		return "", fmt.Errorf("%s is not a folder", abs)
	}
	return abs, nil
}

// restoreFolder rescans the folder from the previous session, if still valid.
func (s *Server) restoreFolder(ctx context.Context) {
	// If the photo folder mounted from the computer has changed (PHOTOS_DIR
	// was edited), the stored selections and folder belong to the old one:
	// clear them so the old photos don't keep playing.
	if prev, err := s.store.MountedRoot(ctx); err == nil && prev != s.cfg.HostRoot {
		if prev != "" {
			log.Printf("photo folder changed from %s to %s: clearing old selections", prev, s.cfg.HostRoot)
			if err := s.store.ClearAll(ctx); err != nil {
				log.Printf("clear database: %v", err)
				return
			}
		}
		if err := s.store.SetMountedRoot(ctx, s.cfg.HostRoot); err != nil {
			log.Printf("save mounted folder: %v", err)
		}
	}
	folder, err := s.store.LastFolder(ctx)
	if err != nil || folder == "" {
		return
	}
	if folder, err = s.resolveFolder(folder); err != nil {
		return
	}
	if _, err := s.scan(folder); err == nil {
		log.Printf("restored folder %s", folder)
	}
}

func (s *Server) scan(folder string) ([]Photo, error) {
	list, err := scanPhotos(folder)
	if err != nil {
		return nil, err
	}
	m := make(map[string]Photo, len(list))
	for _, p := range list {
		m[p.ID] = p
	}
	s.mu.Lock()
	s.folder, s.photos, s.order = folder, m, list
	s.mu.Unlock()
	return list, nil
}

func (s *Server) current() (string, []Photo) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.folder, s.order
}

func (s *Server) lookup(id string) (Photo, bool) {
	s.mu.RLock()
	p, ok := s.photos[id]
	folder := s.folder
	s.mu.RUnlock()
	if ok || folder == "" {
		return p, ok
	}
	// The id may belong to a file added since the last scan.
	if _, err := s.scan(folder); err != nil {
		return Photo{}, false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	p, ok = s.photos[id]
	return p, ok
}

func (s *Server) handleConfig(w http.ResponseWriter, r *http.Request) {
	folder, _ := s.current()
	writeJSON(w, http.StatusOK, map[string]string{
		"root": s.cfg.PhotoRoot, "hostRoot": s.cfg.HostRoot, "defaultFolder": s.cfg.DefaultFolder, "folder": folder,
	})
}

// handleFolders lists the sub-folders of ?path= to help pick a folder.
func (s *Server) handleFolders(w http.ResponseWriter, r *http.Request) {
	dir, err := s.resolveFolder(r.URL.Query().Get("path"))
	if err != nil {
		httpError(w, http.StatusBadRequest, "%v", err)
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		httpError(w, http.StatusBadRequest, "read %s: %v", dir, err)
		return
	}
	folders := []string{}
	images := 0 // photos directly in this folder (sub-folders are scanned too)
	for _, e := range entries {
		switch {
		case strings.HasPrefix(e.Name(), "."):
		case e.IsDir():
			folders = append(folders, e.Name())
		case imageExts[strings.ToLower(filepath.Ext(e.Name()))]:
			images++
		}
	}
	parent := ""
	if p := filepath.Dir(dir); p != dir {
		if _, err := s.resolveFolder(p); err == nil {
			parent = p
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"path": dir, "parent": parent, "folders": folders, "images": images})
}

func (s *Server) handleScan(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Folder string `json:"folder"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&in); err != nil {
		httpError(w, http.StatusBadRequest, "invalid JSON body: %v", err)
		return
	}
	folder, err := s.resolveFolder(in.Folder)
	if err != nil {
		httpError(w, http.StatusBadRequest, "%v", err)
		return
	}
	if _, err := s.scan(folder); err != nil {
		httpError(w, http.StatusInternalServerError, "scan %s: %v", folder, err)
		return
	}
	// A new scan starts from scratch: clear every document in MongoDB
	// (selections with their cached images, and settings), then remember
	// the folder that was just scanned.
	if err := s.store.ClearAll(r.Context()); err != nil {
		httpError(w, http.StatusInternalServerError, "clear database: %v", err)
		return
	}
	if err := s.store.SetLastFolder(r.Context(), folder); err != nil {
		log.Printf("save last folder: %v", err)
	}
	if err := s.store.SetMountedRoot(r.Context(), s.cfg.HostRoot); err != nil {
		log.Printf("save mounted folder: %v", err)
	}
	s.writePhotoList(w, r)
}

// ---- photos (from the scanned folder) --------------------------------------

type photoDTO struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Path      string `json:"path"`
	Selected  bool   `json:"selected"`
	Seconds   int    `json:"seconds"`
	Caption   string `json:"caption"`
	Elsewhere bool   `json:"elsewhere,omitempty"` // selected, but no longer found in the scanned folder
}

func (s *Server) handleListPhotos(w http.ResponseWriter, r *http.Request) {
	s.writePhotoList(w, r)
}

func (s *Server) writePhotoList(w http.ResponseWriter, r *http.Request) {
	folder, list := s.current()
	sels, err := s.store.List(r.Context())
	if err != nil {
		httpError(w, http.StatusInternalServerError, "read selections: %v", err)
		return
	}
	byID := make(map[string]Selection, len(sels))
	for _, sel := range sels {
		byID[sel.ID] = sel
	}

	out := make([]photoDTO, 0, len(list))
	for _, p := range list {
		dto := photoDTO{ID: p.ID, Name: p.Name, Path: p.RelPath, Seconds: defaultSeconds}
		if sel, ok := byID[p.ID]; ok {
			dto.Selected, dto.Seconds, dto.Caption = true, sel.Seconds, sel.Caption
			delete(byID, p.ID)
		}
		out = append(out, dto)
	}
	// Selections whose file has since been deleted or moved still play from
	// the MongoDB cache; list them so they can be edited or unselected.
	for _, sel := range sels {
		if _, left := byID[sel.ID]; left {
			out = append(out, photoDTO{ID: sel.ID, Name: sel.Name, Path: sel.Path,
				Selected: true, Seconds: sel.Seconds, Caption: sel.Caption, Elsewhere: true})
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"folder": folder, "photos": out})
}

func (s *Server) handleThumb(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	p, ok := s.lookup(id)
	if !ok {
		// Not on disk any more; fall back to the copy cached in MongoDB.
		s.serveCachedImage(w, r, id)
		return
	}
	dst := filepath.Join(s.cfg.ThumbCacheDir, fmt.Sprintf("%s-%d.jpg", p.ID, p.ModTime.Unix()))
	if _, err := os.Stat(dst); err != nil {
		if err := s.generateThumb(p.AbsPath, dst); err != nil {
			httpError(w, http.StatusUnprocessableEntity, "thumbnail for %s: %v", p.RelPath, err)
			return
		}
	}
	w.Header().Set("Cache-Control", "public, max-age=86400")
	http.ServeFile(w, r, dst)
}

// generateThumb builds one thumbnail, deduplicating concurrent requests for
// the same file and capping parallel work at the number of CPUs.
func (s *Server) generateThumb(src, dst string) error {
	s.thumbMu.Lock()
	if wg, ok := s.inFlight[dst]; ok {
		s.thumbMu.Unlock()
		wg.Wait()
		if _, err := os.Stat(dst); err != nil {
			return fmt.Errorf("thumbnail generation failed")
		}
		return nil
	}
	wg := &sync.WaitGroup{}
	wg.Add(1)
	s.inFlight[dst] = wg
	s.thumbMu.Unlock()

	defer func() {
		s.thumbMu.Lock()
		delete(s.inFlight, dst)
		s.thumbMu.Unlock()
		wg.Done()
	}()

	s.thumbSem <- struct{}{}
	defer func() { <-s.thumbSem }()
	return makeThumbnail(src, dst)
}

func (s *Server) handleOriginal(w http.ResponseWriter, r *http.Request) {
	p, ok := s.lookup(r.PathValue("id"))
	if !ok {
		http.NotFound(w, r)
		return
	}
	http.ServeFile(w, r, p.AbsPath) // path comes from our own scan, never from the request
}

// ---- selections (MongoDB) --------------------------------------------------

type selectionDTO struct {
	Selection
	ImageURL string `json:"imageUrl"`
}

func (s *Server) handleListSelections(w http.ResponseWriter, r *http.Request) {
	sels, err := s.store.List(r.Context())
	if err != nil {
		httpError(w, http.StatusInternalServerError, "read selections: %v", err)
		return
	}
	out := make([]selectionDTO, len(sels))
	for i, sel := range sels {
		out[i] = selectionDTO{Selection: sel,
			ImageURL: fmt.Sprintf("/api/selections/%s/image?v=%d", sel.ID, sel.CreatedAt.Unix())}
	}
	writeJSON(w, http.StatusOK, out)
}

type selectionInput struct {
	// Seconds the photo stays on screen in display mode. 0 means "stay until
	// Next is pressed"; omitted means defaultSeconds.
	Seconds *int   `json:"seconds"`
	Caption string `json:"caption"`
}

// normalize fills in the default and clamps seconds to 0..maxSeconds, and
// trims the caption. It returns the seconds to store.
func (in *selectionInput) normalize() int {
	seconds := defaultSeconds
	if in.Seconds != nil {
		seconds = min(max(*in.Seconds, 0), maxSeconds)
	}
	in.Seconds = &seconds
	in.Caption = strings.TrimSpace(in.Caption)
	if utf8.RuneCountInString(in.Caption) > maxCaptionLen {
		in.Caption = string([]rune(in.Caption)[:maxCaptionLen])
	}
	return seconds
}

// handlePutSelection selects a photo (caching its image in MongoDB) or, if it
// is already selected, updates its seconds and caption.
func (s *Server) handlePutSelection(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var in selectionInput
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&in); err != nil {
		httpError(w, http.StatusBadRequest, "invalid JSON body: %v", err)
		return
	}
	seconds := in.normalize()
	ctx := r.Context()

	exists, err := s.store.Exists(ctx, id)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "%v", err)
		return
	}
	if exists {
		if err := s.store.UpdateOptions(ctx, id, seconds, in.Caption); err != nil {
			httpError(w, http.StatusInternalServerError, "update selection: %v", err)
			return
		}
	} else {
		p, ok := s.lookup(id)
		if !ok {
			httpError(w, http.StatusNotFound, "photo %s not found in folder", id)
			return
		}
		data, width, height, err := makeDisplayImage(p.AbsPath)
		if err != nil {
			httpError(w, http.StatusUnprocessableEntity, "read %s: %v", p.RelPath, err)
			return
		}
		now := time.Now().UTC()
		sel := Selection{ID: id, Name: p.Name, Path: p.AbsPath, Seconds: seconds, Caption: in.Caption,
			Width: width, Height: height, ContentType: "image/jpeg", Image: data, CreatedAt: now, UpdatedAt: now}
		if err := s.store.Insert(ctx, sel); err != nil {
			httpError(w, http.StatusInternalServerError, "save selection: %v", err)
			return
		}
	}
	sel, err := s.store.Get(ctx, id)
	if err != nil || sel == nil {
		httpError(w, http.StatusInternalServerError, "reload selection: %v", err)
		return
	}
	writeJSON(w, http.StatusOK, sel)
}

func (s *Server) handleDeleteSelection(w http.ResponseWriter, r *http.Request) {
	if err := s.store.Delete(r.Context(), r.PathValue("id")); err != nil {
		httpError(w, http.StatusInternalServerError, "delete selection: %v", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleDeleteAllSelections turns every selection off.
func (s *Server) handleDeleteAllSelections(w http.ResponseWriter, r *http.Request) {
	n, err := s.store.DeleteAllSelections(r.Context())
	if err != nil {
		httpError(w, http.StatusInternalServerError, "clear selections: %v", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int64{"deleted": n})
}

func (s *Server) handleSelectionImage(w http.ResponseWriter, r *http.Request) {
	s.serveCachedImage(w, r, r.PathValue("id"))
}

func (s *Server) serveCachedImage(w http.ResponseWriter, r *http.Request, id string) {
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	sel, err := s.store.Image(ctx, id)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "%v", err)
		return
	}
	if sel == nil || len(sel.Image) == 0 {
		http.NotFound(w, r)
		return
	}
	etag := fmt.Sprintf(`"%s-%d"`, sel.ID, sel.CreatedAt.UnixNano())
	w.Header().Set("ETag", etag)
	w.Header().Set("Cache-Control", "private, max-age=3600")
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Type", sel.ContentType)
	w.Header().Set("Content-Length", fmt.Sprint(len(sel.Image)))
	_, _ = w.Write(sel.Image)
}

// ---- helpers ---------------------------------------------------------------

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func httpError(w http.ResponseWriter, status int, format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	if status >= 500 {
		log.Printf("error: %s", msg)
	}
	writeJSON(w, status, map[string]string{"error": msg})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		if strings.HasPrefix(r.URL.Path, "/api/") && !strings.HasSuffix(r.URL.Path, "/thumb") {
			log.Printf("%s %s %d %s", r.Method, r.URL.Path, rec.status, time.Since(start).Round(time.Millisecond))
		}
	})
}
