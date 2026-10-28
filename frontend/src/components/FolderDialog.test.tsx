import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { mockFolders } from '../test/fakeFolders';
import { FolderDialog } from './FolderDialog';

beforeEach(() => {
  mockFolders();
});

function setup(start = '/photos') {
  const onChoose = vi.fn();
  const onCancel = vi.fn();
  render(<FolderDialog start={start} onChoose={onChoose} onCancel={onCancel} />);
  return { onChoose, onCancel, dialog: screen.getByRole('dialog', { name: 'Select a folder to scan' }) };
}

describe('FolderDialog', () => {
  it('opens as a modal at the start folder and lists its sub-folders', async () => {
    const { dialog } = setup();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const list = await within(dialog).findByRole('list', { name: 'Sub-folders' });
    expect(within(list).getAllByRole('button').map((b) => b.textContent)).toEqual(['family', 'trip']);
    expect(within(dialog).getByLabelText('Folder path')).toHaveValue('/photos');
    expect(within(dialog).getByText('No photos directly in this folder')).toBeInTheDocument();
    expect(api.folders).toHaveBeenCalledWith('/photos');
  });

  it('navigates into a folder, back up, and chooses', async () => {
    const { onChoose } = setup();
    await userEvent.click(await screen.findByRole('button', { name: 'trip' }));
    expect(await screen.findByText('2 photos in this folder')).toBeInTheDocument();
    expect(screen.getByLabelText('Folder path')).toHaveValue('/photos/trip');

    await userEvent.click(screen.getByRole('button', { name: 'Up one folder' }));
    await screen.findByRole('button', { name: 'family' });
    await userEvent.click(screen.getByRole('button', { name: 'family' }));
    await screen.findByText('1 photo in this folder');

    await userEvent.click(screen.getByRole('button', { name: 'Scan this folder' }));
    expect(onChoose).toHaveBeenCalledWith('/photos/family');
  });

  it('double-clicking a folder chooses it directly', async () => {
    const { onChoose } = setup();
    fireEvent.doubleClick(await screen.findByRole('button', { name: 'trip' }));
    expect(onChoose).toHaveBeenCalledWith('/photos/trip');
  });

  it('jumps to a typed path', async () => {
    setup();
    const input = await screen.findByLabelText('Folder path');
    await screen.findByRole('button', { name: 'trip' });
    await userEvent.clear(input);
    await userEvent.type(input, '/photos/trip{Enter}');
    expect(await screen.findByText('2 photos in this folder')).toBeInTheDocument();
  });

  it('shows an error for a folder that does not exist and disables Scan', async () => {
    setup('/nowhere');
    expect(await screen.findByText('folder /nowhere not found')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Scan this folder' })).toBeDisabled();
  });

  it('cancels with Escape, the Cancel button, the close button and the backdrop', async () => {
    const { onCancel, dialog } = setup();
    await screen.findByRole('button', { name: 'trip' });
    fireEvent.keyDown(window, { key: 'Escape' });
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.mouseDown(dialog.parentElement!); // backdrop
    fireEvent.mouseDown(dialog); // inside: ignored
    expect(onCancel).toHaveBeenCalledTimes(4);
  });

  it('warns that scanning clears the current selections', async () => {
    render(<FolderDialog start="/photos" selectedCount={1} onChoose={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('note')).toHaveTextContent(
      'Scanning clears your current selections (1 photo), including their seconds and captions.',
    );
  });
});
