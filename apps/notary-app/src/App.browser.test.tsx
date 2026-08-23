import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import App from './App';
import { formatBytes } from './product';

function renderApp(query: string) {
  window.history.replaceState({}, '', `/${query}`);
  return render(<App />);
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});

describe('Notary desktop shell', () => {
  test('exposes exactly the five Milestone 2 destinations', async () => {
    renderApp('?screen=capture-on');
    await expect
      .poll(() =>
        Array.from(document.querySelectorAll('.sidebar-group button')).map((node) =>
          node.textContent?.replace(/\d+$/, ''),
        ),
      )
      .toEqual(['Home', 'Traces', 'Activity', 'Providers', 'Settings']);
    await expect.element(page.getByText('Captures', { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByText('Finalizations', { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByText('Share', { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Traces3' })).toBeVisible();
  });

  test('formats an empty byte balance consistently', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  test('routes every Home count to Traces with a visible constraint', async () => {
    renderApp('?screen=capture-on');
    const expected = [
      ['Captured', 'state=captured'],
      ['Notarizing', 'status=notarizing'],
      ['Notarized', 'state=notarized'],
      ['Needs attention', 'status=needs_attention'],
    ] as const;

    for (const [label, constraint] of expected) {
      await userEvent.click(page.getByRole('button', { name: new RegExp(label) }));
      await expect
        .poll(() => document.querySelector<HTMLIFrameElement>('.workspace-frame iframe')?.src)
        .toContain(`#/traces?${constraint}`);
      await userEvent.click(page.getByRole('button', { name: 'Home' }));
    }
  });

  test('keeps service-backed workspaces inside the desktop shell', async () => {
    renderApp('?screen=capture-on&view=providers');
    await expect
      .poll(() => document.querySelector<HTMLIFrameElement>('.workspace-frame iframe')?.src)
      .toContain('/dashboard?embedded=desktop#/providers');
    await userEvent.click(page.getByRole('button', { name: 'Activity' }));
    await expect
      .poll(() => document.querySelector<HTMLIFrameElement>('.workspace-frame iframe')?.src)
      .toContain('/dashboard?embedded=desktop#/activity');
  });

  test('keeps service lifecycle controls on Home', async () => {
    renderApp('?view=activity');
    await expect.element(page.getByText('Open Home to start Notary.')).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Start Notary' })).not.toBeInTheDocument();
    await userEvent.click(page.getByRole('button', { name: 'Home' }));
    await expect.element(page.getByRole('button', { name: 'Start Notary' })).toBeVisible();
  });

  test('explains the private trace lifecycle during onboarding', async () => {
    renderApp('?screen=onboarding');
    await expect.element(page.getByText('Welcome to Notary')).toBeVisible();
    await userEvent.click(page.getByRole('button', { name: /Continue/ }));
    await expect
      .element(page.getByText(/Notarizing creates its portable \.llmtrace package/))
      .toBeVisible();
    await expect.element(page.getByText(/does not publish or share the trace/)).toBeVisible();
  });

  test('uses private Trace language in the locked state', async () => {
    renderApp('?screen=unlock');
    await expect.element(page.getByText('Private trace vault')).toBeVisible();
    await expect.element(page.getByRole('heading', { name: 'Unlock private traces on this Mac' })).toBeVisible();
  });

  test('uses one embedded desktop-and-service Settings surface', async () => {
    renderApp('?screen=capture-on&view=settings&update=ready');
    await expect
      .poll(() => document.querySelector<HTMLIFrameElement>('.embedded-settings-page iframe')?.src)
      .toContain('/dashboard?embedded=desktop#/settings');
    expect(document.querySelectorAll('.embedded-settings-page iframe')).toHaveLength(1);
    await expect.element(page.getByText('Menu-bar controller', { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByRole('heading', { name: 'Service settings' })).not.toBeInTheDocument();
    const frame = document.querySelector<HTMLIFrameElement>('.embedded-settings-page iframe');
    if (!frame?.contentWindow) throw new Error('Settings frame is missing');
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'http://127.0.0.1:8788',
        source: frame.contentWindow,
        data: {
          type: 'notary:desktop-settings-action',
          payload: { action: 'set_launch_at_login', enabled: true },
        },
      }),
    );
    await expect.poll(() => localStorage.getItem('notary-launch-at-login')).toBe('true');
  });

  test('keeps the five Settings groups available without service lifecycle controls', async () => {
    renderApp('?screen=offline&view=settings');
    await expect
      .poll(() =>
        Array.from(document.querySelectorAll('.preference-section > h2')).map(
          (heading) => heading.textContent,
        ),
      )
      .toEqual(['General', 'Account', 'Security', 'Updates', 'Advanced']);
    await expect.element(page.getByRole('switch', { name: 'Capture new requests' })).toBeDisabled();
    await expect.element(page.getByRole('button', { name: 'Start Notary' })).not.toBeInTheDocument();
  });
});
