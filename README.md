# Photo Slideshow

A Go backend and React web front end, packaged as Docker images and run with
docker compose.

1. On start, a **directory selection dialog** opens. Browse to a folder (or type a
   path) and press **Scan this folder**. The backend scans it, including
   sub-folders, and the page lists a thumbnail of every photo it finds.
2. Each row has a **checkmark** that selects the photo for display mode, a
   **seconds** field (how long it stays on screen), and an optional **caption**.
   Set seconds to **0** to keep a photo on screen until **Next** is pressed.
3. Selected photos are cached in **MongoDB**: the selection, its seconds and
   caption, and a display-sized copy of the image (max 2560 px, JPEG).
4. **Display** fetches the selections from MongoDB and shows each photo
   scaled to fit the whole window (larger or smaller as needed, never
   cropped), with no frame. Floating over the top of the photo are the photo
   counter and status, then Pause, **Previous**, **Next** and Exit. Along the
   bottom are the caption (if set) and a duration bar. Next always
   moves to the next photo and Previous always moves back, whatever the
   duration. Photos with a duration advance by themselves after that many
   seconds; 0-second photos wait for Next. The slideshow loops. Enter or →
   also means Next, ← Previous, Space pauses a timed photo, Esc exits.

Pressing **Scan…** later reopens the dialog. **Every scan starts fresh:** it
clears all documents in MongoDB (every selection with its cached image,
seconds and caption, plus the saved folder) and then lists the folder with
nothing selected. The dialog warns you when there are selections to lose. A
scan that fails (for example, a folder that doesn't exist) clears nothing.
Restarting the server is not a scan: it reopens the last folder with its
selections intact.

**Unselect all**, above the list, turns every selection off in one click. The
seconds and captions you typed stay in the rows, so ticking a photo again
saves them with it.

## Run it with Docker

```bash
docker compose up -d --build  # builds images (unit tests run during the build)
```

Open <http://localhost:3000>. Out of the box the bundled sample photos in
`./photos` are used.

### Use your own photo folder

Edit `.env` in the project folder and uncomment/set `PHOTOS_DIR` to a full
path, then recreate the API container:

```bash
# .env
PHOTOS_DIR=/Users/yourname/Pictures      # or ~/Pictures, or C:/Users/yourname/Pictures

docker compose up -d
```

Check it took effect:

- The line under the folder field in the app reads
  "`/photos` is `/Users/yourname/Pictures` on your computer". If it says
  `./photos`, the setting wasn't picked up.
- `docker compose logs api` shows `on host:` and the first few entries of the
  folder (`contains: ...`), or a warning if it is empty or unreadable.
- `docker compose config | grep -A2 "target: /photos"` shows the exact folder
  being mounted.

If it still shows the project folder: make sure `PHOTOS_DIR` is not still set
to `./photos` in `.env` (older versions of `.env.example` set it), that the
line is uncommented, and that you ran `docker compose up -d` from the project
folder after saving. A `PHOTOS_DIR` set in your shell overrides `.env`. On a
Mac, Docker Desktop must be allowed to share the folder (Settings → Resources →
File sharing; `/Users` is shared by default).

When the mounted folder changes, the API clears the selections saved from the
old folder on its next start, so old photos don't keep playing.

| Service | Image | What it does |
|---|---|---|
| `mongo` | `mongo:8` | Stores selections and cached images (volume `mongo-data`) |
| `api` | `photo-slideshow-api` | Go API on :8080; `PHOTOS_DIR` (default `./photos`) mounted read-only at `/photos`; thumbnails cached in volume `thumbs` |
| `web` | `photo-slideshow-web` | nginx serving the React build on `WEB_PORT` (3000), proxying `/api` to `api` |

The folder dialog shows paths **inside the API container**: your `PHOTOS_DIR`
is `/photos`, and scanning is restricted to that folder. To scan a different
folder, change `PHOTOS_DIR` and run `docker compose up -d`.

Stop with `docker compose down` (add `-v` to also delete the MongoDB data and
thumbnail cache).

## Open in VS Code

Open the folder (or `photo-slideshow.code-workspace`) and install the
recommended extensions when prompted (Go, Vitest, Container Tools, MongoDB,
Prettier).

**Tasks** (Terminal → Run Task):

- `docker: build & start all` / `docker: stop all` / `docker: follow logs`
- `mongo: start (docker)` starts only MongoDB, for local debugging
- `web: install`, then `web: dev server` runs Vite on :5173
- `test: all` (default test task), `test: backend (Go)`, `test: frontend (Vitest)`

**Debug** (Run and Debug panel):

- **Full stack: debug API + Web** starts MongoDB in Docker, runs the Go API
  under the debugger on :8080 (scanning `PHOTOS_DIR` from `.env`, or `./photos`), starts Vite and opens
  Chrome on <http://localhost:5173>. Run `web: install` once first.
- **API: debug Go unit tests** and **Web: debug Vitest (current file)**

Stop the `web`/`api` containers before local debugging if they're running, so
ports don't clash (or change `WEB_PORT`).

## Tests

```bash
cd backend && go test ./...     # 24 tests
cd frontend && npm ci && npm test   # 90 tests
```

- **Backend** (`backend/*_test.go`): the HTTP handlers run against an
  in-memory store that implements the same `SelectionStore` interface as the
  MongoDB store, so no database is needed. Covers scanning (recursion, hidden
  folders, file types), path restriction to `PHOTO_ROOT`, the folder browser,
  selecting (image cached, options trimmed and clamped, 0 seconds kept, omitted seconds defaulted), option updates that
  don't re-cache the image, deselecting, the display-mode feed and cached-image
  ETags, selections from other folders, thumbnail generation and caching, and
  restoring the last folder on restart, a rescan clearing every document (but a
  failed scan or a restart clearing nothing), and Unselect all.
- **Frontend** (`frontend/src/**/*.test.ts(x)`, Vitest + Testing Library):
  the API client, the folder dialog (auto-open, navigation, typed paths, errors,
  cancel), the photo row (checkmark, seconds clamping, caption), the slideshow
  (no frame; Previous, Next and Exit together at the top of the window;
  caption then duration bar at the bottom; Previous directly before Next; per-photo timing with fake timers, 0-second photos waiting for Next, Next
  always advancing regardless of duration or pause, looping, pause/resume
  keeping the remaining time, keyboard, exit), and the App flow (scan, select,
  revert on failure, debounced saves, pending edits flushed before Display,
  Unselect all, the rescan warning, and late saves being dropped so a cleared
  selection can't come back).

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/config` | Photo root, default folder, last scanned folder |
| GET | `/api/folders?path=` | Sub-folders and photo count, for the dialog |
| POST | `/api/scan` `{folder}` | Clear all MongoDB documents, scan a folder; returns the photo list |
| GET | `/api/photos` | List for the current folder, merged with selections |
| GET | `/api/photos/{id}/thumb` | 320 px JPEG thumbnail (disk-cached) |
| GET | `/api/photos/{id}/original` | Original file |
| GET | `/api/selections` | Selections for display mode (from MongoDB) |
| PUT | `/api/selections/{id}` `{seconds, caption}` | Select (caches image) or update options; `seconds: 0` waits for Next, omitted = 5 |
| DELETE | `/api/selections/{id}` | Unselect |
| DELETE | `/api/selections` | Unselect all; returns `{deleted}` |
| GET | `/api/selections/{id}/image` | Cached display image from MongoDB |

Configuration (env vars, also flags; see `backend/main.go`): `PHOTO_ROOT`,
`DEFAULT_FOLDER`, `MONGO_URI`, `MONGO_DB`, `ADDR`, `THUMB_CACHE_DIR`.

## Notes

- Supported formats: JPEG, PNG, GIF, WebP, BMP, TIFF. EXIF orientation is
  applied, so phone photos aren't sideways. HEIC isn't supported.
- Seconds are 0–3600 (0 = wait for Next); captions up to 500 characters.
- `backend/go.sum` isn't included; the Docker build creates it with
  `go mod tidy`. For local Go work, run `go mod tidy` in `backend/` once.
