import { vi } from 'vitest';
import { ApiError, api, type FolderListing } from '../api';

/** A small folder tree served by a mocked api.folders(). */
export const folderTree: Record<string, FolderListing> = {
  '/photos': { path: '/photos', parent: '', folders: ['family', 'trip'], images: 0 },
  '/photos/trip': { path: '/photos/trip', parent: '/photos', folders: [], images: 2 },
  '/photos/family': { path: '/photos/family', parent: '/photos', folders: [], images: 1 },
  '/photos/empty': { path: '/photos/empty', parent: '/photos', folders: [], images: 0 },
};

export function mockFolders() {
  return vi.spyOn(api, 'folders').mockImplementation(async (path = '') => {
    const listing = folderTree[path.replace(/\/+$/, '') || '/photos'];
    if (!listing) throw new ApiError(`folder ${path} not found`, 400);
    return listing;
  });
}
