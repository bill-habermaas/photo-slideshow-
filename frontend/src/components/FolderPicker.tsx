import { useEffect, useState, type FormEvent } from 'react';
import { FolderDialog } from './FolderDialog';

interface Props {
  initialFolder: string;
  root: string;
  /** The photo root's path on the user's computer, when it differs from `root`. */
  hostRoot?: string;
  scanning: boolean;
  /** Open the directory-selection dialog straight away (first start). */
  autoOpen?: boolean;
  /** Number of selected photos; the dialog warns that scanning clears them. */
  selectedCount?: number;
  onScan: (folder: string) => void;
}

/**
 * Shows the folder being scanned. Starting a scan opens the directory
 * selection dialog at the typed path; choosing a folder there runs the scan.
 */
export function FolderPicker({ initialFolder, root, hostRoot = '', scanning, autoOpen = false, selectedCount = 0, onScan }: Props) {
  const [folder, setFolder] = useState(initialFolder);
  const [dialogOpen, setDialogOpen] = useState(autoOpen);
  useEffect(() => setFolder(initialFolder), [initialFolder]);

  const openDialog = (e?: FormEvent) => {
    e?.preventDefault();
    if (!scanning) setDialogOpen(true);
  };

  return (
    <form className="folder-picker" onSubmit={openDialog}>
      <label htmlFor="folder-input" className="folder-label">
        Photo folder
      </label>
      <div className="folder-row">
        <input
          id="folder-input"
          type="text"
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
          placeholder={root || '/photos'}
          spellCheck={false}
          autoComplete="off"
        />
        <button type="submit" className="btn btn-primary" disabled={scanning}>
          {scanning ? 'Scanning…' : 'Scan…'}
        </button>
      </div>
      {root && <MountHint root={root} hostRoot={hostRoot} />}
      {dialogOpen && (
        <FolderDialog
          start={folder.trim() || root}
          selectedCount={selectedCount}
          onCancel={() => setDialogOpen(false)}
          onChoose={(path) => {
            setFolder(path);
            setDialogOpen(false);
            onScan(path);
          }}
        />
      )}
    </form>
  );
}

/** Explains which folder on the user's computer the scanner can see. */
export function MountHint({ root, hostRoot }: { root: string; hostRoot: string }) {
  if (!hostRoot || hostRoot === root) {
    return (
      <p className="hint" data-testid="mount-hint">
        Scanning <code>{root}</code>. Set <code>PHOTOS_DIR</code> in <code>.env</code> to use a different folder.
      </p>
    );
  }
  const projectDefault = !/^([/~]|[A-Za-z]:[\\/])/.test(hostRoot); // relative path, e.g. ./photos
  return (
    <p className="hint" data-testid="mount-hint">
      <code>{root}</code> is <code>{hostRoot}</code> on your computer
      {projectDefault ? (
        <>
          {' '}
          (the project&rsquo;s sample folder). To scan your own photos, set <code>PHOTOS_DIR</code> in <code>.env</code> to
          a full path and run <code>docker compose up -d</code>.
        </>
      ) : (
        '.'
      )}
    </p>
  );
}
