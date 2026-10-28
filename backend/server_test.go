package main

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	_ "image/jpeg"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"testing"
	"time"
)

// ---- in-memory SelectionStore ----------------------------------------------

type fakeStore struct {
	mu      sync.Mutex
	sels    map[string]Selection
	folder  string
	mounted string
}

func newFakeStore() *fakeStore { return &fakeStore{sels: map[string]Selection{}} }

func (f *fakeStore) List(ctx context.Context) ([]Selection, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := []Selection{}
	for _, s := range f.sels {
		s.Image = nil // List never returns image bytes
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out, nil
}

func (f *fakeStore) Exists(ctx context.Context, id string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	_, ok := f.sels[id]
	return ok, nil
}

func (f *fakeStore) Insert(ctx context.Context, sel Selection) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sels[sel.ID] = sel
	return nil
}

func (f *fakeStore) UpdateOptions(ctx context.Context, id string, seconds int, caption string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	s := f.sels[id]
	s.Seconds, s.Caption, s.UpdatedAt = seconds, caption, time.Now()
	f.sels[id] = s
	return nil
}

func (f *fakeStore) Get(ctx context.Context, id string) (*Selection, error) {
	s, err := f.Image(ctx, id)
	if s != nil {
		s.Image = nil
	}
	return s, err
}

func (f *fakeStore) Image(ctx context.Context, id string) (*Selection, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	s, ok := f.sels[id]
	if !ok {
		return nil, nil
	}
	return &s, nil
}

func (f *fakeStore) Delete(ctx context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.sels, id)
	return nil
}

func (f *fakeStore) DeleteAllSelections(ctx context.Context) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := int64(len(f.sels))
	f.sels = map[string]Selection{}
	return n, nil
}

func (f *fakeStore) ClearAll(ctx context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sels = map[string]Selection{}
	f.folder = ""
	f.mounted = ""
	return nil
}

func (f *fakeStore) MountedRoot(ctx context.Context) (string, error) { return f.mounted, nil }
func (f *fakeStore) SetMountedRoot(ctx context.Context, root string) error {
	f.mounted = root
	return nil
}

func (f *fakeStore) LastFolder(ctx context.Context) (string, error) { return f.folder, nil }
func (f *fakeStore) SetLastFolder(ctx context.Context, folder string) error {
	f.folder = folder
	return nil
}

// ---- helpers ---------------------------------------------------------------

type harness struct {
	t     *testing.T
	root  string
	store *fakeStore
	srv   *Server
	h     http.Handler
}

// newHarness builds a photo root with:
//
//	trip/beach.png (640x480), trip/sub/hill.png (400x800), other/cat.png (50x50)
func newHarness(t *testing.T) *harness {
	t.Helper()
	root := t.TempDir()
	writePNG(t, filepath.Join(root, "trip", "beach.png"), 640, 480)
	writePNG(t, filepath.Join(root, "trip", "sub", "hill.png"), 400, 800)
	writePNG(t, filepath.Join(root, "other", "cat.png"), 50, 50)
	store := newFakeStore()
	srv := NewServer(Config{PhotoRoot: root, HostRoot: "/Users/me/Pictures", DefaultFolder: root, ThumbCacheDir: t.TempDir()}, store)
	return &harness{t: t, root: root, store: store, srv: srv, h: srv.Routes()}
}

func (h *harness) do(method, path string, body any) *httptest.ResponseRecorder {
	h.t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			h.t.Fatal(err)
		}
	}
	req := httptest.NewRequest(method, path, &buf)
	rec := httptest.NewRecorder()
	h.h.ServeHTTP(rec, req)
	return rec
}

type listResp struct {
	Folder string     `json:"folder"`
	Photos []photoDTO `json:"photos"`
}

func (h *harness) scan(folder string) listResp {
	h.t.Helper()
	rec := h.do("POST", "/api/scan", map[string]string{"folder": folder})
	if rec.Code != http.StatusOK {
		h.t.Fatalf("scan %q: %d %s", folder, rec.Code, rec.Body)
	}
	var out listResp
	decode(h.t, rec, &out)
	return out
}

