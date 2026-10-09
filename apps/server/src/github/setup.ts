import { randomBytes } from 'node:crypto';
import type { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { html } from 'hono/html';
import type { Auth } from '../auth.js';
import { SESSION_COOKIE } from '../auth.js';
import type { Env } from '../http/app.js';
import { appCredentialsSchema } from './credentials.js';
import type { AppCredentialsStore } from './credentials.js';

const STATE_COOKIE = 'slop_github_setup';

/** Events and permissions from the spec's GitHub App section. */
export const appManifest = (publicUrl: string, name: string) => ({
  name,
  url: publicUrl,
  hook_attributes: { url: `${publicUrl}/webhooks/github`, active: true },
  redirect_url: `${publicUrl}/setup/github-app/callback`,
  // After installing, GitHub sends the person back to the board they started from.
  setup_url: `${publicUrl}/setup/github-app/installed`,
  setup_on_update: true,
  public: false,
  default_permissions: {
    metadata: 'read',
    contents: 'write',
    pull_requests: 'write',
    issues: 'write',
    checks: 'read',
    // Re-runs the failed jobs of a base check that broke in CI's setup (an existing installation must accept this).
    actions: 'write',
    statuses: 'read',
  },
  default_events: [
    'push',
    'pull_request',
    'pull_request_review',
    'pull_request_review_comment',
    'issue_comment',
    'check_run',
    'check_suite',
  ],
});

const page = (title: string, body: ReturnType<typeof html>) => html`<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${title}</title>
      <style>
        body { font: 15px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; }
        button, a.button { font: inherit; padding: 0.5rem 1rem; border-radius: 6px; border: 0; background: #222; color: #fff; text-decoration: none; cursor: pointer; }
        code { background: #eee; padding: 0 0.25rem; border-radius: 3px; }
        @media (prefers-color-scheme: dark) { body { background: #111; color: #eee; } code { background: #333; } button, a.button { background: #eee; color: #111; } }
      </style>
    </head>
    <body>${body}</body>
  </html>`;

/**
 * Creates slop's GitHub App through GitHub's manifest flow: slop posts the app definition,
 * the person confirms it on GitHub, and GitHub returns the credentials to the callback.
 */
export const mountGitHubSetup = (
  app: Hono<Env>,
  deps: { auth: Auth; credentials: AppCredentialsStore; publicUrl: string; appName: string },
) => {
  const signedIn = async (cookie: string | undefined) =>
    cookie === undefined ? null : await deps.auth.sessionEmail(cookie);

  app.get('/setup/github-app', async (c) => {
    if ((await signedIn(getCookie(c, SESSION_COOKIE))) === null) return c.redirect('/login');
    const existing = deps.credentials.get();
    if (existing !== null) {
      return c.html(
        page(
          'GitHub App',
          html`<h1>GitHub App ready</h1>
            <p>slop is set up as <code>${existing.slug}</code>.</p>
            <p><a class="button" href="https://github.com/apps/${existing.slug}/installations/new">Install it on a repo</a></p>`,
        ),
      );
    }
    const state = randomBytes(16).toString('base64url');
    setCookie(c, STATE_COOKIE, state, { httpOnly: true, sameSite: 'Lax', path: '/setup', maxAge: 600 });
    const manifest = JSON.stringify(appManifest(deps.publicUrl, deps.appName));
    return c.html(
      page(
        'Create the GitHub App',
        html`<h1>Create slop's GitHub App</h1>
          <p>
            This creates a private GitHub App named <code>${deps.appName}</code> owned by your account, with webhooks
            sent to <code>${deps.publicUrl}/webhooks/github</code>. GitHub will ask you to confirm.
          </p>
          <form action="https://github.com/settings/apps/new?state=${state}" method="post">
            <input type="hidden" name="manifest" value="${manifest}" />
            <button type="submit">Create on GitHub</button>
          </form>`,
      ),
    );
  });

  // The app's Setup URL: GitHub sends people here after installing or configuring the app,
  // with the `state` the install link carried (the board ID). Only a redirect, so no sign-in.
  app.get('/setup/github-app/installed', (c) => {
    const board = c.req.query('state') ?? '';
    return c.redirect(/^\d+$/.test(board) ? `/boards/${board}/settings` : '/');
  });

  app.get('/setup/github-app/callback', async (c) => {
    if ((await signedIn(getCookie(c, SESSION_COOKIE))) === null) return c.redirect('/login');
    const expected = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: '/setup' });
    const code = c.req.query('code');
    if (expected === undefined || c.req.query('state') !== expected || code === undefined) {
      return c.text('Setup failed: the request did not match. Start again from /setup/github-app.', 400);
    }
    const response = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: 'POST',
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    });
    const parsed = appCredentialsSchema.safeParse(await response.json().catch(() => null));
    if (!response.ok || !parsed.success) return c.text(`GitHub refused the conversion (${response.status}).`, 502);
    await deps.credentials.save(parsed.data);
    return c.html(
      page(
        'GitHub App created',
        html`<h1>GitHub App created</h1>
          <p>slop now acts as <code>${parsed.data.slug}</code>. Its credentials are stored on the server, not shown here.</p>
          <p>Next, install it on the repo slop should manage:</p>
          <p><a class="button" href="https://github.com/apps/${parsed.data.slug}/installations/new">Install on a repo</a></p>`,
      ),
    );
  });
};
