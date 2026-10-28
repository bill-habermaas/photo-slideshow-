import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Selection } from '../api';

interface Props {
  onExit: () => void;
}

/**
 * Display mode: fetches the selections from MongoDB (via the API) and shows
 * each photo scaled to fit the whole window, unframed. Pause, Previous, Next
 * and Exit float along the top; the caption and duration bar along the bottom. A photo with a duration advances by itself after that many
 * seconds; a photo with 0 seconds stays until Next is pressed. Next always
 * moves on and Previous always moves back, whatever the duration.
 */
export function Slideshow({ onExit }: Props) {
  const [slides, setSlides] = useState<Selection[] | null>(null);
  const [error, setError] = useState('');
  const [index, setIndex] = useState(0);
  const [cycle, setCycle] = useState(0); // bumps on every advance, even 0 -> 0
  const [paused, setPaused] = useState(false);
  // Time left on the current slide, so pausing and resuming keeps the remainder.
  const remaining = useRef<{ key: string; ms: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .selections()
      .then((s) => !cancelled && setSlides(s))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, []);

  const count = slides?.length ?? 0;
  const current = slides && count > 0 ? slides[index % count] : undefined;
  const slideKey = `${index}:${cycle}`;
  const waitsForNext = current?.seconds === 0;

  const goTo = useCallback(
    (next: number) => {
      if (!count) return;
      setIndex(((next % count) + count) % count);
      setCycle((c) => c + 1);
    },
    [count],
  );
  const next = useCallback(() => goTo(index + 1), [goTo, index]);

  // Advance after the current slide's seconds. 0 seconds: no timer, wait for Next.
  useEffect(() => {
    if (!current || paused || current.seconds <= 0) return;
    if (remaining.current?.key !== slideKey) {
      remaining.current = { key: slideKey, ms: current.seconds * 1000 };
    }
    const started = Date.now();
    const timer = setTimeout(next, remaining.current.ms);
    return () => {
      clearTimeout(timer);
      if (remaining.current?.key === slideKey) {
        remaining.current.ms = Math.max(0, remaining.current.ms - (Date.now() - started));
      }
    };
  }, [current, paused, slideKey, next]);

  // Keep keyboard focus on Next so Enter advances, too.
  useEffect(() => {
    nextRef.current?.focus({ preventScroll: true });
  }, [slideKey, slides]);

  // Preload the next photo so transitions are instant.
  useEffect(() => {
    if (!slides || count < 2) return;
    const img = new Image();
    img.src = slides[(index + 1) % count].imageUrl;
  }, [slides, count, index]);

  // Keyboard: Esc exits, Space pauses, arrows step.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onExit();
      else if (e.key === ' ') {
        e.preventDefault();
        setPaused((p) => !p);
      } else if (e.key === 'ArrowRight') next();
      else if (e.key === 'ArrowLeft') goTo(index - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onExit, goTo, next, index]);

  // Go full screen where the browser allows it.
  useEffect(() => {
    const el = rootRef.current;
    el?.requestFullscreen?.().catch(() => undefined);
    return () => {
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => undefined);
    };
  }, []);

  const message = error
    ? `Couldn’t load the slideshow: ${error}`
    : !slides
      ? 'Loading…'
      : !current
        ? 'No photos are selected for display.'
        : '';

  const status = !current
    ? ''
    : waitsForNext
      ? 'Press Next to continue'
      : paused
        ? 'Paused'
        : `Auto-advance: ${current.seconds}s`;

  return (
    <div className="slideshow" ref={rootRef} data-testid="slideshow">
      {/* Top of the window: status on the left; Pause, Previous, Next and Exit on the right. */}
      <header className="slide-top" data-testid="slide-top">
        <div className="slide-info">
          {current && (
            <>
              <span className="slide-counter">
                {index + 1} / {count}
              </span>
              <span className="slide-status" aria-live="polite">
                {status}
              </span>
            </>
          )}
        </div>
        <div className="slide-nav">
          {current && (
            <>
              <button
                type="button"
                className="btn btn-ghost slide-pause"
                onClick={() => setPaused((p) => !p)}
                aria-label={paused ? 'Resume' : 'Pause'}
                disabled={waitsForNext}
                title={waitsForNext ? 'This photo waits for Next' : undefined}
              >
                {paused ? '▶' : '❚❚'}
              </button>
              <button type="button" className="btn slide-prev" onClick={() => goTo(index - 1)} aria-label="Previous photo">
                <span aria-hidden="true">‹</span> Previous
              </button>
              <button type="button" className="btn btn-primary slide-next" ref={nextRef} onClick={next} aria-label="Next photo">
                Next <span aria-hidden="true">›</span>
              </button>
            </>
          )}
          <button type="button" className="btn btn-ghost slide-exit" onClick={onExit}>
            Exit
          </button>
        </div>
      </header>

      <div className="slide-stage">
        {message ? (
          <p className="slideshow-message">{message}</p>
        ) : (
          current && (
            <img
              className="slide-image"
              key={slideKey}
              src={current.imageUrl}
              alt={current.caption || current.name}
              data-testid="slide-image"
            />
          )
        )}
      </div>

      {/* Bottom of the window: caption and duration bar, with no box around them. */}
      {current && (
        <footer className="slide-bottom" data-testid="slide-bottom">
          {current.caption && (
            <p className="slide-caption" data-testid="slide-caption">
              {current.caption}
            </p>
          )}
          <div className="slide-progress-track" aria-hidden="true" data-testid="duration-bar">
            {!waitsForNext && (
              <div
                className="slide-progress"
                key={`p-${slideKey}`}
                style={{ animationDuration: `${current.seconds}s`, animationPlayState: paused ? 'paused' : 'running' }}
              />
            )}
          </div>
        </footer>
      )}
    </div>
  );
}