func decode(t *testing.T, rec *httptest.ResponseRecorder, v any) {
	t.Helper()
	if err := json.Unmarshal(rec.Body.Bytes(), v); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
}

func findPhoto(t *testing.T, photos []photoDTO, name string) photoDTO {
	t.Helper()
	for _, p := range photos {
		if p.Name == name {
			return p
		}
	}
	t.Fatalf("photo %s not in %+v", name, photos)
	return photoDTO{}
}

// ---- tests -----------------------------------------------------------------

func TestConfigBeforeScan(t *testing.T) {
	h := newHarness(t)
	var cfg map[string]string
	decode(t, h.do("GET", "/api/config", nil), &cfg)
	if cfg["root"] != h.root || cfg["defaultFolder"] != h.root || cfg["folder"] != "" {
		t.Fatalf("config = %v", cfg)
	}
	var list listResp
	decode(t, h.do("GET", "/api/photos", nil), &list)
	if list.Folder != "" || len(list.Photos) != 0 {
		t.Fatalf("expected empty list before first scan, got %+v", list)
	}
}

func TestScanBuildsListAndRemembersFolder(t *testing.T) {
	h := newHarness(t)
	list := h.scan("trip")
	if list.Folder != filepath.Join(h.root, "trip") {
		t.Fatalf("folder = %s", list.Folder)
	}
	if len(list.Photos) != 2 || list.Photos[0].Path != "beach.png" || list.Photos[1].Path != "sub/hill.png" {
		t.Fatalf("photos = %+v", list.Photos)
	}
	for _, p := range list.Photos {
		if p.Selected || p.Seconds != defaultSeconds || p.Caption != "" {
			t.Fatalf("new photo should be unselected with defaults: %+v", p)
		}
	}
	if h.store.folder != list.Folder {
		t.Fatalf("last folder not saved: %q", h.store.folder)
	}

	// A fresh server restores the folder from the store.
	srv2 := NewServer(h.srv.cfg, h.store)
	srv2.restoreFolder(context.Background())
	if folder, photos := srv2.current(); folder != list.Folder || len(photos) != 2 {
		t.Fatalf("restore: %s %d", folder, len(photos))
	}
}

func TestScanRejectsBadFolders(t *testing.T) {
	h := newHarness(t)
	for _, folder := range []string{"/etc", "../..", "does-not-exist", "trip/beach.png"} {
		if rec := h.do("POST", "/api/scan", map[string]string{"folder": folder}); rec.Code != http.StatusBadRequest {
			t.Errorf("scan %q: got %d, want 400", folder, rec.Code)
		}
	}
	if rec := h.do("POST", "/api/scan", nil); rec.Code != http.StatusBadRequest {
		t.Errorf("empty body: got %d", rec.Code)
	}
}

func TestFolderBrowser(t *testing.T) {
	h := newHarness(t)
	var out struct {
		Path, Parent string
		Folders      []string
		Images       int
	}
	decode(t, h.do("GET", "/api/folders", nil), &out)
	if out.Path != h.root || out.Parent != "" || len(out.Folders) != 2 || out.Folders[0] != "other" || out.Folders[1] != "trip" {
		t.Fatalf("root listing = %+v", out)
	}
	decode(t, h.do("GET", "/api/folders?path=trip", nil), &out)
	if out.Parent != h.root || len(out.Folders) != 1 || out.Folders[0] != "sub" || out.Images != 1 {
		t.Fatalf("trip listing = %+v", out)
	}
	if rec := h.do("GET", "/api/folders?path=/etc", nil); rec.Code != http.StatusBadRequest {
		t.Fatalf("outside root: %d", rec.Code)
	}
}

