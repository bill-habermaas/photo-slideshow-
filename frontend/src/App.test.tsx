import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App, { SAVE_DEBOUNCE_MS } from './App';
import { ApiError, api, type Photo, type PhotoList } from './api';
import { mockFolders } from './test/fakeFolders';

const photo = (id: string, over: Partial<Photo> = {}): Photo => ({
  id,
  name: `${id}.jpg`,
  path: `${id}.jpg`,
  selected: false,
  seconds: 5,
  caption: '',
  ...over,
});

const list = (photos: Photo[], folder = '/photos/trip'): PhotoList => ({ folder, photos });

beforeEach(() => {
  vi.spyOn(api, 'config').mockResolvedValue({ root: '/photos', defaultFolder: '/photos', folder: '' });
  vi.spyOn(api, 'photos').mockResolvedValue(list([]));
  vi.spyOn(api, 'scan').mockResolvedValue(list([photo('a'), photo('b')]));
  vi.spyOn(api, 'select').mockResolvedValue({} as never);
  vi.spyOn(api, 'unselect').mockResolvedValue(undefined);
  vi.spyOn(api, 'unselectAll').mockResolvedValue({ deleted: 0 });
  vi.spyOn(api, 'selections').mockResolvedValue([]);
  mockFolders();
});

/** Pick a folder in the directory dialog (opening it with Scan… if needed). */
async function chooseFolder(folder = '/photos/trip') {
  if (!screen.queryByRole('dialog')) {
    await userEvent.click(await screen.findByRole('button', { name: 'Scan…' }));
  }
  const dialog = await screen.findByRole('dialog', { name: 'Select a folder to scan' });
  const path = within(dialog).getByLabelText('Folder path');
  await within(dialog).findByRole('list', { name: 'Sub-folders' });
  await userEvent.clear(path);
  await userEvent.type(path, `${folder}{Enter}`);
  await waitFor(() => expect(path).toHaveValue(folder));
  await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Scan this folder' })).toBeEnabled());
  await userEvent.click(within(dialog).getByRole('button', { name: 'Scan this folder' }));
}

async function scanFolder(folder = '/photos/trip') {
  await chooseFolder(folder);
  await screen.findByRole('list', { name: 'Photos' });
}

const row = (id: string) => screen.getByTestId(`photo-${id}`);

