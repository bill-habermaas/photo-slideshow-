import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { api, type FolderListing } from '../api';

interface Props {
  /** Folder to open the dialog at (empty = the server's default). */
  start: string;
  /** Selected photos that scanning will clear (0 = no warning). */
  selectedCount?: number;
  onChoose: (path: string) => void;
  onCancel: () => void;
}

const joinPath = (base: string, name: string) => (base.endsWith('/') ? base + name : `${base}/${name}`);

/**
 * Modal directory-selection dialog. It browses the folders the backend can
 * see (inside its container), so the chosen path is one the scanner can read.
 */
export function FolderDialog({ start, selectedCount = 0, onChoose, onCancel }: Props) {
  const [path, setPath] = useState(start);
  const [typed, setTyped] = useState(start);
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    api
      .folders(path)
      .then((l) => {
        if (cancelled) return;
        setListing(l);
        setTyped(l.path);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setListing(null);
        setError(e.message);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [path]);

  // Focus the dialog when it opens; Esc cancels; keep Tab inside the dialog.
  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      } else if (e.key === 'Tab' && dialogRef.current) {
        const items = dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input');
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const goTyped = (e: FormEvent) => {
    e.preventDefault();
    if (typed.trim()) setPath(typed.trim());
  };

  const photoNote = listing
    ? listing.images === 0
      ? 'No photos directly in this folder'
      : `${listing.images} photo${listing.images === 1 ? '' : 's'} in this folder`
    : '';

  // Portal: the dialog has its own form, and forms can't be nested.
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        className="modal folder-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="folder-dialog-title"
        ref={dialogRef}
        tabIndex={-1}
      >
        <header className="modal-head">
          <h2 id="folder-dialog-title">Select a folder to scan</h2>
          <button type="button" className="btn btn-ghost btn-icon" onClick={onCancel} aria-label="Close">
            ✕
          </button>
        </header>

        <form className="folder-dialog-path" onSubmit={goTyped}>
          <input
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            aria-label="Folder path"
            spellCheck={false}
            autoComplete="off"
          />
          <button type="submit" className="btn">
            Go
          </button>
        </form>

        <div className="folder-dialog-body" aria-busy={loading}>
          {error && <p className="error">{error}</p>}
          <ul className="folder-list" aria-label="Sub-folders">
            {listing?.parent && (
              <li>
                <button type="button" onClick={() => setPath(listing.parent)} aria-label="Up one folder">
                  <span className="folder-icon up" aria-hidden="true" />
                  ..
                </button>
              </li>
            )}
            {listing?.folders.map((name) => (
              <li key={name}>
                <button type="button" onClick={() => setPath(joinPath(listing.path, name))} onDoubleClick={() => onChoose(joinPath(listing.path, name))}>
                  <span className="folder-icon" aria-hidden="true" />
                  {name}
                </button>
              </li>
            ))}
            {listing && listing.folders.length === 0 && <li className="muted">No sub-folders</li>}
          </ul>
        </div>

        {selectedCount > 0 && (
          <p className="scan-warning" role="note">
            Scanning clears your current selections ({selectedCount} photo{selectedCount === 1 ? '' : 's'}), including
            their seconds and captions.
          </p>
        )}
        <footer className="modal-foot">
          <span className="photo-note">{loading ? 'Loading…' : photoNote}</span>
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!listing || loading}
            onClick={() => listing && onChoose(listing.path)}
          >
            Scan this folder
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