func TestSelectCachesImageAndAppliesOptions(t *testing.T) {
	h := newHarness(t)
	beach := findPhoto(t, h.scan("trip").Photos, "beach.png")

	rec := h.do("PUT", "/api/selections/"+beach.ID, map[string]any{"seconds": 8, "caption": "  Sunset  "})
	if rec.Code != http.StatusOK {
		t.Fatalf("select: %d %s", rec.Code, rec.Body)
	}
	cached := h.store.sels[beach.ID]
	if cached.Seconds != 8 || cached.Caption != "Sunset" || cached.Name != "beach.png" {
		t.Fatalf("stored selection = %+v", cached)
	}
	if cached.Path != filepath.Join(h.root, "trip", "beach.png") {
		t.Fatalf("path = %s", cached.Path)
	}
	img, format, err := image.DecodeConfig(bytes.NewReader(cached.Image))
	if err != nil || format != "jpeg" || img.Width != 640 || img.Height != 480 {
		t.Fatalf("cached image: %v %s %+v", err, format, img)
	}
	if bytes.Contains(rec.Body.Bytes(), []byte(`"image"`)) {
		t.Fatal("response must not include image bytes")
	}

	// The list now reflects the selection.
	var list listResp
	decode(t, h.do("GET", "/api/photos", nil), &list)
	got := findPhoto(t, list.Photos, "beach.png")
	if !got.Selected || got.Seconds != 8 || got.Caption != "Sunset" {
		t.Fatalf("listed = %+v", got)
	}
}

func TestUpdateOptionsKeepsCachedImage(t *testing.T) {
	h := newHarness(t)
	beach := findPhoto(t, h.scan("trip").Photos, "beach.png")
	h.do("PUT", "/api/selections/"+beach.ID, map[string]any{"seconds": 3})
	first := h.store.sels[beach.ID]

	rec := h.do("PUT", "/api/selections/"+beach.ID, map[string]any{"seconds": 12, "caption": "New"})
	if rec.Code != http.StatusOK {
		t.Fatalf("update: %d", rec.Code)
	}
	after := h.store.sels[beach.ID]
	if after.Seconds != 12 || after.Caption != "New" {
		t.Fatalf("options not updated: %+v", after)
	}
	if !after.CreatedAt.Equal(first.CreatedAt) || !bytes.Equal(after.Image, first.Image) {
		t.Fatal("image should not be re-cached on an options update")
	}
}

func TestSecondsAndCaptionAreNormalized(t *testing.T) {
	ptr := func(n int) *int { return &n }
	cases := []struct {
		name string
		in   *int
		want int
	}{
		{"omitted -> default", nil, defaultSeconds},
		{"zero = wait for Next", ptr(0), 0},
		{"negative -> zero", ptr(-4), 0},
		{"one", ptr(1), 1},
		{"too large -> max", ptr(99999), maxSeconds},
	}
	for _, c := range cases {
		in := selectionInput{Seconds: c.in}
		if got := in.normalize(); got != c.want {
			t.Errorf("%s: got %d, want %d", c.name, got, c.want)
		}
	}
	long := selectionInput{Caption: string(bytes.Repeat([]byte("é"), maxCaptionLen+50))}
	long.normalize()
	if n := len([]rune(long.Caption)); n != maxCaptionLen {
		t.Errorf("caption length %d, want %d", n, maxCaptionLen)
	}
}

func TestZeroSecondsIsStoredAndOmittedGetsDefault(t *testing.T) {
	h := newHarness(t)
	photos := h.scan("trip").Photos
	beach, hill := findPhoto(t, photos, "beach.png"), findPhoto(t, photos, "hill.png")

	h.do("PUT", "/api/selections/"+beach.ID, map[string]any{"seconds": 0, "caption": "Wait here"})
	h.do("PUT", "/api/selections/"+hill.ID, map[string]any{"caption": "no seconds sent"})
	if got := h.store.sels[beach.ID].Seconds; got != 0 {
		t.Fatalf("beach seconds = %d, want 0", got)
	}
	if got := h.store.sels[hill.ID].Seconds; got != defaultSeconds {
		t.Fatalf("hill seconds = %d, want default %d", got, defaultSeconds)
	}

	// Updating an existing selection to 0 works too, and the feed reports it.
	h.do("PUT", "/api/selections/"+hill.ID, map[string]any{"seconds": 0})
	var sels []struct {
		ID      string `json:"id"`
		Seconds int    `json:"seconds"`
	}
	decode(t, h.do("GET", "/api/selections", nil), &sels)
	for _, s := range sels {
		if s.Seconds != 0 {
			t.Fatalf("selection %s seconds = %d, want 0", s.ID, s.Seconds)
		}
	}
}

