import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { formatBytes } from '../../../runtime/apps/admin-dashboard/src/shared';
import App, { DISPOSABLE_TEST_STOPPED_MESSAGE, SENSITIVE_INPUT_RESET_EVENT } from './App';
import { createDisposableTestMarker } from './Onboarding';
import { pendingFirstProofTarget, persistPendingFirstProof } from './product';
import './styles.css';

const approvalUrl = 'https://capture.exalto.ai/authorize?request_id=req-browser&approval_secret=s';

const browserTraceSummary = (traceId = 'trc-browser-detail') => ({
  trace_id: traceId,
  created_at_unix_ms: Date.now() - 1_000,
  completed_at_unix_ms: Date.now(),
  provider: 'openai',
  operation: '/v1/responses',
  requested_model: 'gpt-5.2',
  response_model: 'gpt-5.2',
  http_status: 200,
  streaming: false,
  request_bytes: 512,
  response_bytes: 1_024,
  duration_ms: 250,
  state: 'captured',
  status: null,
  notarization_eligible: true,
  notarization_ineligibility_code: null,
  prompt_preview: 'A browser test prompt.',
  prompt_preview_truncated: false,
  output_preview: 'A browser test response.',
  output_preview_truncated: false,
});

const browserTraceDetail = (traceId: string) => ({
  ...browserTraceSummary(traceId),
  artifacts: [
    {
      kind: 'capture_checkpoint',
      size_bytes: 1_024,
      sha256: 'a'.repeat(64),
    },
  ],
  notarization: null,
  share: null,
});

function present<T>(value: T | null | undefined, what: string): T {
  if (value == null) throw new Error(`Expected ${what} to be present`);
  return value;
}

