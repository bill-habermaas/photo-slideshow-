import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type AppConfig, type Photo, type PhotoList, type PhotoOptions } from './api';
import { FolderPicker } from './components/FolderPicker';
import { PhotoRow, type SaveState } from './components/PhotoRow';
import { Slideshow } from './components/Slideshow';

/** Option edits on a selected photo are saved to MongoDB after this pause in typing. */
export const SAVE_DEBOUNCE_MS = 500;

type Pending = { timer: ReturnType<typeof setTimeout>; run: () => Promise<void> };

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [folder, setFolder] = useState('');
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [scanned, setScanned] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState('');
  const [displaying, setDisplaying] = useState(false);
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});
  const [clearing, setClearing] = useState(false);
  const pending = useRef(new Map<string, Pending>());

  const applyList = (list: PhotoList) => {
    setFolder(list.folder);
    setPhotos(list.photos);
    setScanned(true);
    setSaveStates({});
  };

  // Initial load: config, and the previously scanned folder if there is one.
  useEffect(() => {
    api
      .config()
      .then((cfg) => {
        setConfig(cfg);
        if (cfg.folder) return api.photos().then(applyList);
      })
      .catch((e: Error) => setError(`Can’t reach the server: ${e.message}`));
  }, []);

  // Drop option edits still waiting on the debounce, so a save that fires late
  // can't bring back a selection that was just cleared.
  const cancelAllPending = () => {
    for (const p of pending.current.values()) clearTimeout(p.timer);
    pending.current.clear();
  };

  const scan = async (target: string) => {
    cancelAllPending();
    setScanning(true);
    setError('');
    try {
      applyList(await api.scan(target));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setScanning(false);
    }
  };

  const patchPhoto = (id: string, patch: Partial<Photo>) =>
    setPhotos((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const setSave = (id: string, state: SaveState) => setSaveStates((s) => ({ ...s, [id]: state }));

  const cancelPending = (id: string) => {
    const p = pending.current.get(id);
    if (p) clearTimeout(p.timer);
    pending.current.delete(id);
  };

  const toggle = async (photo: Photo, selected: boolean) => {
    cancelPending(photo.id);
    patchPhoto(photo.id, { selected });
    setSave(photo.id, 'saving');
    setError('');
    try {
      if (selected) {
        await api.select(photo.id, { seconds: photo.seconds, caption: photo.caption });
        setSave(photo.id, 'saved');
      } else {
        await api.unselect(photo.id);
        setSave(photo.id, 'idle');
        // A photo whose file is missing disappears from the list once unselected.
        if (photo.elsewhere) setPhotos((ps) => ps.filter((p) => p.id !== photo.id));
      }
    } catch (e) {
      patchPhoto(photo.id, { selected: !selected });
      setSave(photo.id, 'error');
      setError(`${photo.name}: ${(e as Error).message}`);
    }
  };

  const changeOptions = (photo: Photo, options: PhotoOptions) => {
    patchPhoto(photo.id, options);
    if (!photo.selected) return; // saved along with the photo when it is selected
    cancelPending(photo.id);
    setSave(photo.id, 'saving');
    const run = async () => {
      pending.current.delete(photo.id);
      try {
        await api.select(photo.id, options);
        setSave(photo.id, 'saved');
      } catch (e) {
        setSave(photo.id, 'error');
        setError(`${photo.name}: ${(e as Error).message}`);
      }
    };
    pending.current.set(photo.id, { timer: setTimeout(run, SAVE_DEBOUNCE_MS), run });
  };

  // Save any edits still waiting on the debounce before the slideshow reads MongoDB.
  const flushPending = useCallback(async () => {
    const runs = [...pending.current.values()].map((p) => {
      clearTimeout(p.timer);
      return p.run();
    });
    pending.current.clear();
    await Promise.all(runs);
  }, []);

  // Turn every selection off. Seconds and captions typed in the list are kept
  // on screen, so ticking a photo again saves them with it.
  const unselectAll = async () => {
    cancelAllPending();
    setClearing(true);
    setError('');
    try {
      await api.unselectAll();
      setPhotos((ps) => ps.filter((p) => !p.elsewhere).map((p) => (p.selected ? { ...p, selected: false } : p)));
      setSaveStates({});
    } catch (e) {
      setError(`Couldn’t unselect all: ${(e as Error).message}`);
    } finally {
      setClearing(false);
    }
  };

  const startDisplay = async () => {
    await flushPending();
    setDisplaying(true);
  };

  const selectedCount = photos.filter((p) => p.selected).length;

  return (
    <div className={`app${scanned ? '' : ' app-start'}`}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          Photo Slideshow
        </div>
        {scanned && (
          <div className="topbar-actions">
            <span className="count">
              {selectedCount} of {photos.length} selected
            </span>
            <button type="button" className="btn btn-primary btn-display" disabled={selectedCount === 0} onClick={startDisplay}>
              ▶ Display
            </button>
          </div>
        )}
      </header>

      <main>
        <section className={scanned ? 'picker-bar' : 'hero'}>
          {!scanned && (
            <>
              <h1>Pick a folder of photos</h1>
              <p className="lede">
                Choose a folder to scan for photos, tick the ones you want, set how long each one shows and add a caption, then
                press Display.
              </p>
            </>
          )}
          {config && (
            <FolderPicker
              initialFolder={folder || config.defaultFolder}
              root={config.root}
              hostRoot={config.hostRoot}
              scanning={scanning}
              autoOpen={!config.folder && !scanned}
              selectedCount={selectedCount}
              onScan={scan}
            />
          )}
        </section>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        {scanned &&
          (photos.length === 0 ? (
            <p className="empty">
              No photos found in <code>{folder}</code>.
            </p>
          ) : (
            <>
              <div className="list-toolbar">
                <span className="list-count">
                  {photos.length} photo{photos.length === 1 ? '' : 's'}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost btn-small"
                  onClick={unselectAll}
                  disabled={selectedCount === 0 || clearing}
                >
                  {clearing ? 'Unselecting…' : 'Unselect all'}
                </button>
              </div>
              <ul className="photo-list" aria-label="Photos">
                {photos.map((p) => (
                  <PhotoRow key={p.id} photo={p} saveState={saveStates[p.id]} onToggle={toggle} onOptions={changeOptions} />
                ))}
              </ul>
            </>
          ))}
      </main>

      {/* Overlay, so the list (and its scroll position) is still there on exit. */}
      {displaying && <Slideshow onExit={() => setDisplaying(false)} />}
    </div>
  );
}