func TestSelectUnknownPhoto(t *testing.T) {
	h := newHarness(t)
	h.scan("trip")
	if rec := h.do("PUT", "/api/selections/deadbeefdeadbeef", map[string]any{"seconds": 5}); rec.Code != http.StatusNotFound {
		t.Fatalf("got %d, want 404", rec.Code)
	}
	if rec := h.do("PUT", "/api/selections/x", "not an object"); rec.Code != http.StatusBadRequest {
		t.Fatalf("bad body: got %d, want 400", rec.Code)
	}
}

func TestDeselect(t *testing.T) {
	h := newHarness(t)
	beach := findPhoto(t, h.scan("trip").Photos, "beach.png")
	h.do("PUT", "/api/selections/"+beach.ID, map[string]any{"seconds": 5})
	if rec := h.do("DELETE", "/api/selections/"+beach.ID, nil); rec.Code != http.StatusNoContent {
		t.Fatalf("delete: %d", rec.Code)
	}
	if len(h.store.sels) != 0 {
		t.Fatal("selection not removed")
	}
}

func TestSelectionsForDisplayMode(t *testing.T) {
	h := newHarness(t)
	photos := h.scan("trip").Photos
	beach, hill := findPhoto(t, photos, "beach.png"), findPhoto(t, photos, "hill.png")
	h.do("PUT", "/api/selections/"+hill.ID, map[string]any{"seconds": 2, "caption": "Hill"})
	h.do("PUT", "/api/selections/"+beach.ID, map[string]any{"seconds": 4})

	var sels []struct {
		ID       string `json:"id"`
		Seconds  int    `json:"seconds"`
		Caption  string `json:"caption"`
		ImageURL string `json:"imageUrl"`
	}
	rec := h.do("GET", "/api/selections", nil)
	decode(t, rec, &sels)
	if len(sels) != 2 || sels[0].ID != beach.ID || sels[1].ID != hill.ID {
		t.Fatalf("selections (sorted by path) = %+v", sels)
	}
	if sels[1].Seconds != 2 || sels[1].Caption != "Hill" {
		t.Fatalf("hill = %+v", sels[1])
	}

	// The image URL serves the bytes cached in the store, with ETag support.
	img := h.do("GET", sels[0].ImageURL, nil)
	if img.Code != http.StatusOK || img.Header().Get("Content-Type") != "image/jpeg" || img.Body.Len() == 0 {
		t.Fatalf("image: %d %s len=%d", img.Code, img.Header().Get("Content-Type"), img.Body.Len())
	}
	req := httptest.NewRequest("GET", sels[0].ImageURL, nil)
	req.Header.Set("If-None-Match", img.Header().Get("ETag"))
	rec304 := httptest.NewRecorder()
	h.h.ServeHTTP(rec304, req)
	if rec304.Code != http.StatusNotModified {
		t.Fatalf("conditional GET: %d", rec304.Code)
	}

	if rec := h.do("GET", "/api/selections/nope/image", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("missing image: %d", rec.Code)
	}
}

func TestRescanClearsAllDocuments(t *testing.T) {
	h := newHarness(t)
	photos := h.scan("trip").Photos
	for _, p := range photos {
		h.do("PUT", "/api/selections/"+p.ID, map[string]any{"seconds": 7, "caption": "x"})
	}
	if len(h.store.sels) != 2 {
		t.Fatalf("setup: %d selections", len(h.store.sels))
	}

	// Rescanning the same folder clears everything: all photos come back unselected.
	list := h.scan("trip")
	if len(h.store.sels) != 0 {
		t.Fatalf("selections left after rescan: %d", len(h.store.sels))
	}
	for _, p := range list.Photos {
		if p.Selected || p.Seconds != defaultSeconds || p.Caption != "" {
			t.Fatalf("after rescan %s = %+v, want unselected defaults", p.Name, p)
		}
	}
	// The settings collection is cleared too, then holds just the new folder.
	if h.store.folder != list.Folder {
		t.Fatalf("last folder = %q, want %q", h.store.folder, list.Folder)
	}

	// Scanning a different folder clears as well, so nothing carries over.
	beach := findPhoto(t, list.Photos, "beach.png")
	h.do("PUT", "/api/selections/"+beach.ID, map[string]any{"seconds": 6})
	other := h.scan("other")
	if len(h.store.sels) != 0 || len(other.Photos) != 1 || other.Photos[0].Name != "cat.png" {
		t.Fatalf("after scanning other: sels=%d photos=%+v", len(h.store.sels), other.Photos)
	}
	var sels []Selection
	decode(t, h.do("GET", "/api/selections", nil), &sels)
	if len(sels) != 0 {
		t.Fatalf("display feed should be empty, got %d", len(sels))
	}
}

