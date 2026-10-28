import { useEffect, useId, useState } from 'react';
import { MAX_SECONDS, MIN_SECONDS, clampSeconds, thumbUrl, type Photo, type PhotoOptions } from '../api';

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

interface Props {
  photo: Photo;
  saveState?: SaveState;
  onToggle: (photo: Photo, selected: boolean) => void;
  onOptions: (photo: Photo, options: PhotoOptions) => void;
}

const saveLabels: Record<SaveState, string> = {
  idle: '',
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Not saved',
};

export function PhotoRow({ photo, saveState = 'idle', onToggle, onOptions }: Props) {
  const uid = useId();
  // Keep the seconds field as text while typing so it can be briefly empty.
  const [secondsText, setSecondsText] = useState(String(photo.seconds));
  useEffect(() => setSecondsText(String(photo.seconds)), [photo.seconds]);

  const commitSeconds = (text: string) => {
    setSecondsText(text);
    const n = Number(text);
    if (text.trim() !== '' && Number.isFinite(n) && n >= MIN_SECONDS) {
      const seconds = clampSeconds(n);
      if (seconds !== photo.seconds) onOptions(photo, { seconds, caption: photo.caption });
    }
  };

  return (
    <li className={`photo-row${photo.selected ? ' is-selected' : ''}`} data-testid={`photo-${photo.id}`}>
      <label className="photo-check" title={photo.selected ? 'Remove from slideshow' : 'Add to slideshow'}>
        <input
          type="checkbox"
          checked={photo.selected}
          onChange={(e) => onToggle(photo, e.target.checked)}
          aria-label={`Show ${photo.name} in display mode`}
        />
        <span className="checkmark" aria-hidden="true" />
      </label>

      <img className="photo-thumb" src={thumbUrl(photo.id)} alt={photo.name} loading="lazy" decoding="async" />

      <div className="photo-meta">
        <div className="photo-name" title={photo.path}>
          {photo.name}
          {photo.elsewhere && <span className="tag" title="The file is no longer in the folder; it still plays from the saved copy">file missing</span>}
        </div>
        {photo.path !== photo.name && <div className="photo-path">{photo.path}</div>}
        <div className="photo-save" aria-live="polite" data-state={saveState}>
          {saveLabels[saveState]}
        </div>
      </div>

      <div className="photo-options">
        <label className="field seconds-field" htmlFor={`${uid}-sec`}>
          <span>Seconds</span>
          <input
            id={`${uid}-sec`}
            type="number"
            inputMode="numeric"
            min={MIN_SECONDS}
            max={MAX_SECONDS}
            step={1}
            value={secondsText}
            onChange={(e) => commitSeconds(e.target.value)}
            onBlur={() => setSecondsText(String(photo.seconds))}
            aria-label={`Seconds to show ${photo.name}`}
            title="0 = stay on this photo until Next is pressed"
          />
          {photo.seconds === 0 && <small className="wait-hint">Waits for Next</small>}
        </label>
        <label className="field caption-field" htmlFor={`${uid}-cap`}>
          <span>Caption (optional)</span>
          <input
            id={`${uid}-cap`}
            type="text"
            maxLength={500}
            placeholder="Add a caption…"
            value={photo.caption}
            onChange={(e) => onOptions(photo, { seconds: photo.seconds, caption: e.target.value })}
            aria-label={`Caption for ${photo.name}`}
          />
        </label>
      </div>
    </li>
  );
}