describe('App', () => {
  it('starts on the folder screen with the directory dialog open', async () => {
    render(<App />);
    expect(await screen.findByLabelText('Photo folder')).toHaveValue('/photos');
    expect(screen.getByRole('heading', { name: /pick a folder/i })).toBeInTheDocument();
    const dialog = screen.getByRole('dialog', { name: 'Select a folder to scan' });
    expect(await within(dialog).findByRole('button', { name: 'trip' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /display/i })).not.toBeInTheDocument();
    expect(api.scan).not.toHaveBeenCalled();
  });

  it('can browse to a folder in the dialog and scan it', async () => {
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'family' }));
    await screen.findByText('1 photo in this folder');
    await userEvent.click(screen.getByRole('button', { name: 'Scan this folder' }));
    expect(api.scan).toHaveBeenCalledWith('/photos/family');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('scans the entered folder and lists the photos', async () => {
    render(<App />);
    await scanFolder('/photos/trip');
    expect(api.scan).toHaveBeenCalledWith('/photos/trip');
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(screen.getByText('0 of 2 selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /display/i })).toBeDisabled();
  });

  it('restores the previously scanned folder on load', async () => {
    vi.mocked(api.config).mockResolvedValue({ root: '/photos', defaultFolder: '/photos', folder: '/photos/old' });
    vi.mocked(api.photos).mockResolvedValue(list([photo('x', { selected: true })], '/photos/old'));
    render(<App />);
    expect(await screen.findByRole('list', { name: 'Photos' })).toBeInTheDocument();
    expect(screen.getByLabelText('Photo folder')).toHaveValue('/photos/old');
    expect(screen.getByRole('button', { name: /display/i })).toBeEnabled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); // no dialog when restoring
  });

  it('shows scan errors from the server', async () => {
    vi.mocked(api.scan).mockRejectedValue(new ApiError('permission denied', 500));
    render(<App />);
    await chooseFolder('/photos/trip');
    expect(await screen.findByRole('alert')).toHaveTextContent('permission denied');
  });

  it('re-opens the dialog from Scan… to switch folders', async () => {
    render(<App />);
    await scanFolder('/photos/trip');
    vi.mocked(api.scan).mockResolvedValue(list([photo('c')], '/photos/family'));
    await scanFolder('/photos/family');
    expect(api.scan).toHaveBeenLastCalledWith('/photos/family');
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  });

  it('selecting a photo stores it with its options; unselecting removes it', async () => {
    render(<App />);
    await scanFolder();
    const checkbox = within(row('a')).getByRole('checkbox');

    await userEvent.click(checkbox);
    expect(api.select).toHaveBeenCalledWith('a', { seconds: 5, caption: '' });
    expect(checkbox).toBeChecked();
    expect(await within(row('a')).findByText('Saved')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /display/i })).toBeEnabled();

    await userEvent.click(checkbox);
    expect(api.unselect).toHaveBeenCalledWith('a');
    expect(checkbox).not.toBeChecked();
  });

  it('options set before selecting are sent with the selection', async () => {
    render(<App />);
    await scanFolder();
    fireEvent.change(within(row('b')).getByLabelText(/seconds/i), { target: { value: '9' } });
    fireEvent.change(within(row('b')).getByLabelText(/caption/i), { target: { value: 'Hello' } });
    expect(api.select).not.toHaveBeenCalled(); // not selected yet, nothing to save
    await userEvent.click(within(row('b')).getByRole('checkbox'));
    expect(api.select).toHaveBeenCalledWith('b', { seconds: 9, caption: 'Hello' });
  });

  it('reverts the checkmark when saving fails', async () => {
    vi.mocked(api.select).mockRejectedValue(new Error('cannot decode image'));
    render(<App />);
    await scanFolder();
    const checkbox = within(row('a')).getByRole('checkbox');
    await userEvent.click(checkbox);
    await waitFor(() => expect(checkbox).not.toBeChecked());
    expect(screen.getByRole('alert')).toHaveTextContent('a.jpg: cannot decode image');
  });

  it('debounces option edits on a selected photo', async () => {
    vi.mocked(api.scan).mockResolvedValue(list([photo('a', { selected: true })]));
    render(<App />);
    await scanFolder();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const caption = within(row('a')).getByLabelText(/caption/i);
      fireEvent.change(caption, { target: { value: 'H' } });
      fireEvent.change(caption, { target: { value: 'Hi' } });
      fireEvent.change(caption, { target: { value: 'Hi!' } });
      expect(api.select).not.toHaveBeenCalled();
      await act(async () => vi.advanceTimersByTime(SAVE_DEBOUNCE_MS));
      expect(api.select).toHaveBeenCalledTimes(1);
      expect(api.select).toHaveBeenCalledWith('a', { seconds: 5, caption: 'Hi!' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('Display saves pending edits, then plays the selections from the server', async () => {
    vi.mocked(api.scan).mockResolvedValue(list([photo('a', { selected: true })]));
    vi.mocked(api.selections).mockResolvedValue([
      { id: 'a', name: 'a.jpg', path: '/photos/a.jpg', seconds: 7, caption: 'Now', width: 1, height: 1, imageUrl: '/img/a' },
    ]);
    render(<App />);
    await scanFolder();
    fireEvent.change(within(row('a')).getByLabelText(/seconds/i), { target: { value: '7' } });
    await userEvent.click(screen.getByRole('button', { name: /display/i }));

    expect(api.select).toHaveBeenCalledWith('a', { seconds: 7, caption: '' }); // flushed immediately
    expect(await screen.findByTestId('slideshow')).toBeInTheDocument();
    expect(await screen.findByText('Now')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Exit' }));
    expect(screen.queryByTestId('slideshow')).not.toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Photos' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); // regression: dialog must not re-open
  });

  it('drops a photo whose file is missing once it is unselected', async () => {
    vi.mocked(api.scan).mockResolvedValue(list([photo('a'), photo('old', { selected: true, elsewhere: true })]));
    render(<App />);
    await scanFolder();
    await userEvent.click(within(row('old')).getByRole('checkbox'));
    await waitFor(() => expect(screen.queryByTestId('photo-old')).not.toBeInTheDocument());
  });

  it('says so when a folder has no photos', async () => {
    vi.mocked(api.scan).mockResolvedValue(list([], '/photos/empty'));
    render(<App />);
    await chooseFolder('/photos/empty');
    expect(await screen.findByText(/no photos found/i)).toBeInTheDocument();
  });

  describe('Unselect all', () => {
    it('turns every selection off with one click and keeps typed options', async () => {
      vi.mocked(api.scan).mockResolvedValue(
        list([photo('a', { selected: true, seconds: 9, caption: 'Keep me' }), photo('b', { selected: true }), photo('c')]),
      );
      render(<App />);
      await scanFolder();
      expect(screen.getByText('2 of 3 selected')).toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: 'Unselect all' }));
      expect(api.unselectAll).toHaveBeenCalledOnce();
      await waitFor(() => expect(screen.getByText('0 of 3 selected')).toBeInTheDocument());
      for (const box of screen.getAllByRole('checkbox')) expect(box).not.toBeChecked();
      expect(screen.getByRole('button', { name: /display/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Unselect all' })).toBeDisabled();
      // Seconds and caption stay in the row, ready if the photo is ticked again.
      expect(within(row('a')).getByLabelText(/caption/i)).toHaveValue('Keep me');
      expect(within(row('a')).getByLabelText(/seconds/i)).toHaveValue(9);
    });

    it('is disabled when nothing is selected', async () => {
      render(<App />);
      await scanFolder();
      expect(screen.getByRole('button', { name: 'Unselect all' })).toBeDisabled();
    });

    it('drops a pending option save so it cannot re-select the photo', async () => {
      vi.mocked(api.scan).mockResolvedValue(list([photo('a', { selected: true })]));
      render(<App />);
      await scanFolder();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        fireEvent.change(within(row('a')).getByLabelText(/caption/i), { target: { value: 'late' } });
        fireEvent.click(screen.getByRole('button', { name: 'Unselect all' }));
        await act(async () => vi.advanceTimersByTime(SAVE_DEBOUNCE_MS * 4));
        expect(api.select).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('shows an error and leaves the selections if the server fails', async () => {
      vi.mocked(api.scan).mockResolvedValue(list([photo('a', { selected: true })]));
      vi.mocked(api.unselectAll).mockRejectedValue(new Error('db down'));
      render(<App />);
      await scanFolder();
      await userEvent.click(screen.getByRole('button', { name: 'Unselect all' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t unselect all: db down');
      expect(within(row('a')).getByRole('checkbox')).toBeChecked();
    });

    it('removes rows for deleted files, which only existed as selections', async () => {
      vi.mocked(api.scan).mockResolvedValue(list([photo('a', { selected: true }), photo('gone', { selected: true, elsewhere: true })]));
      render(<App />);
      await scanFolder();
      await userEvent.click(screen.getByRole('button', { name: 'Unselect all' }));
      await waitFor(() => expect(screen.queryByTestId('photo-gone')).not.toBeInTheDocument());
      expect(row('a')).toBeInTheDocument();
    });
  });

  describe('rescanning', () => {
    it('warns in the folder dialog that scanning clears the current selections', async () => {
      vi.mocked(api.scan).mockResolvedValue(list([photo('a', { selected: true }), photo('b', { selected: true })]));
      render(<App />);
      await scanFolder();
      await userEvent.click(screen.getByRole('button', { name: 'Scan…' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByRole('note')).toHaveTextContent('Scanning clears your current selections (2 photos)');
    });

    it('shows no warning when nothing is selected', async () => {
      render(<App />);
      await scanFolder();
      await userEvent.click(screen.getByRole('button', { name: 'Scan…' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).queryByRole('note')).toBeNull();
    });

    it('shows the cleared list the server returns after a rescan', async () => {
      vi.mocked(api.scan).mockResolvedValue(list([photo('a', { selected: true, caption: 'Old' })]));
      render(<App />);
      await scanFolder();
      vi.mocked(api.scan).mockResolvedValue(list([photo('a')]));
      await scanFolder();
      expect(within(row('a')).getByRole('checkbox')).not.toBeChecked();
      expect(within(row('a')).getByLabelText(/caption/i)).toHaveValue('');
      expect(screen.getByText('0 of 1 selected')).toBeInTheDocument();
    });

    it('drops a pending option save so it cannot re-create a selection after the scan', async () => {
      vi.mocked(api.scan).mockResolvedValue(list([photo('a', { selected: true })]));
      render(<App />);
      await scanFolder();
      fireEvent.change(within(row('a')).getByLabelText(/caption/i), { target: { value: 'typed just before scanning' } });
      vi.mocked(api.scan).mockResolvedValue(list([photo('a')]));
      await scanFolder();
      await new Promise((r) => setTimeout(r, SAVE_DEBOUNCE_MS + 100));
      expect(api.select).not.toHaveBeenCalled();
    });
  });
});