func TestFailedScanDoesNotClear(t *testing.T) {
	h := newHarness(t)
	beach := findPhoto(t, h.scan("trip").Photos, "beach.png")
	h.do("PUT", "/api/selections/"+beach.ID, map[string]any{"seconds": 6})
	if rec := h.do("POST", "/api/scan", map[string]string{"folder": "does-not-exist"}); rec.Code != http.StatusBadRequest {
		t.Fatalf("bad scan: %d", rec.Code)
	}
	if len(h.store.sels) != 1 {
		t.Fatal("a rejected scan must not clear the database")
	}
}

func TestRestartRestoresWithoutClearing(t *testing.T) {
	h := newHarness(t)
	beach := findPhoto(t, h.scan("trip").Photos, "beach.png")
	h.do("PUT", "/api/selections/"+beach.ID, map[string]any{"seconds": 6, "caption": "Keep"})

	srv2 := NewServer(h.srv.cfg, h.store)
	srv2.restoreFolder(context.Background())
	if len(h.store.sels) != 1 {
		t.Fatal("restoring the last folder on startup must not clear selections")
	}
}

func TestUnselectAll(t *testing.T) {
	h := newHarness(t)
	photos := h.scan("trip").Photos
	for _, p := range photos {
		h.do("PUT", "/api/selections/"+p.ID, map[string]any{"seconds": 3})
	}
	rec := h.do("DELETE", "/api/selections", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("unselect all: %d %s", rec.Code, rec.Body)
	}
	var out struct{ Deleted int64 }
	decode(t, rec, &out)
	if out.Deleted != 2 || len(h.store.sels) != 0 {
		t.Fatalf("deleted=%d left=%d", out.Deleted, len(h.store.sels))
	}
	// The folder is kept, and the list shows everything unselected.
	if h.store.folder == "" {
		t.Fatal("unselect all should not forget the scanned folder")
	}
	var list listResp
	decode(t, h.do("GET", "/api/photos", nil), &list)
	for _, p := range list.Photos {
		if p.Selected {
			t.Fatalf("%s still selected", p.Name)
		}
	}
	// Idempotent.
	decode(t, h.do("DELETE", "/api/selections", nil), &out)
	if out.Deleted != 0 {
		t.Fatalf("second unselect all deleted %d", out.Deleted)
	}
}

func TestChangingTheMountedFolderClearsOldData(t *testing.T) {
	h := newHarness(t)
	beach := findPhoto(t, h.scan("trip").Photos, "beach.png")
	h.do("PUT", "/api/selections/"+beach.ID, map[string]any{"seconds": 6})
	if h.store.mounted != "/Users/me/Pictures" {
		t.Fatalf("scan should record the mounted folder, got %q", h.store.mounted)
	}

	// Same mount after a restart: nothing is cleared.
	same := NewServer(h.srv.cfg, h.store)
	same.restoreFolder(context.Background())
	if len(h.store.sels) != 1 || h.store.folder == "" {
		t.Fatal("restart with the same PHOTOS_DIR must keep selections")
	}

	// PHOTOS_DIR changed (e.g. from ./photos to ~/Pictures): old data is cleared.
	cfg := h.srv.cfg
	cfg.HostRoot = "/Users/me/Other"
	changed := NewServer(cfg, h.store)
	changed.restoreFolder(context.Background())
	if len(h.store.sels) != 0 || h.store.folder != "" {
		t.Fatalf("after mount change: sels=%d folder=%q", len(h.store.sels), h.store.folder)
	}
	if h.store.mounted != "/Users/me/Other" {
		t.Fatalf("mounted = %q", h.store.mounted)
	}
	if folder, _ := changed.current(); folder != "" {
		t.Fatalf("nothing should be restored after a mount change, got %q", folder)
	}
}

