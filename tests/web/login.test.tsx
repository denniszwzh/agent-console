// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SessionSummary } from '../../src/shared/types.js';
import { App } from '../../src/web/App.js';

const sessions: SessionSummary[] = [{ sessionId: 's1', agent: 'claude', cwd: 'C:/a', lastActivity: '2026-11-16T05:00:00.000Z', title: 'one' }];

class FakeEventSource {
  static all: FakeEventSource[] = [];
  onmessage: ((m: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.all.push(this);
  }
  close() {
    this.closed = true;
  }
}

interface Server {
  signedIn: boolean;
  login: () => { status: number; body?: unknown };
  calls: string[];
}
let server: Server;

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' } });

/** A password-mode external entry backed by `server`. */
const passwordEntry = () =>
  vi.fn(async (url: string, init?: RequestInit) => {
    server.calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url === '/auth/mode') return json(200, { mode: 'password', signedIn: server.signedIn });
    if (url === '/auth/login') {
      const r = server.login();
      if (r.status === 204) server.signedIn = true;
      return json(r.status, r.body);
    }
    if (url === '/auth/logout') {
      server.signedIn = false;
      return json(204);
    }
    if (url.startsWith('/api/')) {
      if (!server.signedIn) return json(401, { error: 'Not signed in' });
      if (url === '/api/sessions') return json(200, sessions);
      return json(200, []);
    }
    return json(404, { error: 'not found' });
  });

/** A token-mode local entry; `signedIn` decides whether /api answers. */
const tokenEntry = (signedIn: boolean) =>
  vi.fn(async (url: string) => {
    if (url === '/auth/mode') return json(200, { mode: 'token' });
    if (!signedIn) return json(401, { error: 'Unauthorized' });
    return json(200, url === '/api/sessions' ? sessions : []);
  });

beforeAll(() => {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  FakeEventSource.all = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  server = { signedIn: false, login: () => ({ status: 204 }), calls: [] };
  vi.stubGlobal('fetch', passwordEntry());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const typeCredentials = (user: string, pass: string) => {
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: user } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: pass } });
};
const firstSession = () => document.querySelector('.session-project')?.textContent;

describe('sign-in screen', () => {
  it('token mode keeps the existing not-signed-in message', async () => {
    vi.stubGlobal('fetch', tokenEntry(false));
    render(<App />);
    expect(await screen.findByText('Not signed in')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
  });

  it('password mode shows the login form', async () => {
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(screen.getByLabelText('Username').getAttribute('autocomplete')).toBe('username');
    expect(screen.getByLabelText('Password').getAttribute('autocomplete')).toBe('current-password');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });

  it('a successful login loads the panel without a reload', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: 'Sign in' });
    typeCredentials('me', 'correct horse battery');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(firstSession()).toBe('one'));
    expect(screen.queryByRole('heading', { name: 'Sign in' })).toBeNull();
    // A fresh event subscription is open after the login.
    expect(FakeEventSource.all.some((s) => !s.closed)).toBe(true);
  });

  it('a wrong password shows "Wrong username or password"', async () => {
    server.login = () => ({ status: 401, body: { error: 'Wrong username or password' } });
    render(<App />);
    await screen.findByRole('heading', { name: 'Sign in' });
    typeCredentials('me', 'nope');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Wrong username or password');
    expect((screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a 429 shows how many minutes to wait', async () => {
    server.login = () => ({ status: 429, body: { error: 'Too many failed sign-ins. Try again in 15 minute(s).', retryAfterSec: 900 } });
    render(<App />);
    await screen.findByRole('heading', { name: 'Sign in' });
    typeCredentials('me', 'nope');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toContain('15 minute(s)');
  });

  it('Sign out appears only in password mode and returns to the login form', async () => {
    server.signedIn = true;
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(server.calls).toContain('POST /auth/logout');
    cleanup();

    vi.stubGlobal('fetch', tokenEntry(true));
    render(<App />);
    await waitFor(() => expect(firstSession()).toBe('one'));
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });

  it('an auth.revoked event shows the login form', async () => {
    server.signedIn = true;
    render(<App />);
    await waitFor(() => expect(firstSession()).toBe('one'));
    const source = FakeEventSource.all.find((s) => !s.closed)!;
    server.signedIn = false;
    source.onmessage?.({ data: JSON.stringify({ type: 'auth.revoked' }) });
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(source.closed).toBe(true);
  });
});
