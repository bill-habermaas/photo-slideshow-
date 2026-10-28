import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Photo } from '../api';
import { PhotoRow } from './PhotoRow';

const photo = (over: Partial<Photo> = {}): Photo => ({
  id: 'p1',
  name: 'beach.jpg',
  path: '2024/beach.jpg',
  selected: false,
  seconds: 5,
  caption: '',
  ...over,
});

function setup(p: Photo = photo(), saveState?: 'saving' | 'saved' | 'error') {
  const onToggle = vi.fn();
  const onOptions = vi.fn();
  render(
    <ul>
      <PhotoRow photo={p} saveState={saveState} onToggle={onToggle} onOptions={onOptions} />
    </ul>,
  );
  return { onToggle, onOptions };
}

describe('PhotoRow', () => {
  it('shows the thumbnail, name and relative path', () => {
    setup();
    expect(screen.getByRole('img', { name: 'beach.jpg' })).toHaveAttribute('src', '/api/photos/p1/thumb');
    expect(screen.getByText('beach.jpg')).toBeInTheDocument();
    expect(screen.getByText('2024/beach.jpg')).toBeInTheDocument();
  });

  it('reflects and toggles the checkmark', async () => {
    const { onToggle } = setup();
    const box = screen.getByRole('checkbox', { name: /show beach.jpg/i });
    expect(box).not.toBeChecked();
    await userEvent.click(box);
    expect(onToggle).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }), true);
  });

  it('unchecks a selected photo', async () => {
    const { onToggle } = setup(photo({ selected: true }));
    const box = screen.getByRole('checkbox');
    expect(box).toBeChecked();
    await userEvent.click(box);
    expect(onToggle).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }), false);
  });

  it('reports a new number of seconds', () => {
    const { onOptions } = setup(photo({ caption: 'Sun' }));
    fireEvent.change(screen.getByLabelText(/seconds to show/i), { target: { value: '12' } });
    expect(onOptions).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }), { seconds: 12, caption: 'Sun' });
  });

  it('clamps seconds to the allowed range', () => {
    const { onOptions } = setup();
    fireEvent.change(screen.getByLabelText(/seconds to show/i), { target: { value: '50000' } });
    expect(onOptions).toHaveBeenCalledWith(expect.anything(), { seconds: 3600, caption: '' });
  });

  it('accepts 0 seconds (wait for Next) and says so', () => {
    const { onOptions } = setup();
    fireEvent.change(screen.getByLabelText(/seconds to show/i), { target: { value: '0' } });
    expect(onOptions).toHaveBeenCalledWith(expect.anything(), { seconds: 0, caption: '' });
  });

  it('shows the wait-for-Next hint for a 0-second photo', () => {
    setup(photo({ seconds: 0 }));
    expect(screen.getByText('Waits for Next')).toBeInTheDocument();
  });

  it('ignores empty or negative seconds while typing and restores on blur', () => {
    const { onOptions } = setup();
    const input = screen.getByLabelText(/seconds to show/i);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.change(input, { target: { value: '-2' } });
    expect(onOptions).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(input).toHaveValue(5);
  });

  it('reports caption edits', () => {
    const { onOptions } = setup();
    fireEvent.change(screen.getByLabelText(/caption for/i), { target: { value: 'Golden hour' } });
    expect(onOptions).toHaveBeenCalledWith(expect.anything(), { seconds: 5, caption: 'Golden hour' });
  });

  it('shows the save state and the file-missing tag', () => {
    setup(photo({ selected: true, elsewhere: true }), 'error');
    expect(screen.getByText('Not saved')).toBeInTheDocument();
    expect(screen.getByText(/file missing/i)).toBeInTheDocument();
  });
});
