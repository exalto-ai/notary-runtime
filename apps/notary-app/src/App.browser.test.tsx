import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import App, {
  DISPOSABLE_TEST_STOPPED_MESSAGE,
  SENSITIVE_INPUT_RESET_EVENT,
} from './App';
import { createDisposableTestMarker } from './Onboarding';
import { formatBytes, pendingFirstProofTarget, persistPendingFirstProof } from './product';
import { WorkspaceFrame } from './Shell';
import './styles.css';

function renderApp(query: string) {
  window.history.replaceState({}, '', `/${query}`);
  const result = render(<App />);
  result.container.style.width = '100vw';
  result.container.style.height = '100vh';
  return result;
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});

describe('Exalto Capture desktop shell', () => {
  test('exposes the primary desktop destinations', async () => {
    renderApp('?screen=capture-on');
    await expect
      .poll(() =>
        Array.from(document.querySelectorAll('.sidebar-group button')).map((node) =>
          node.textContent?.replace(/\d+$/, ''),
        ),
      )
      .toEqual(['Overview', 'Chat', 'Traces', 'Settings']);
    await expect.element(page.getByText('Captures', { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByText('Finalizations', { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByText('Share', { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: /^Traces/ })).toBeVisible();
    await expect.element(page.getByText('Public Traces', { exact: true })).not.toBeInTheDocument();
    expect(document.querySelector('.sidebar-brand')?.textContent).toBe('Capture');
    expect(document.querySelector('.native-toolbar')).toBeNull();
    expect(document.querySelector('.sidebar-footer')).toBeNull();
    expect(document.body.textContent).not.toContain('REC · Capturing');
  });

  test('formats an empty byte balance consistently', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  test('creates a fresh bounded marker for disposable trace confirmation', () => {
    const first = createDisposableTestMarker();
    const second = createDisposableTestMarker();
    expect(first).toMatch(/^EXALTO-CAPTURE-TEST-[0-9A-F]{24}$/);
    expect(second).toMatch(/^EXALTO-CAPTURE-TEST-[0-9A-F]{24}$/);
    expect(second).not.toBe(first);
  });

  test('routes every Capture count to Traces with a visible constraint', async () => {
    renderApp('?screen=capture-on');
    const expected = [
      ['Captured', 'state=captured'],
      ['Sealing', 'status=notarizing'],
      ['Sealed', 'state=notarized'],
      ['Needs attention', 'status=needs_attention'],
    ] as const;

    for (const [label, constraint] of expected) {
      await userEvent.click(page.getByRole('button', { name: new RegExp(label) }));
      await expect
        .poll(() => document.querySelector<HTMLIFrameElement>('.workspace-frame iframe')?.src)
        .toContain(`#/traces?${constraint}`);
      await userEvent.click(page.getByRole('button', { name: 'Overview' }));
    }
  });

  test('opens an exact sealed Trace action inside the desktop shell', async () => {
    render(
      <WorkspaceFrame
        route="traces"
        traceTarget={{ traceId: 'trc-browser-first-proof', action: 'first-proof' }}
        running
        workspaceSource={undefined}
      />,
    );
    await expect
      .poll(() => document.querySelector<HTMLIFrameElement>('.workspace-frame iframe')?.src)
      .toContain('#/traces/trc-browser-first-proof?action=first-proof');
  });

  test('resumes and consumes a pending first-proof handoff across app restarts', async () => {
    persistPendingFirstProof({ traceId: 'trc-browser-resume-proof', action: 'first-proof' });
    renderApp('?screen=capture-off');
    await expect
      .poll(() => document.querySelector<HTMLIFrameElement>('.workspace-frame iframe')?.src)
      .toContain('#/traces/trc-browser-resume-proof?action=first-proof');
    const frame = document.querySelector<HTMLIFrameElement>('.workspace-frame iframe');
    if (!frame?.contentWindow) throw new Error('Workspace frame is missing');

    window.dispatchEvent(new MessageEvent('message', {
      origin: 'http://127.0.0.1:8788',
      source: frame.contentWindow,
      data: {
        type: 'notary:desktop-trace-action-consumed',
        payload: { traceId: 'trc-browser-resume-proof', action: 'first-proof' },
      },
    }));

    await expect.poll(pendingFirstProofTarget).toBeNull();
    expect(document.querySelector<HTMLIFrameElement>('.workspace-frame iframe')).toBe(frame);
  });

  test('keeps service-backed workspaces inside the desktop shell', async () => {
    renderApp('?screen=capture-on&view=providers');
    await expect
      .poll(() => document.querySelector<HTMLIFrameElement>('.workspace-frame iframe')?.src)
      .toContain('/dashboard?embedded=desktop#/providers');
    await userEvent.click(page.getByRole('button', { name: 'Connection setup' }));
    await expect.element(page.getByRole('heading', { name: 'Where would you like to chat?' })).toBeVisible();
    await userEvent.click(page.getByRole('button', { name: 'Done' }));
    await userEvent.click(page.getByRole('button', { name: 'Activity log' }));
    await expect
      .poll(() => document.querySelector<HTMLIFrameElement>('.workspace-frame iframe')?.src)
      .toContain('/dashboard?embedded=desktop#/activity');
  });

  test('keeps one ready workspace through Traces, Settings, and Chat navigation', async () => {
    renderApp('?screen=capture-on&view=traces');
    await expect.poll(() => document.querySelector('.workspace-frame iframe')).toBeTruthy();
    const frame = document.querySelector<HTMLIFrameElement>('.workspace-frame iframe')!;
    const contentWindow = frame.contentWindow;
    window.dispatchEvent(new MessageEvent('message', {
      origin: 'http://127.0.0.1:8788', source: contentWindow,
      data: { type: 'notary:desktop-settings-ready' },
    }));
    await expect.element(page.getByText('Loading local workspace…')).not.toBeInTheDocument();
    for (const label of ['Settings', 'Chat', 'Traces', 'Settings', 'Traces']) {
      await userEvent.click(page.getByRole('button', { name: new RegExp(`^${label}`) }));
      expect(document.querySelector('.workspace-frame iframe')).toBe(frame);
      expect(frame.contentWindow).toBe(contentWindow);
      await expect.element(page.getByText('Loading local workspace…')).not.toBeInTheDocument();
    }
    expect(frame.src).toContain('#/traces');
  });

  test('replaces an unresponsive local workspace spinner with a retry action', async () => {
    render(
      <WorkspaceFrame
        route="traces"
        running
        loadTimeoutMs={250}
        workspaceSource="data:text/html,<title>silent%20workspace</title>"
      />,
    );
    await expect.element(page.getByText('Loading local workspace…')).toBeVisible();
    await expect
      .element(page.getByRole('heading', { name: "Local workspace didn't respond" }))
      .toBeVisible();
    await expect
      .element(page.getByRole('button', { name: 'Retry local workspace' }))
      .toBeVisible();

    await userEvent.click(page.getByRole('button', { name: 'Retry local workspace' }));
    expect(document.querySelector<HTMLIFrameElement>('.workspace-frame iframe')).not.toBeNull();
  });

  test('requires a fresh workspace response after the local service restarts', async () => {
    const source = 'data:text/html,<title>silent%20workspace</title>';
    const view = render(
      <WorkspaceFrame route="traces" running loadTimeoutMs={1_000} workspaceSource={source} />,
    );
    const frame = document.querySelector<HTMLIFrameElement>('.workspace-frame iframe');
    expect(frame?.contentWindow).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        origin: 'http://127.0.0.1:8788',
        source: frame?.contentWindow,
        data: { type: 'notary:desktop-route-change', payload: { view: 'traces' } },
      }));
    });
    await expect.element(page.getByText('Loading local workspace…')).not.toBeInTheDocument();

    view.rerender(
      <WorkspaceFrame route="traces" running={false} loadTimeoutMs={250} workspaceSource={source} />,
    );
    await expect.element(page.getByRole('heading', { name: 'Local service is off' })).toBeVisible();
    view.rerender(
      <WorkspaceFrame route="traces" running loadTimeoutMs={250} workspaceSource={source} />,
    );
    await expect.element(page.getByText('Loading local workspace…')).toBeVisible();
    await expect
      .element(page.getByRole('heading', { name: "Local workspace didn't respond" }))
      .toBeVisible();
  });

  test('allows a bounded frame-load fallback for a known older external workspace', async () => {
    render(
      <WorkspaceFrame
        route="traces"
        running
        loadTimeoutMs={300}
        workspaceSource="data:text/html,<title>legacy%20workspace</title>"
        allowLegacyFrameLoadFallback
      />,
    );
    await expect.element(page.getByText('Loading local workspace…')).toBeVisible();
    await expect.element(page.getByText('Loading local workspace…')).not.toBeInTheDocument();
    await expect
      .element(page.getByRole('heading', { name: "Local workspace didn't respond" }))
      .not.toBeInTheDocument();
  });

  test('keeps native navigation synchronized with routes opened inside the workspace', async () => {
    renderApp('?screen=capture-on&view=traces');
    await expect
      .poll(() => document.querySelector<HTMLIFrameElement>('.workspace-frame iframe')?.src)
      .toContain('/dashboard?embedded=desktop#/traces');
    const frame = document.querySelector<HTMLIFrameElement>('.workspace-frame iframe');
    if (!frame?.contentWindow) throw new Error('Workspace frame is missing');
    const initialSource = frame.getAttribute('src');

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'http://127.0.0.1:8788',
        source: frame.contentWindow,
        data: {
          type: 'notary:desktop-route-change',
          payload: { view: 'activity' },
        },
      }),
    );

    await expect.element(page.getByRole('button', { name: 'Activity log' })).toHaveClass('is-selected');
    expect(document.querySelector('.native-toolbar')).toBeNull();
    expect(document.querySelector<HTMLIFrameElement>('.workspace-frame iframe')).toBe(frame);
    expect(frame.getAttribute('src')).toBe(initialSource);

    await userEvent.click(page.getByRole('button', { name: /^Traces/ }));
    await expect
      .poll(() => document.querySelector<HTMLIFrameElement>('.workspace-frame iframe'))
      .toBe(frame);
    await expect
      .poll(() => document.querySelector<HTMLIFrameElement>('.workspace-frame iframe')?.src)
      .toMatch(/#\/traces$/);
  });

  test('returns from an embedded trace detail when Traces is clicked again', async () => {
    renderApp('?screen=capture-on&view=traces');
    await expect
      .poll(() => document.querySelector<HTMLIFrameElement>('.workspace-frame iframe'))
      .toBeTruthy();
    const frame = document.querySelector<HTMLIFrameElement>('.workspace-frame iframe');
    if (!frame?.contentWindow) throw new Error('Workspace frame is missing');

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'http://127.0.0.1:8788',
        source: frame.contentWindow,
        data: {
          type: 'notary:desktop-route-change',
          payload: { view: 'traces', detail: 'trc-browser-detail' },
        },
      }),
    );

    await userEvent.click(page.getByRole('button', { name: /^Traces/ }));
    await expect
      .poll(() => document.querySelector<HTMLIFrameElement>('.workspace-frame iframe'))
      .toBe(frame);
    await expect
      .poll(() => document.querySelector<HTMLIFrameElement>('.workspace-frame iframe')?.src)
      .toMatch(/#\/traces$/);
  });

  test('clears a Trace count filter after the embedded route confirms Traces', async () => {
    renderApp('?screen=capture-on');
    await userEvent.click(page.getByRole('button', { name: /Captured/ }));
    await expect
      .poll(() => document.querySelector<HTMLIFrameElement>('.workspace-frame iframe')?.src)
      .toContain('#/traces?state=captured');
    const frame = document.querySelector<HTMLIFrameElement>('.workspace-frame iframe');
    if (!frame?.contentWindow) throw new Error('Workspace frame is missing');

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'http://127.0.0.1:8788',
        source: frame.contentWindow,
        data: {
          type: 'notary:desktop-route-change',
          payload: { view: 'traces' },
        },
      }),
    );
    await userEvent.click(page.getByRole('button', { name: /^Traces/ }));

    await expect
      .poll(() => document.querySelector<HTMLIFrameElement>('.workspace-frame iframe')?.src)
      .toMatch(/#\/traces$/);
  });

  test('keeps the primary capture control on Capture', async () => {
    renderApp('?view=activity');
    await expect.element(page.getByText('Start the local service to inspect private traces and connections. Capture remains off.')).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Start local service' })).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Start capturing' })).not.toBeInTheDocument();
    await userEvent.click(page.getByRole('button', { name: 'Overview' }));
    await expect.element(page.getByRole('button', { name: 'Start capturing' })).toBeVisible();
  });

  test('shows start failures beside the retry action on every offline workspace', async () => {
    for (const view of ['traces', 'providers', 'activity'] as const) {
      renderApp(`?screen=service-off&view=${view}&service-start=fail`);
      await userEvent.click(page.getByRole('button', { name: 'Start local service' }));
      await expect.element(page.getByRole('alert')).toHaveTextContent('could not start');
      await expect.element(page.getByRole('button', { name: 'Start local service' })).toBeEnabled();
      cleanup();
    }
  });

  test('shows start failures beside the Preferences retry action', async () => {
    renderApp('?screen=service-off&view=settings&service-start=fail');
    await userEvent.click(page.getByRole('button', { name: 'Start local service' }));
    await expect.element(page.getByRole('alert')).toHaveTextContent('could not start');
    const alert = document.querySelector('[role="alert"]');
    const advanced = Array.from(document.querySelectorAll('h2')).find(
      (heading) => heading.textContent === 'Advanced',
    );
    expect(alert).not.toBeNull();
    expect(advanced).not.toBeUndefined();
    expect(alert!.compareDocumentPosition(advanced!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('shows a neutral startup state instead of a false sealing failure', async () => {
    renderApp('?screen=service-off');
    await expect.element(page.getByRole('heading', { name: 'Capture is off' })).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Start capturing' })).toBeEnabled();
    await expect.element(page.getByRole('button', { name: 'Start capturing' })).toHaveAttribute(
      'title',
      'Start the local service and connect its trusted capture transport.',
    );
    await expect.element(page.getByText('Exalto Seal · Service off')).toBeVisible();
    await expect.element(page.getByText(/is starting|needs attention|cannot be reached/)).not.toBeInTheDocument();

    cleanup();
    renderApp('?screen=service-starting');
    await expect.element(page.getByText('Exalto Seal is starting')).toBeVisible();
    await expect.element(page.getByText(/Checking the trusted capture transport/)).toBeVisible();
    await expect.element(page.getByText('Sealing service is unavailable')).not.toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Start capturing' })).toBeDisabled();
    await expect.element(page.getByText(/Capture will be available when this check succeeds/)).toBeVisible();
    await expect.element(page.getByText(/Exalto Seal account is not required/)).toBeVisible();
  });

  test('shows capture changes as a temporary corner toast', async () => {
    renderApp('?screen=capture-on');
    await userEvent.click(page.getByRole('button', { name: 'Stop capturing' }));
    await expect
      .poll(() => document.querySelector<HTMLElement>('.capture-toast')?.textContent)
      .toBe('Capture is off.');
    const toast = document.querySelector<HTMLElement>('.capture-toast');
    expect(getComputedStyle(toast!).position).toBe('fixed');
    expect(getComputedStyle(toast!).bottom).toBe('18px');
    expect(document.querySelector('.capture-page > .native-notice')).toBeNull();
  });

  test('distinguishes trusted but unreachable Seal from unavailable trust', async () => {
    renderApp('?screen=seal-unreachable');
    await expect.element(page.getByText('Exalto Seal cannot be reached')).toBeVisible();
    await expect.element(page.getByText(/transport handshake did not complete/)).toBeVisible();
    await expect.element(page.getByText('Exalto Seal · Unreachable')).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Start capturing' })).toBeDisabled();
    await expect.element(page.getByText(/Capture needs this trusted transport/)).toBeVisible();
    await expect.element(page.getByText(/does not require an Exalto Seal account/)).toBeVisible();

    cleanup();
    renderApp('?screen=seal-trust-unavailable');
    await expect.element(page.getByText('Sealing trust needs attention')).toBeVisible();
    await expect.element(page.getByText(/could not resolve a trusted sealing endpoint/)).toBeVisible();
    await expect.element(page.getByText('Exalto Seal · Trust unavailable')).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Start capturing' })).toBeDisabled();
  });

  test('reports Seal ready only after trust and transport checks succeed', async () => {
    renderApp('?screen=capture-off');
    await expect.element(page.getByText('Exalto Seal · Ready')).toBeVisible();
    await expect.element(page.getByText(/Exalto Seal is ready to receive ciphertext/)).toBeVisible();
    await expect.element(page.getByText(/cannot be reached/)).not.toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Start capturing' })).toBeEnabled();
  });

  test('separates built-in credentials from external setup and makes testing optional', async () => {
    renderApp('?screen=onboarding');
    await userEvent.click(page.getByRole('button', { name: /Begin setup/ }));
    await userEvent.click(page.getByRole('button', { name: /Protect traces/ }));
    await userEvent.click(page.getByRole('button', { name: /Continue with Exalto Seal/ }));
    await expect.element(page.getByRole('radio', { name: 'Built-in', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect.element(page.getByRole('button', { name: 'Link ChatGPT plan' })).toBeVisible();
    expect(document.body.textContent).not.toMatch(/Grok|xAI|API or SDK|temporary key/);
    await userEvent.click(page.getByRole('radio', { name: 'Codex', exact: true }));
    await expect.element(page.getByRole('button', { name: 'Copy setup prompt' })).toBeVisible();
    await expect.element(page.getByLabelText('Connection type')).not.toBeInTheDocument();
    await userEvent.click(page.getByText('Review setup prompt', { exact: true }));
    const setup = page.getByRole('textbox', { name: 'Setup prompt' });
    await expect.element(setup).toHaveValue(expect.stringContaining('Preserve its existing authentication method'));
    await userEvent.click(page.getByRole('button', { name: 'Continue without a test' }));
    await expect.element(page.getByRole('heading', { name: 'Exalto Capture is ready' })).toBeVisible();
    await expect.element(page.getByText('Test trace captured', { exact: true })).not.toBeInTheDocument();
  });

  test('blocks manual disposable capture until the trusted transport is ready', async () => {
    renderApp('?screen=onboarding&capture-transport=starting');

    await userEvent.click(page.getByRole('button', { name: /Begin setup/ }));
    await userEvent.click(page.getByRole('button', { name: /Protect traces/ }));
    await userEvent.click(page.getByRole('button', { name: /Continue with Exalto Seal/ }));
    await userEvent.click(page.getByRole('radio', { name: /^Codex/ }));
    await userEvent.click(page.getByRole('button', { name: /Start service and prepare test/ }));

    await expect.element(page.getByRole('heading', { name: 'Where would you like to chat?' })).toBeVisible();
    await expect.element(page.getByText(/trusted capture transport is not ready/)).toBeVisible();
    await expect.element(page.getByText(/No Exalto Seal account is required/)).toBeVisible();
    await expect.element(page.getByRole('heading', { name: 'Capture one disposable trace' })).not.toBeInTheDocument();
  });

  test('preserves a third-party sealing service across onboarding and Capture', async () => {
    renderApp('?screen=onboarding-third-party');
    await userEvent.click(page.getByRole('button', { name: /Begin setup/ }));
    await userEvent.click(page.getByRole('button', { name: /Protect traces/ }));
    await expect.element(page.getByRole('heading', { name: 'Continue with Northstar Seal' })).toBeVisible();
    await expect.element(page.getByRole('button', { name: /Continue with Northstar Seal/ })).toBeVisible();
    await expect.element(page.getByText('Northstar Seal', { exact: true }).last()).toBeVisible();
    await expect.element(page.getByText('Exalto Seal', { exact: true })).not.toBeInTheDocument();

    cleanup();
    renderApp('?screen=capture-third-party');
    await expect.element(page.getByText('Northstar Seal', { exact: true }).first()).toBeVisible();
    await expect.element(page.getByText('Exalto Seal', { exact: true })).not.toBeInTheDocument();
  });

  test('keeps the connection setup action visible at the minimum desktop size', async () => {
    await page.viewport(980, 680);
    try {
      renderApp('?screen=onboarding');
      await userEvent.click(page.getByRole('button', { name: /Begin setup/ }));
      await userEvent.click(page.getByRole('button', { name: /Protect traces/ }));
      await userEvent.click(page.getByRole('button', { name: /Continue with Exalto Seal/ }));

      const continueButton = page.getByRole('button', { name: /Try a chat/ });
      const bounds = continueButton.element().getBoundingClientRect();
      const content = document.querySelector<HTMLElement>('.onboarding-content.is-client-step');
      const actions = document.querySelector<HTMLElement>('.client-step-actions');
      expect(content).not.toBeNull();
      expect(actions).not.toBeNull();
      expect(bounds.top).toBeGreaterThanOrEqual(0);
      expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight);
      expect(bounds.bottom).toBeLessThanOrEqual(content!.getBoundingClientRect().bottom);
      expect(window.getComputedStyle(actions!).marginTop).toBe('0px');
      const headingBounds = page.getByRole('heading', { name: 'Where would you like to chat?' }).element().getBoundingClientRect();
      expect(headingBounds.top).toBeGreaterThanOrEqual(content!.getBoundingClientRect().top);

      await userEvent.click(page.getByRole('radio', { name: /^Codex/ }));
      await userEvent.click(page.getByText('Review setup prompt', { exact: true }));
      const setupPanel = document.querySelector<HTMLElement>('.agent-setup');
      expect(setupPanel).not.toBeNull();
      expect(setupPanel!.scrollHeight).toBeLessThanOrEqual(setupPanel!.clientHeight + 1);
      await userEvent.click(page.getByRole('textbox', { name: 'Setup prompt' }));
      const promptBounds = page.getByRole('textbox', { name: 'Setup prompt' }).element().getBoundingClientRect();
      expect(promptBounds.top).toBeGreaterThanOrEqual(0);
      expect(promptBounds.top + promptBounds.height / 2).toBeLessThan(actions!.getBoundingClientRect().top);

      await userEvent.click(page.getByRole('radio', { name: /^Built-in/ }));
      const scrollRegion = document.querySelector<HTMLElement>('.client-step-scroll');
      expect(scrollRegion).not.toBeNull();
      expect(window.getComputedStyle(scrollRegion!).overflowY).toBe('auto');
      const apiBounds = continueButton.element().getBoundingClientRect();
      expect(apiBounds.bottom).toBeLessThanOrEqual(window.innerHeight);
      expect(apiBounds.bottom).toBeLessThanOrEqual(content!.getBoundingClientRect().bottom);
    } finally {
      await page.viewport(1280, 900);
    }
  });

  test('does not create an unprotected passphrase vault', async () => {
    renderApp('?screen=onboarding');
    await userEvent.click(page.getByRole('button', { name: /Begin setup/ }));
    await userEvent.click(page.getByRole('button', { name: /Advanced protection/ }));
    await userEvent.click(page.getByRole('radio', { name: /Use a passphrase/ }));

    const protect = page.getByRole('button', { name: /Protect traces/ });
    const passphrase = page.getByLabelText('Passphrase', { exact: true });
    const confirmation = page.getByLabelText('Confirm passphrase', { exact: true });
    await expect.element(protect).toBeDisabled();
    await expect.element(page.getByText('Enter a non-empty passphrase.')).toBeVisible();

    await userEvent.fill(passphrase, '   ');
    await userEvent.fill(confirmation, '   ');
    await expect.element(protect).toBeDisabled();
    await userEvent.fill(passphrase, 'correct horse battery staple');
    await expect.element(page.getByText('The passphrases do not match.')).toBeVisible();
    await expect.element(protect).toBeDisabled();
    await userEvent.fill(confirmation, 'correct horse battery staple');
    await expect.element(protect).toBeEnabled();
  });

  test('clears unsaved secrets whenever the native window is hidden', async () => {
    renderApp('?screen=unlock');
    await userEvent.fill(page.getByLabelText('Vault passphrase'), 'unsaved unlock secret');
    await act(async () => {
      window.dispatchEvent(new Event(SENSITIVE_INPUT_RESET_EVENT));
    });
    await expect.element(page.getByLabelText('Vault passphrase')).toHaveValue('');

    cleanup();
    renderApp('?screen=capture-on&view=providers');
    await userEvent.click(page.getByRole('button', { name: 'Connection setup' }));
    await userEvent.click(page.getByRole('radio', { name: /^Built-in/ }));
    await userEvent.selectOptions(page.getByLabelText('Connection type'), 'openai');
    const openAiKey = page.getByLabelText('OpenAI API key');
    await userEvent.fill(openAiKey, 'unsaved provider secret');

    await act(async () => {
      window.dispatchEvent(new Event(SENSITIVE_INPUT_RESET_EVENT));
    });
    await userEvent.click(page.getByRole('radio', { name: /^Built-in/ }));
    await userEvent.selectOptions(page.getByLabelText('Connection type'), 'openai');
    await expect
      .element(page.getByLabelText('OpenAI API key'))
      .toHaveValue('');

    cleanup();
    renderApp('?screen=capture-on&view=traces');
    await expect
      .poll(() => document.querySelector<HTMLIFrameElement>('.workspace-frame iframe'))
      .not.toBeNull();
    const originalWorkspace = document.querySelector<HTMLIFrameElement>('.workspace-frame iframe');
    await act(async () => {
      window.dispatchEvent(new Event(SENSITIVE_INPUT_RESET_EVENT));
    });
    await expect
      .poll(() => document.querySelector<HTMLIFrameElement>('.workspace-frame iframe'))
      .not.toBe(originalWorkspace);

    cleanup();
    renderApp('?screen=onboarding');
    await expect.element(page.getByRole('button', { name: /Begin setup/ })).toBeVisible();
    await act(async () => {
      window.dispatchEvent(new CustomEvent(SENSITIVE_INPUT_RESET_EVENT, {
        detail: { resumeDisposableSetup: true },
      }));
    });
    await expect.element(page.getByRole('heading', { name: 'Where would you like to chat?' })).toBeVisible();
    await expect.element(page.getByText(DISPOSABLE_TEST_STOPPED_MESSAGE)).toBeVisible();
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

  test('keeps simplified Settings groups available without the capture control', async () => {
    renderApp('?screen=offline&view=settings');
    await expect
      .poll(() =>
        Array.from(document.querySelectorAll('.preference-section > h2')).map(
          (heading) => heading.textContent,
        ),
      )
      .toEqual(['Connections', 'Privacy & storage', 'App', 'Advanced']);
    await expect.element(page.getByRole('switch', { name: 'Capture new requests' })).not.toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Start capturing' })).not.toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Start local service' })).toBeVisible();
  });
});
