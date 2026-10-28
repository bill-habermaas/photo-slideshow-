import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { mockFolders } from '../test/fakeFolders';
import { FolderPicker } from './FolderPicker';

beforeEach(() => {
  mockFolders();
});

describe('FolderPicker', () => {
  it('opens the directory dialog automatically on first start', async () => {
    render(<FolderPicker initialFolder="/photos" root="/photos" scanning={false} autoOpen onScan={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Select a folder to scan' })).toBeInTheDocument();
    await screen.findByRole('button', { name: 'trip' });
  });

  it('does not open the dialog until Scan is pressed otherwise', () => {
    render(<FolderPicker initialFolder="/photos" root="/photos" scanning={false} onScan={vi.fn()} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('Scan opens the dialog at the typed path; choosing a folder scans it', async () => {
    const onScan = vi.fn();
    render(<FolderPicker initialFolder="/photos" root="/photos" scanning={false} onScan={onScan} />);
    const input = screen.getByLabelText('Photo folder');
    await userEvent.type(input, '/trip');
    await userEvent.click(screen.getByRole('button', { name: 'Scan…' }));

    expect(api.folders).toHaveBeenCalledWith('/photos/trip');
    await screen.findByText('2 photos in this folder');
    expect(onScan).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Scan this folder' }));

    expect(onScan).toHaveBeenCalledWith('/photos/trip');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(input).toHaveValue('/photos/trip');
  });

  it('pressing Enter in the path field also opens the dialog', async () => {
    render(<FolderPicker initialFolder="/photos" root="/photos" scanning={false} onScan={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Photo folder'), '{Enter}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await screen.findByRole('button', { name: 'trip' });
  });

  it('cancelling the dialog does not scan', async () => {
    const onScan = vi.fn();
    render(<FolderPicker initialFolder="/photos" root="/photos" scanning={false} autoOpen onScan={onScan} />);
    await screen.findByRole('button', { name: 'trip' });
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onScan).not.toHaveBeenCalled();
  });

  it('disables Scan while a scan is running', () => {
    render(<FolderPicker initialFolder="/x" root="" scanning onScan={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Scanning…' })).toBeDisabled();
  });

  describe('mount hint', () => {
    it('shows which folder on the computer is mounted', () => {
      render(<FolderPicker initialFolder="/photos" root="/photos" hostRoot="/Users/bill/Pictures" scanning={false} onScan={vi.fn()} />);
      expect(screen.getByTestId('mount-hint')).toHaveTextContent('/photos is /Users/bill/Pictures on your computer.');
    });

    it('explains how to change it when the sample project folder is mounted', () => {
      render(<FolderPicker initialFolder="/photos" root="/photos" hostRoot="./photos" scanning={false} onScan={vi.fn()} />);
      const hint = screen.getByTestId('mount-hint');
      expect(hint).toHaveTextContent('/photos is ./photos on your computer (the project’s sample folder)');
      expect(hint).toHaveTextContent('set PHOTOS_DIR in .env to a full path and run docker compose up -d');
    });

    it('recognises Windows and ~ paths as full paths', () => {
      const { rerender } = render(
        <FolderPicker initialFolder="/photos" root="/photos" hostRoot="C:/Users/bill/Pictures" scanning={false} onScan={vi.fn()} />,
      );
      expect(screen.getByTestId('mount-hint')).not.toHaveTextContent('sample folder');
      rerender(<FolderPicker initialFolder="/photos" root="/photos" hostRoot="~/Pictures" scanning={false} onScan={vi.fn()} />);
      expect(screen.getByTestId('mount-hint')).not.toHaveTextContent('sample folder');
    });

    it('when running locally (no container) shows the folder being scanned', () => {
      render(<FolderPicker initialFolder="/Users/bill/Pictures" root="/Users/bill/Pictures" hostRoot="/Users/bill/Pictures" scanning={false} onScan={vi.fn()} />);
      expect(screen.getByTestId('mount-hint')).toHaveTextContent('Scanning /Users/bill/Pictures. Set PHOTOS_DIR in .env');
    });
  });
});