function renderApp(query: string) {
  window.history.replaceState({}, '', `/${query}`);
  const result = render(<App />);
  result.container.style.width = '100vw';
  result.container.style.height = '100vh';
  return result;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl =
        typeof input === 'string'
          ? new URL(input, window.location.origin)
          : input instanceof URL
            ? input
            : new URL(input.url, window.location.origin);
      const path = requestUrl.pathname;
      const response = (value: unknown, status = 200) =>
        new Response(JSON.stringify(value), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      if (path === '/v1/session') return new Response(null, { status: 204 });
      if (path === '/admin-api/v1/status') {
        return response(
          { error: { code: 'service_unavailable', message: 'The local service is off.' } },
          503,
        );
      }
      if (path === '/v1/status') {
        return response({
          version: '0.1.9',
          build_id: 'browser-test',
          runtime_profile: 'local',
          instance_id: null,
          incarnation_id: null,
          lifecycle: 'ready',
          capture_enabled: false,
          proxy_listener: '127.0.0.1:8787',
          admin_listener: '127.0.0.1:8788',
          proxy_origin: 'http://127.0.0.1:8787',
          admin_origin: 'http://127.0.0.1:8788',
          metadata_backend: 'sqlite',
          metadata_status: 'ready',
          artifact_backend: 'filesystem',
          artifact_status: 'ready',
          vault: 'OS vault',
          notary: 'registry',
          preview_chars: 1_000,
          counts: {
            captured: 3,
            notarizing: 1,
            notarized: 8,
            needs_attention: 2,
            capturing: 0,
            capture_failed: 0,
          },
          updates: {
            enabled: false,
            current_build_id: 'browser-test',
            latest_build_id: null,
            update_available: false,
            last_checked_unix_ms: null,
            error_code: null,
          },
        });
      }
      if (path === '/v1/traces') {
        return response({ items: [browserTraceSummary()], next_cursor: null });
      }
      if (/^\/v1\/traces\/[^/]+\/notarizations$/.test(path)) {
        return response(
          { operation_id: 'op-browser-proof', deduplicated: false, state: 'queued' },
          202,
        );
      }
      if (/^\/v1\/traces\/[^/]+$/.test(path)) {
        return response(
          browserTraceDetail(decodeURIComponent(path.split('/').at(-1) ?? 'trc-browser-detail')),
        );
      }
      if (path === '/v1/activity')
        return response({ items: [], next_cursor: null, high_water: null });
      if (path === '/v1/providers') {
        return response({
          providers: [
            {
              id: 'openai',
              name: 'OpenAI',
              host: 'api.openai.com',
              client_api: 'OpenAI Responses and Chat Completions',
              route_prefix: '/openai',
              proxy_base_url: 'http://127.0.0.1:8787/openai',
              ready: true,
            },
          ],
        });
      }
      if (path === '/v1/notaries') {
        return response({
          source: 'registry',
          registry_source: null,
          generation: null,
          active_key_id: null,
          notaries: [],
        });
      }
      if (path === '/v1/account' && init?.method === 'POST') {
        return response(
          {
            request_id: 'req-browser',
            user_code: '0F81-8CC9',
            verification_uri_complete: approvalUrl,
            expires_in_seconds: 600,
            poll_interval_seconds: 5,
            state: 'pending',
          },
          202,
        );
      }
      if (path === '/v1/account')
        return response({ signed_in: false, connection_state: 'disconnected' });
      if (path === '/v1/account/req-browser') {
        return response({
          signed_in: true,
          connection_state: 'connected',
          display_name: 'Browser Tester',
          auth_provider: 'github',
          credential_kind: 'device_session',
          billing: { plan: 'one_gb', billing_status: 'active', purchase_mode: null },
        });
      }
      if (path === '/v1/settings/capture') return response({ enabled: false });
      return response({});
    }),
  );
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
      .toEqual(['Overview', 'Chat', 'Traces', 'Connections', 'Preferences']);
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

  test('opens Chat on its connect action when no connection is saved', async () => {
    renderApp('?screen=capture-on&view=chat');
    const add = page.getByRole('button', { name: 'Add a connection' });
    await expect.element(add).toBeVisible();
    expect(document.querySelector('.chat-composer')).toBeNull();
    await userEvent.click(add);
    const dialog = page.getByRole('dialog', { name: 'Connections' });
    await expect.element(dialog).toBeVisible();
    await userEvent.click(dialog.getByRole('button', { name: 'Done' }));
    await expect.element(dialog).not.toBeInTheDocument();
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
      await expect.element(page.getByPlaceholder('Search traces')).toBeVisible();
      expect(document.querySelector('.workspace-frame')).toBeNull();
      expect(document.querySelector('.inline-dashboard-page')).not.toBeNull();
      if (constraint.startsWith('state=')) {
        const labelName = constraint === 'state=notarized' ? 'Sealed' : 'Captured';
        await expect
          .element(page.getByRole('radio', { name: labelName, exact: true }))
          .toBeChecked();
      } else {
        await expect
          .element(page.getByRole('button', { name: 'More filters' }))
          .toHaveAttribute('aria-expanded', 'true');
        await expect
          .element(page.getByRole('combobox', { name: 'Operational status filter' }))
          .toHaveValue(label);
      }
      await userEvent.click(page.getByRole('button', { name: 'Overview' }));
    }
  });

  test('resumes and consumes a pending first-proof handoff across app restarts', async () => {
    persistPendingFirstProof({ traceId: 'trc-browser-resume-proof', action: 'first-proof' });
    renderApp('?screen=capture-off');
    await expect.element(page.getByText('Trace ID · trc-browser-resume-proof')).toBeVisible();
    expect(document.querySelector('.workspace-frame')).toBeNull();
    expect(document.querySelector('.inline-dashboard-page')).not.toBeNull();
    await expect.poll(pendingFirstProofTarget).toBeNull();
  });

  test('keeps service-backed workspaces inside the desktop shell', async () => {
    renderApp('?screen=capture-on&view=providers');
    await expect.element(page.getByRole('heading', { name: 'Connect your AI tool' })).toBeVisible();
    expect(document.querySelector('.workspace-frame')).toBeNull();
    expect(document.querySelector('.inline-dashboard-page')).not.toBeNull();
    await userEvent.click(page.getByRole('button', { name: 'Connection setup' }));
    await expect
      .element(page.getByRole('heading', { name: 'Where would you like to chat?' }))
      .toBeVisible();
    await userEvent.click(page.getByRole('button', { name: 'Done' }));
    await userEvent.click(page.getByRole('button', { name: 'Preferences' }));
    await expect.element(page.getByRole('heading', { name: 'Preferences' })).toBeVisible();
    expect(document.querySelector('.settings-subnav')).toBeNull();
    expect(document.querySelector('.workspace-frame')).toBeNull();
  });

  test('keeps native navigation in charge of service-backed views', async () => {
    renderApp('?screen=capture-on&view=traces');
    await expect.element(page.getByPlaceholder('Search traces')).toBeVisible();
    expect(document.querySelector('.workspace-frame')).toBeNull();
    for (const label of ['Preferences', 'Chat', 'Traces', 'Connections', 'Preferences', 'Traces']) {
      await userEvent.click(page.getByRole('button', { name: new RegExp(`^${label}`) }));
      expect(document.querySelector('.workspace-frame')).toBeNull();
    }
    await expect.element(page.getByPlaceholder('Search traces')).toBeVisible();
  });

  test('clears a Trace count filter when the native Traces destination is selected again', async () => {
    renderApp('?screen=capture-on');
    await userEvent.click(page.getByRole('button', { name: /Captured/ }));
    await expect.element(page.getByRole('radio', { name: 'Captured', exact: true })).toBeChecked();
    await userEvent.click(page.getByRole('button', { name: /^Traces/ }));
    await expect.element(page.getByRole('radio', { name: 'All', exact: true })).toBeChecked();
    expect(document.querySelector('.workspace-frame')).toBeNull();
  });

  test('keeps the primary capture control on Capture', async () => {
    renderApp('?screen=service-off&view=traces');
    await expect
      .element(
        page.getByText(
          'Start the local service to inspect private traces and connections. Capture remains off.',
        ),
      )
      .toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Start local service' })).toBeVisible();
    await expect
      .element(page.getByRole('button', { name: 'Start capturing' }))
      .not.toBeInTheDocument();
    await userEvent.click(page.getByRole('button', { name: 'Overview' }));
    await expect.element(page.getByRole('button', { name: 'Start capturing' })).toBeVisible();
  });

  test('shows start failures beside the retry action on every offline workspace', async () => {
    for (const view of ['traces', 'providers'] as const) {
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
    const alert = present(document.querySelector('[role="alert"]'), 'the start failure alert');
    const advanced = present(
      Array.from(document.querySelectorAll('h2')).find(
        (heading) => heading.textContent === 'Advanced',
      ),
      'the Advanced heading',
    );
    expect(alert.compareDocumentPosition(advanced) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('shows a neutral startup state instead of a false sealing failure', async () => {
    renderApp('?screen=service-off');
    await expect.element(page.getByRole('heading', { name: 'Capture is off' })).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Start capturing' })).toBeEnabled();
    await expect
      .element(page.getByRole('button', { name: 'Start capturing' }))
      .toHaveAttribute(
        'title',
        'Start the local service and connect its trusted capture transport.',
      );
    await expect.element(page.getByText('Exalto Seal · Service off')).toBeVisible();
    await expect
      .element(page.getByText(/is starting|needs attention|cannot be reached/))
      .not.toBeInTheDocument();

    cleanup();
    renderApp('?screen=service-starting');
    await expect.element(page.getByText('Exalto Seal is starting')).toBeVisible();
    await expect.element(page.getByText(/Checking the trusted capture transport/)).toBeVisible();
    await expect.element(page.getByText('Sealing service is unavailable')).not.toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Start capturing' })).toBeDisabled();
    await expect
      .element(page.getByText(/Capture will be available when this check succeeds/))
      .toBeVisible();
    await expect.element(page.getByText(/Exalto Seal account is not required/)).toBeVisible();
  });

  test('shows capture changes as a temporary corner toast', async () => {
    renderApp('?screen=capture-on');
    await userEvent.click(page.getByRole('button', { name: 'Stop capturing' }));
    await expect
      .poll(() => document.querySelector<HTMLElement>('.capture-toast')?.textContent)
      .toBe('Capture is off.');
    const toast = present(
      document.querySelector<HTMLElement>('.capture-toast'),
      'the capture toast',
    );
    expect(getComputedStyle(toast).position).toBe('fixed');
    expect(getComputedStyle(toast).bottom).toBe('18px');
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
    await expect
      .element(page.getByText(/could not resolve a trusted sealing endpoint/))
      .toBeVisible();
    await expect.element(page.getByText('Exalto Seal · Trust unavailable')).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Start capturing' })).toBeDisabled();
  });

  test('reports Seal ready only after trust and transport checks succeed', async () => {
    renderApp('?screen=capture-off');
    await expect.element(page.getByText('Exalto Seal · Ready')).toBeVisible();
    await expect
      .element(page.getByText(/Exalto Seal is ready to receive ciphertext/))
      .toBeVisible();
    await expect.element(page.getByText(/cannot be reached/)).not.toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Start capturing' })).toBeEnabled();
  });

  test('separates built-in credentials from external setup and makes testing optional', async () => {
    renderApp('?screen=onboarding');
    await userEvent.click(page.getByRole('button', { name: /Begin setup/ }));
    await userEvent.click(page.getByRole('button', { name: /Protect traces/ }));
    await userEvent.click(page.getByRole('button', { name: /Continue with Exalto Seal/ }));
    await expect
      .element(page.getByRole('radio', { name: 'Built-in', exact: true }))
      .toHaveAttribute('aria-checked', 'true');
    await expect.element(page.getByRole('button', { name: 'Link ChatGPT plan' })).toBeVisible();
    expect(document.body.textContent).not.toMatch(/Grok|xAI|API or SDK|temporary key/);
    await userEvent.click(page.getByRole('radio', { name: 'Codex', exact: true }));
    await expect.element(page.getByRole('button', { name: 'Copy setup prompt' })).toBeVisible();
    await expect.element(page.getByLabelText('Connection type')).not.toBeInTheDocument();
    await userEvent.click(page.getByText('Review setup prompt', { exact: true }));
    const setup = page.getByRole('textbox', { name: 'Setup prompt' });
    await expect
      .element(setup)
      .toHaveValue(expect.stringContaining('Preserve its existing authentication method'));
    await userEvent.click(page.getByRole('button', { name: 'Continue without a test' }));
    await expect
      .element(page.getByRole('heading', { name: 'Exalto Capture is ready' }))
      .toBeVisible();
    await expect
      .element(page.getByText('Test trace captured', { exact: true }))
      .not.toBeInTheDocument();
  });

  test('links an account from setup through the shared account card', async () => {
    const windowOpen = vi.spyOn(window, 'open').mockReturnValue(null);
    renderApp('?screen=onboarding');
    await userEvent.click(page.getByRole('button', { name: /Begin setup/ }));
    await userEvent.click(page.getByRole('button', { name: /Protect traces/ }));
    await userEvent.click(page.getByRole('button', { name: /Continue with Exalto Seal/ }));
    await userEvent.click(page.getByRole('button', { name: 'Continue without a test' }));
    await userEvent.click(page.getByRole('button', { name: 'Connect account…' }));
    await expect.element(page.getByText('Approve in your browser')).toBeVisible();
    await expect.element(page.getByText('0F81-8CC9')).toBeVisible();
    expect(windowOpen).toHaveBeenCalledWith(approvalUrl, '_blank', 'noopener,noreferrer');
    await expect.element(page.getByText(/Next check/)).not.toBeInTheDocument();
    window.dispatchEvent(new Event('focus'));
    await expect.element(page.getByText('Browser Tester', { exact: true })).toBeVisible();
    await expect.element(page.getByText('1 GB plan', { exact: true })).toBeVisible();
    windowOpen.mockRestore();
  });

  test('blocks manual disposable capture until the trusted transport is ready', async () => {
    renderApp('?screen=onboarding&capture-transport=starting');

    await userEvent.click(page.getByRole('button', { name: /Begin setup/ }));
    await userEvent.click(page.getByRole('button', { name: /Protect traces/ }));
    await userEvent.click(page.getByRole('button', { name: /Continue with Exalto Seal/ }));
    await userEvent.click(page.getByRole('radio', { name: /^Codex/ }));
    await userEvent.click(page.getByRole('button', { name: /Start service and prepare test/ }));

    await expect
      .element(page.getByRole('heading', { name: 'Where would you like to chat?' }))
      .toBeVisible();
    await expect.element(page.getByText(/trusted capture transport is not ready/)).toBeVisible();
    await expect.element(page.getByText(/No Exalto Seal account is required/)).toBeVisible();
    await expect
      .element(page.getByRole('heading', { name: 'Capture one disposable trace' }))
      .not.toBeInTheDocument();
  });

  test('preserves a third-party sealing service across onboarding and Capture', async () => {
    renderApp('?screen=onboarding-third-party');
    await userEvent.click(page.getByRole('button', { name: /Begin setup/ }));
    await userEvent.click(page.getByRole('button', { name: /Protect traces/ }));
    await expect
      .element(page.getByRole('heading', { name: 'Continue with Northstar Seal' }))
      .toBeVisible();
    await expect
      .element(page.getByRole('button', { name: /Continue with Northstar Seal/ }))
      .toBeVisible();
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
      const content = present(
        document.querySelector<HTMLElement>('.onboarding-content.is-client-step'),
        'the client step content',
      );
      const actions = present(
        document.querySelector<HTMLElement>('.client-step-actions'),
        'the client step actions',
      );
      expect(bounds.top).toBeGreaterThanOrEqual(0);
      expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight);
      expect(bounds.bottom).toBeLessThanOrEqual(content.getBoundingClientRect().bottom);
      expect(window.getComputedStyle(actions).marginTop).toBe('0px');
      const headingBounds = page
        .getByRole('heading', { name: 'Where would you like to chat?' })
        .element()
        .getBoundingClientRect();
      expect(headingBounds.top).toBeGreaterThanOrEqual(content.getBoundingClientRect().top);

      await userEvent.click(page.getByRole('radio', { name: /^Codex/ }));
      await userEvent.click(page.getByText('Review setup prompt', { exact: true }));
      const setupPanel = present(
        document.querySelector<HTMLElement>('.agent-setup'),
        'the agent setup panel',
      );
      expect(setupPanel.scrollHeight).toBeLessThanOrEqual(setupPanel.clientHeight + 1);
      await userEvent.click(page.getByRole('textbox', { name: 'Setup prompt' }));
      const promptBounds = page
        .getByRole('textbox', { name: 'Setup prompt' })
        .element()
        .getBoundingClientRect();
      expect(promptBounds.top).toBeGreaterThanOrEqual(0);
      expect(promptBounds.top + promptBounds.height / 2).toBeLessThan(
        actions.getBoundingClientRect().top,
      );

      await userEvent.click(page.getByRole('radio', { name: /^Built-in/ }));
      const scrollRegion = present(
        document.querySelector<HTMLElement>('.client-step-scroll'),
        'the client step scroll region',
      );
      expect(window.getComputedStyle(scrollRegion).overflowY).toBe('auto');
      const apiBounds = continueButton.element().getBoundingClientRect();
      expect(apiBounds.bottom).toBeLessThanOrEqual(window.innerHeight);
      expect(apiBounds.bottom).toBeLessThanOrEqual(content.getBoundingClientRect().bottom);
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
    await page.getByRole('combobox', { name: 'Connection type' }).click();
    await page.getByRole('option', { name: 'OpenAI API' }).click();
    const openAiKey = page.getByLabelText('OpenAI API key');
    await userEvent.fill(openAiKey, 'unsaved provider secret');

    await act(async () => {
      window.dispatchEvent(new Event(SENSITIVE_INPUT_RESET_EVENT));
    });
    await userEvent.click(page.getByRole('radio', { name: /^Built-in/ }));
    await page.getByRole('combobox', { name: 'Connection type' }).click();
    await page.getByRole('option', { name: 'OpenAI API' }).click();
    await expect.element(page.getByLabelText('OpenAI API key')).toHaveValue('');

    cleanup();
    renderApp('?screen=capture-on&view=traces');
    await expect.element(page.getByPlaceholder('Search traces')).toBeVisible();
    expect(document.querySelector('.workspace-frame')).toBeNull();
    await act(async () => {
      window.dispatchEvent(new Event(SENSITIVE_INPUT_RESET_EVENT));
    });
    await expect.element(page.getByPlaceholder('Search traces')).toBeVisible();
    expect(document.querySelector('.workspace-frame')).toBeNull();

    cleanup();
    renderApp('?screen=onboarding');
    await expect.element(page.getByRole('button', { name: /Begin setup/ })).toBeVisible();
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(SENSITIVE_INPUT_RESET_EVENT, {
          detail: { resumeDisposableSetup: true },
        }),
      );
    });
    await expect
      .element(page.getByRole('heading', { name: 'Where would you like to chat?' }))
      .toBeVisible();
    await expect.element(page.getByText(DISPOSABLE_TEST_STOPPED_MESSAGE)).toBeVisible();
  });

  test('uses private Trace language in the locked state', async () => {
    renderApp('?screen=unlock');
    await expect.element(page.getByText('Private trace vault')).toBeVisible();
    await expect
      .element(page.getByRole('heading', { name: 'Unlock private traces on this Mac' }))
      .toBeVisible();
  });

  test('uses one native desktop-and-service Settings surface', async () => {
    renderApp('?screen=capture-on&view=settings&update=ready');
    await expect
      .element(page.getByRole('heading', { name: 'Preferences', exact: true }))
      .toBeVisible();
    await expect
      .poll(() =>
        Array.from(document.querySelectorAll('.preference-section > h2')).map(
          (heading) => heading.textContent,
        ),
      )
      .toEqual(['Account', 'Sealing', 'Privacy', 'Appearance', 'General', 'Advanced']);
    expect(document.querySelector('.workspace-frame')).toBeNull();
    expect(document.querySelector('.inline-dashboard-page')).not.toBeNull();
    await expect
      .element(page.getByText('http://127.0.0.1:8788/openapi.json', { exact: true }))
      .toBeVisible();
    expect(document.querySelectorAll('.preferences a[target="_blank"]')).toHaveLength(0);
    (
      page
        .getByRole('switch', { name: 'Open Exalto Capture at sign-in' })
        .element() as HTMLInputElement
    ).click();
    await expect.poll(() => localStorage.getItem('notary-launch-at-login')).toBe('true');
  });

  test('keeps the same Preferences sections while the local service is off', async () => {
    renderApp('?screen=offline&view=settings');
    await expect
      .poll(() =>
        Array.from(document.querySelectorAll('.preference-section > h2')).map(
          (heading) => heading.textContent,
        ),
      )
      .toEqual(['Account', 'Privacy', 'Appearance', 'General', 'Advanced']);
    await expect
      .element(page.getByRole('switch', { name: 'Capture new requests' }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole('button', { name: 'Start capturing' }))
      .not.toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Start local service' })).toBeVisible();
  });

  test('persists the Appearance choice and applies it to the whole window', async () => {
    expect(document.documentElement.dataset.shell).toBe('desktop');
    const scheme = () => document.documentElement.getAttribute('data-mantine-color-scheme');
    const windowColor = () =>
      getComputedStyle(present(document.querySelector('.native-window'), 'window'))
        .getPropertyValue('--window')
        .trim();
    renderApp('?screen=capture-on&view=settings');
    const theme = page.getByRole('radiogroup', { name: 'Theme' });
    await expect.element(theme.getByRole('radio', { name: 'System' })).toBeChecked();

    await theme.getByText('Dark', { exact: true }).click();
    await expect.poll(scheme).toBe('dark');
    expect(localStorage.getItem('exalto-capture-color-scheme')).toBe('dark');
    expect(windowColor()).toBe('#1e1e1e');

    await theme.getByText('Light', { exact: true }).click();
    await expect.poll(scheme).toBe('light');
    expect(windowColor()).toBe('#f5f5f5');

    cleanup();
    renderApp('?screen=offline&view=settings');
    await expect
      .element(
        page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Light' }),
      )
      .toBeChecked();
    await expect.poll(scheme).toBe('light');
  });
});