func TestConfigReportsHostFolder(t *testing.T) {
	h := newHarness(t)
	var cfg map[string]string
	decode(t, h.do("GET", "/api/config", nil), &cfg)
	if cfg["hostRoot"] != "/Users/me/Pictures" || cfg["root"] != h.root {
		t.Fatalf("config = %v", cfg)
	}
}

func TestExpandHome(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("no home dir")
	}
	for in, want := range map[string]string{
		"~":            home,
		"~/Pictures":   filepath.Join(home, "Pictures"),
		"/abs/path":    "/abs/path",
		"./photos":     "./photos",
		"~someone/pic": "~someone/pic",
	} {
		if got := expandHome(in); got != want {
			t.Errorf("expandHome(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSelectionOfDeletedFileStaysListed(t *testing.T) {
	h := newHarness(t)
	beach := findPhoto(t, h.scan("trip").Photos, "beach.png")
	h.do("PUT", "/api/selections/"+beach.ID, map[string]any{"seconds": 6, "caption": "Keep"})
	if err := os.Remove(filepath.Join(h.root, "trip", "beach.png")); err != nil {
		t.Fatal(err)
	}
	h.srv.scan(filepath.Join(h.root, "trip")) // e.g. a restart, which rescans without clearing

	var list listResp
	decode(t, h.do("GET", "/api/photos", nil), &list)
	kept := findPhoto(t, list.Photos, "beach.png")
	if !kept.Elsewhere || !kept.Selected || kept.Seconds != 6 {
		t.Fatalf("kept=%+v", kept)
	}
	// Its thumbnail falls back to the copy cached in the store.
	if rec := h.do("GET", "/api/photos/"+beach.ID+"/thumb", nil); rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "image/jpeg" {
		t.Fatalf("fallback thumb: %d", rec.Code)
	}
}

func TestThumbnailIsGeneratedAndCached(t *testing.T) {
	h := newHarness(t)
	hill := findPhoto(t, h.scan("trip").Photos, "hill.png")
	rec := h.do("GET", "/api/photos/"+hill.ID+"/thumb", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("thumb: %d %s", rec.Code, rec.Body)
	}
	cfg, _, err := image.DecodeConfig(rec.Body)
	if err != nil || cfg.Height != thumbSize || cfg.Width != thumbSize/2 {
		t.Fatalf("thumb size %dx%d err=%v", cfg.Width, cfg.Height, err)
	}
	files, _ := filepath.Glob(filepath.Join(h.srv.cfg.ThumbCacheDir, hill.ID+"-*.jpg"))
	if len(files) != 1 {
		t.Fatalf("expected one cached thumbnail, got %v", files)
	}
	if rec := h.do("GET", "/api/photos/0000000000000000/thumb", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown thumb: %d", rec.Code)
	}
}

func TestOriginalIsServed(t *testing.T) {
	h := newHarness(t)
	beach := findPhoto(t, h.scan("trip").Photos, "beach.png")
	rec := h.do("GET", "/api/photos/"+beach.ID+"/original", nil)
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("original: %d %s", rec.Code, rec.Header().Get("Content-Type"))
	}
}

func TestThumbnailNeverUpscales(t *testing.T) {
	h := newHarness(t)
	cat := findPhoto(t, h.scan("other").Photos, "cat.png")
	rec := h.do("GET", "/api/photos/"+cat.ID+"/thumb", nil)
	cfg, _, err := image.DecodeConfig(rec.Body)
	if err != nil || cfg.Width != 50 || cfg.Height != 50 {
		t.Fatalf("small image thumb %dx%d err=%v", cfg.Width, cfg.Height, err)
	}
}
