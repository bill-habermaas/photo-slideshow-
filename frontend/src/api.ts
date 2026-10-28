// Typed client for the Go API.

export interface Photo {
  id: string;
  name: string;
  /** Path relative to the scanned folder (absolute for photos from elsewhere). */
  path: string;
  selected: boolean;
  seconds: number;
  caption: string;
  /** Selected, but the file is no longer in the folder; still plays from the MongoDB cache. */
  elsewhere?: boolean;
}

export interface PhotoList {
  folder: string;
  photos: Photo[];
}

export interface AppConfig {
  root: string;
  /** Where `root` is on the user's computer (PHOTOS_DIR), e.g. /Users/me/Pictures. */
  hostRoot?: string;
  defaultFolder: string;
  folder: string;
}

export interface FolderListing {
  path: string;
  /** Parent folder, or "" at the top of the allowed photo root. */
  parent: string;
  folders: string[];
  /** Number of photos directly in this folder (the scan also includes sub-folders). */
  images: number;
}

export interface Selection {
  id: string;
  name: string;
  path: string;
  seconds: number;
  caption: string;
  width: number;
  height: number;
  imageUrl: string;
}

export interface PhotoOptions {
  seconds: number;
  caption: string;
}

/** 0 seconds = the photo stays up until Next is pressed. */
export const MIN_SECONDS = 0;
export const MAX_SECONDS = 3600;
export const DEFAULT_SECONDS = 5;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`.trim();
    try {
      const data = await res.json();
      if (data && typeof data.error === 'string') message = data.error;
    } catch {
      /* not JSON */
    }
    throw new ApiError(message, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  config: () => request<AppConfig>('GET', '/api/config'),
  folders: (path = '') => request<FolderListing>('GET', `/api/folders?path=${encodeURIComponent(path)}`),
  /** Scan a folder. This clears every document in MongoDB first (all selections). */
  scan: (folder: string) => request<PhotoList>('POST', '/api/scan', { folder }),
  photos: () => request<PhotoList>('GET', '/api/photos'),
  select: (id: string, options: PhotoOptions) =>
    request<Selection>('PUT', `/api/selections/${encodeURIComponent(id)}`, options),
  unselect: (id: string) => request<void>('DELETE', `/api/selections/${encodeURIComponent(id)}`),
  /** Turn every selection off. */
  unselectAll: () => request<{ deleted: number }>('DELETE', '/api/selections'),
  selections: () => request<Selection[]>('GET', '/api/selections'),
};

export const thumbUrl = (id: string) => `/api/photos/${encodeURIComponent(id)}/thumb`;

/** Clamp user input to a valid whole number of seconds (0 = wait for Next). */
export function clampSeconds(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SECONDS;
  return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Math.round(value)));
}
