import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, clampSeconds, thumbUrl } from './api';

function mockFetch(status: number, body?: unknown) {
  const fn = vi.fn().mockResolvedValue(
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('api client', () => {
  it('posts the folder to scan and returns the list', async () => {
    const fetch = mockFetch(200, { folder: '/photos/trip', photos: [] });
    const list = await api.scan('/photos/trip');
    expect(list.folder).toBe('/photos/trip');
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('/api/scan');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({ folder: '/photos/trip' });
  });

  it('PUTs selection options for a photo', async () => {
    const fetch = mockFetch(200, { id: 'abc' });
    await api.select('abc', { seconds: 7, caption: 'Hi' });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('/api/selections/abc');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ seconds: 7, caption: 'Hi' });
  });

  it('DELETEs all selections for Unselect all', async () => {
    const fetch = mockFetch(200, { deleted: 3 });
    await expect(api.unselectAll()).resolves.toEqual({ deleted: 3 });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('/api/selections');
    expect(init.method).toBe('DELETE');
  });

  it('handles 204 No Content on unselect', async () => {
    const fetch = mockFetch(204);
    await expect(api.unselect('abc')).resolves.toBeUndefined();
    expect(fetch.mock.calls[0][1].method).toBe('DELETE');
  });

  it('encodes the folder browser path', async () => {
    const fetch = mockFetch(200, { path: '/a b', parent: '', folders: [] });
    await api.folders('/a b');
    expect(fetch.mock.calls[0][0]).toBe('/api/folders?path=%2Fa%20b');
  });

  it('surfaces the server error message', async () => {
    mockFetch(400, { error: 'folder /nope not found' });
    const err = await api.scan('/nope').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe('folder /nope not found');
    expect(err.status).toBe(400);
  });

  it('falls back to the HTTP status when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('oops', { status: 502, statusText: 'Bad Gateway' })));
    await expect(api.photos()).rejects.toThrow('502 Bad Gateway');
  });
});

describe('helpers', () => {
  it('builds thumbnail URLs', () => {
    expect(thumbUrl('abc')).toBe('/api/photos/abc/thumb');
  });

  it.each([
    [0, 0],
    [-3, 0],
    [2.6, 3],
    [10, 10],
    [99999, 3600],
    [Number.NaN, 5],
  ])('clampSeconds(%s) = %s', (input, expected) => {
    expect(clampSeconds(input)).toBe(expected);
  });
});
