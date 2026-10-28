import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type Selection } from '../api';
import { Slideshow } from './Slideshow';

const sel = (id: string, seconds: number, caption = ''): Selection => ({
  id,
  name: `${id}.jpg`,
  path: `/photos/${id}.jpg`,
  seconds,
  caption,
  width: 800,
  height: 600,
  imageUrl: `/api/selections/${id}/image`,
});

const top = () => screen.getByTestId('slide-top');
const bottom = () => screen.getByTestId('slide-bottom');
const shownImage = () => screen.queryByTestId('slide-image')?.getAttribute('src');
const nextButton = () => within(top()).getByRole('button', { name: 'Next photo' });
const prevButton = () => within(top()).getByRole('button', { name: 'Previous photo' });

async function renderShow(slides: Selection[]) {
  vi.spyOn(api, 'selections').mockResolvedValue(slides);
  const onExit = vi.fn();
  render(<Slideshow onExit={onExit} />);
  await act(async () => {}); // let the selections promise resolve
  return { onExit };
}

const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
afterEach(() => vi.useRealTimers());

describe('Slideshow', () => {
  it('loads the selections from the API and shows the first photo', async () => {
    await renderShow([sel('a', 3, 'First'), sel('b', 2)]);
    expect(api.selections).toHaveBeenCalledOnce();
    expect(shownImage()).toBe('/api/selections/a/image');
    expect(within(top()).getByText('1 / 2')).toBeInTheDocument();
  });

  it('has no frame: no box or band around the photo or the caption', async () => {
    await renderShow([sel('a', 3, 'Cap')]);
    const show = screen.getByTestId('slideshow');
    expect(show.querySelector('figure, .slide-frame, .slide-bar')).toBeNull();
    expect(top()).not.toContainElement(screen.getByTestId('slide-image'));
    expect(bottom()).not.toContainElement(screen.getByTestId('slide-image'));
  });

  it('puts Previous, Next and Exit together at the top of the window, above the photo', async () => {
    await renderShow([sel('a', 3, 'Cap'), sel('b', 3)]);
    const show = screen.getByTestId('slideshow');
    expect(show.firstElementChild).toBe(top());
    const exit = within(top()).getByRole('button', { name: 'Exit' });
    expect(prevButton().parentElement).toBe(exit.parentElement);
    expect(prevButton().nextElementSibling).toBe(nextButton());
    const follows = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(nextButton(), screen.getByTestId('slide-image'))).toBe(true);
    expect(within(bottom()).queryByRole('button')).toBeNull();
  });

  it('keeps the caption and duration bar at the bottom, below the photo', async () => {
    await renderShow([sel('a', 3, 'Sunset over the bay')]);
    const show = screen.getByTestId('slideshow');
    expect(show.lastElementChild).toBe(bottom());
    const caption = screen.getByTestId('slide-caption');
    const duration = screen.getByTestId('duration-bar');
    expect(caption).toHaveTextContent('Sunset over the bay');
    expect(bottom()).toContainElement(caption);
    expect(bottom()).toContainElement(duration);
    expect(caption.compareDocumentPosition(duration) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('omits the caption when none is set', async () => {
    await renderShow([sel('a', 3)]);
    expect(screen.queryByTestId('slide-caption')).toBeNull();
    expect(screen.getByTestId('duration-bar')).toBeInTheDocument();
  });

  it('places Previous immediately before Next', async () => {
    await renderShow([sel('a', 3), sel('b', 3)]);
    expect(prevButton().nextElementSibling).toBe(nextButton());
    expect(prevButton()).toHaveTextContent('Previous');
    expect(nextButton()).toHaveTextContent('Next');
  });

  it('shows each photo for its own number of seconds, then loops', async () => {
    await renderShow([sel('a', 3), sel('b', 2)]);
    advance(2999);
    expect(shownImage()).toBe('/api/selections/a/image');
    advance(1);
    expect(shownImage()).toBe('/api/selections/b/image');
    advance(1999);
    expect(shownImage()).toBe('/api/selections/b/image');
    advance(1);
    expect(shownImage()).toBe('/api/selections/a/image');
  });

  describe('0 seconds', () => {
    it('stays on the photo and does not advance by itself', async () => {
      await renderShow([sel('a', 0, 'Read me'), sel('b', 2)]);
      advance(60 * 60 * 1000); // an hour
      expect(shownImage()).toBe('/api/selections/a/image');
      expect(within(top()).getByText('Press Next to continue')).toBeInTheDocument();
    });

    it('continues to the next photo when Next is pressed', async () => {
      await renderShow([sel('a', 0), sel('b', 2)]);
      fireEvent.click(nextButton());
      expect(shownImage()).toBe('/api/selections/b/image');
      // b has a duration, so it advances by itself again.
      advance(2000);
      expect(shownImage()).toBe('/api/selections/a/image');
      advance(10_000);
      expect(shownImage()).toBe('/api/selections/a/image'); // waits again
    });

    it('a timed photo hands over to a 0-second photo, which then waits', async () => {
      await renderShow([sel('a', 1), sel('b', 0)]);
      advance(1000);
      expect(shownImage()).toBe('/api/selections/b/image');
      advance(30_000);
      expect(shownImage()).toBe('/api/selections/b/image');
    });

    it('works when every photo is 0 seconds', async () => {
      await renderShow([sel('a', 0), sel('b', 0), sel('c', 0)]);
      fireEvent.click(nextButton());
      fireEvent.click(nextButton());
      expect(shownImage()).toBe('/api/selections/c/image');
      fireEvent.click(nextButton());
      expect(shownImage()).toBe('/api/selections/a/image'); // loops
    });

    it('hides the progress bar and disables Pause (nothing to pause)', async () => {
      await renderShow([sel('a', 0), sel('b', 3)]);
      expect(bottom().querySelector('.slide-progress')).toBeNull();
      expect(screen.getByRole('button', { name: 'Pause' })).toBeDisabled();
      fireEvent.click(nextButton());
      expect(bottom().querySelector('.slide-progress')).not.toBeNull();
      expect(screen.getByRole('button', { name: 'Pause' })).toBeEnabled();
    });
  });

  describe('Next button', () => {
    it('always goes to the next photo, even before the duration is up', async () => {
      await renderShow([sel('a', 30), sel('b', 30), sel('c', 30)]);
      advance(1000);
      fireEvent.click(nextButton());
      expect(shownImage()).toBe('/api/selections/b/image');
      fireEvent.click(nextButton());
      expect(shownImage()).toBe('/api/selections/c/image');
    });

    it('restarts the full duration of the photo it moves to', async () => {
      await renderShow([sel('a', 5), sel('b', 5)]);
      advance(4000);
      fireEvent.click(nextButton());
      advance(4999);
      expect(shownImage()).toBe('/api/selections/b/image');
      advance(1);
      expect(shownImage()).toBe('/api/selections/a/image');
    });

    it('works while paused', async () => {
      await renderShow([sel('a', 4), sel('b', 4)]);
      fireEvent.keyDown(window, { key: ' ' });
      fireEvent.click(nextButton());
      expect(shownImage()).toBe('/api/selections/b/image');
    });

    it('loops back to the first photo after the last', async () => {
      await renderShow([sel('a', 9), sel('b', 9)]);
      fireEvent.click(nextButton());
      fireEvent.click(nextButton());
      expect(shownImage()).toBe('/api/selections/a/image');
    });

    it('keeps cycling a single photo', async () => {
      await renderShow([sel('a', 1, 'Only')]);
      fireEvent.click(nextButton());
      advance(1000);
      expect(shownImage()).toBe('/api/selections/a/image');
      expect(within(top()).getByText('1 / 1')).toBeInTheDocument();
    });

    it('has keyboard focus, so Enter advances too', async () => {
      vi.useRealTimers();
      await renderShow([sel('a', 0), sel('b', 0)]);
      expect(nextButton()).toHaveFocus();
      await userEvent.keyboard('{Enter}');
      expect(shownImage()).toBe('/api/selections/b/image');
      expect(nextButton()).toHaveFocus();
    });
  });

  describe('Previous button', () => {
    it('goes back one photo, wrapping from the first to the last', async () => {
      await renderShow([sel('a', 9), sel('b', 9), sel('c', 9)]);
      fireEvent.click(prevButton());
      expect(shownImage()).toBe('/api/selections/c/image');
      fireEvent.click(prevButton());
      expect(shownImage()).toBe('/api/selections/b/image');
    });

    it('works regardless of duration, including 0-second photos', async () => {
      await renderShow([sel('a', 30), sel('b', 0)]);
      fireEvent.click(nextButton());
      expect(shownImage()).toBe('/api/selections/b/image');
      fireEvent.click(prevButton());
      expect(shownImage()).toBe('/api/selections/a/image');
    });

    it('restarts the full duration of the photo it goes back to', async () => {
      await renderShow([sel('a', 3), sel('b', 3)]);
      advance(2500);
      fireEvent.click(prevButton()); // -> b
      advance(2999);
      expect(shownImage()).toBe('/api/selections/b/image');
      advance(1);
      expect(shownImage()).toBe('/api/selections/a/image');
    });

    it('lands on a 0-second photo and waits there', async () => {
      await renderShow([sel('a', 0), sel('b', 2)]);
      fireEvent.click(nextButton());
      fireEvent.click(prevButton());
      advance(60_000);
      expect(shownImage()).toBe('/api/selections/a/image');
    });
  });

  it('pauses with Space and resumes with the remaining time', async () => {
    await renderShow([sel('a', 4), sel('b', 4)]);
    advance(3000);
    fireEvent.keyDown(window, { key: ' ' });
    expect(within(top()).getByText('Paused')).toBeInTheDocument();
    advance(10_000);
    expect(shownImage()).toBe('/api/selections/a/image');
    fireEvent.keyDown(window, { key: ' ' });
    advance(999);
    expect(shownImage()).toBe('/api/selections/a/image');
    advance(1);
    expect(shownImage()).toBe('/api/selections/b/image');
  });

  it('steps with the arrow keys', async () => {
    await renderShow([sel('a', 0), sel('b', 9), sel('c', 9)]);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(shownImage()).toBe('/api/selections/b/image');
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(shownImage()).toBe('/api/selections/c/image');
  });

  it('exits with Escape or the Exit button', async () => {
    const { onExit } = await renderShow([sel('a', 5)]);
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Exit' }));
    expect(onExit).toHaveBeenCalledTimes(2);
  });

  it('explains when nothing is selected', async () => {
    await renderShow([]);
    expect(screen.getByText(/no photos are selected/i)).toBeInTheDocument();
    expect(screen.queryByTestId('slide-image')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next photo' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Exit' })).toBeInTheDocument();
  });

  it('shows a load error', async () => {
    vi.spyOn(api, 'selections').mockRejectedValue(new Error('db down'));
    render(<Slideshow onExit={() => {}} />);
    await act(async () => {});
    expect(screen.getByText(/db down/)).toBeInTheDocument();
  });
});
