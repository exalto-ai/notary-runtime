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

function renderApp(query: string) {
  window.history.replaceState({}, '', `/${query}`);
  return render(<App />);
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});

describe('Exalto Capture desktop shell', () => {
  test('exposes three product destinations and Public Traces', async () => {
    renderApp('?screen=capture-on');
    await expect
      .poll(() =>
        Array.from(document.querySelectorAll('.sidebar-group button')).map((node) =>
          node.textContent?.replace(/\d+$/, ''),
        ),
      )
      .toEqual(['Capture', 'Traces', 'Settings']);
    await expect.element(page.getByText('Captures', { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByText('Finalizations', { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByText('Share', { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: /^Traces/ })).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Public Traces' })).toBeVisible();
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
      await userEvent.click(page.getByRole('button', { name: 'Capture' }));
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
    await expect.element(page.getByRole('heading', { name: 'Which local tool will you use first?' })).toBeVisible();
    await userEvent.click(page.getByRole('button', { name: 'Done' }));
    await userEvent.click(page.getByRole('button', { name: 'Activity log' }));
    await expect
      .poll(() => document.querySelector<HTMLIFrameElement>('.workspace-frame iframe')?.src)
      .toContain('/dashboard?embedded=desktop#/activity');
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
    await expect.element(page.getByText('Local capture, sealing, and sharing events')).toBeVisible();
    expect(document.querySelector<HTMLIFrameElement>('.workspace-frame iframe')).toBe(frame);
    expect(frame.getAttribute('src')).toBe(initialSource);

    await userEvent.click(page.getByRole('button', { name: /^Traces/ }));
    await expect
      .poll(() => document.querySelector<HTMLIFrameElement>('.workspace-frame iframe'))
      .not.toBe(frame);
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
      .not.toBe(frame);
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
    await userEvent.click(page.getByRole('button', { name: 'Capture' }));
    await expect.element(page.getByRole('button', { name: 'Start capturing' })).toBeVisible();
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

  test('blocks manual disposable capture until the trusted transport is ready', async () => {
    renderApp('?screen=onboarding&capture-transport=starting');

    await userEvent.click(page.getByRole('button', { name: /Begin setup/ }));
    await userEvent.click(page.getByRole('button', { name: /Protect traces/ }));
    await userEvent.click(page.getByRole('button', { name: /Continue with Exalto Seal/ }));
    await userEvent.click(page.getByRole('button', { name: /Start service and prepare test/ }));

    await expect.element(page.getByRole('heading', { name: 'Which local tool will you use first?' })).toBeVisible();
    await expect.element(page.getByText(/trusted capture transport is not ready/)).toBeVisible();
    await expect.element(page.getByText(/No Exalto Seal account is required/)).toBeVisible();
    await expect.element(page.getByRole('heading', { name: 'Capture one disposable trace' })).not.toBeInTheDocument();
  });

  test('blocks the in-app disposable capture when the trusted transport is unreachable', async () => {
    renderApp('?screen=onboarding&capture-transport=unreachable');

    await userEvent.click(page.getByRole('button', { name: /Begin setup/ }));
    await userEvent.click(page.getByRole('button', { name: /Protect traces/ }));
    await userEvent.click(page.getByRole('button', { name: /Continue with Exalto Seal/ }));
    await userEvent.click(page.getByRole('radio', { name: /API or SDK/ }));
    await userEvent.fill(
      page.getByLabelText('Optional temporary key for the onboarding test'),
      'sk-browser-test-unreachable',
    );
    await userEvent.click(page.getByRole('button', { name: /Start service and prepare test/ }));

    await expect.element(page.getByText(/trusted capture transport is not ready/)).toBeVisible();
    await expect.element(page.getByText(/No Exalto Seal account is required/)).toBeVisible();
    await expect.element(page.getByRole('heading', { name: 'Capture one disposable trace' })).not.toBeInTheDocument();
  });

  test('guides a developer through the six-step Exalto Capture setup', async () => {
    renderApp('?screen=onboarding');
    await expect.element(page.getByRole('heading', { name: 'Set up Exalto Capture' })).toBeVisible();
    expect(document.querySelectorAll('.onboarding-progress span')).toHaveLength(6);
    await expect.element(page.getByText('A trace proves the interaction it contains. It does not prove that omitted interactions never happened.')).toBeVisible();

    await userEvent.click(page.getByRole('button', { name: /Begin setup/ }));
    await expect.element(page.getByRole('heading', { name: 'Protect private traces on this Mac' })).toBeVisible();
    await expect.element(page.getByText(/not protected by the trace vault/)).toBeVisible();
    await userEvent.click(page.getByRole('button', { name: /Protect traces/ }));

    await expect.element(page.getByRole('heading', { name: 'Start with Exalto Seal' })).toBeVisible();
    await userEvent.click(page.getByRole('button', { name: /About compatible notaries/ }));
    await expect.element(page.getByText('Self-hosted notary')).toBeVisible();
    await expect.element(page.getByText('Administrator managed', { exact: true }).first()).toBeVisible();
    await userEvent.click(page.getByRole('button', { name: /Continue with Exalto Seal/ }));

    await expect.element(page.getByRole('heading', { name: 'Which local tool will you use first?' })).toBeVisible();
    expect(document.body.textContent).toContain('model_provider = "capture-chatgpt"');
    expect(document.body.textContent).toContain('base_url = "http://127.0.0.1:8787/codex"');
    await userEvent.click(page.getByRole('radio', { name: /Claude Code/ }));
    expect(document.body.textContent).toContain('ANTHROPIC_BASE_URL=http://127.0.0.1:8787/anthropic');
    await userEvent.click(page.getByRole('radio', { name: /API or SDK/ }));
    await expect.element(page.getByRole('button', { name: /xAI \/ Grok Not yet supported/ })).toBeDisabled();
    await expect.element(page.getByRole('link', { name: /Open the xAI key guide/ })).toHaveAttribute('href', 'https://docs.x.ai/developers/quickstart');
    await expect.element(page.getByText(/xAI and Grok capture route is not available/)).toBeVisible();
    await expect.element(page.getByRole('link', { name: /Create an OpenAI API key/ })).toHaveAttribute('href', 'https://platform.openai.com/api-keys');
    const providerKey = page.getByLabelText('Optional temporary key for the onboarding test');
    await expect.element(providerKey).toHaveAttribute('type', 'password');
    await expect.element(page.getByRole('button', { name: /Start service and prepare test/ })).toBeEnabled();
    await userEvent.fill(providerKey, 'sk-browser-test-1234');
    await expect.element(providerKey).toHaveValue('sk-browser-test-1234');
    await expect.element(page.getByText(/only in this in-memory onboarding session/)).toBeVisible();
    await userEvent.click(page.getByRole('radio', { name: 'Anthropic' }));
    await expect.element(page.getByLabelText('Optional temporary key for the onboarding test')).toHaveValue('');
    await userEvent.click(page.getByRole('radio', { name: 'OpenAI' }));
    await userEvent.fill(page.getByLabelText('Optional temporary key for the onboarding test'), 'sk-browser-test-1234');

    await userEvent.click(page.getByRole('button', { name: /Start service and prepare test/ }));
    await expect.element(page.getByRole('heading', { name: 'Capture one disposable trace' })).toBeVisible();
    await expect.element(page.getByText(/^Reply with exactly: EXALTO-CAPTURE-TEST-[0-9A-F]{24}$/)).toBeVisible();
    expect(document.body.textContent).not.toContain('$OPENAI_API_KEY');
    await expect.element(page.getByText('No credential is copied into a terminal command')).toBeVisible();
    const model = page.getByLabelText('OpenAI model ID');
    await expect.element(page.getByRole('button', { name: 'Run in-app test' })).toBeDisabled();
    await userEvent.fill(model, 'gpt-4.1-mini');
    await userEvent.click(page.getByRole('button', { name: 'Run in-app test' }));
    await expect.element(page.getByRole('button', { name: 'Back' })).toBeDisabled();
    await expect.element(page.getByRole('button', { name: 'Test in progress…' })).toBeDisabled();
    await expect.element(page.getByText('Test trace captured')).toBeVisible();
    await expect.element(page.getByText(/previous capture setting was restored/)).toBeVisible();
    await userEvent.click(page.getByRole('button', { name: 'Continue' }));

    await expect.element(page.getByRole('heading', { name: 'Exalto Capture is ready' })).toBeVisible();
    await expect.element(page.getByText(/Local capture does not require an Exalto account/)).toBeVisible();
    await expect.element(page.getByRole('button', { name: /Seal and verify test Trace/ })).toBeVisible();
    await expect.element(page.getByText(/stay private unless you explicitly share it/)).toBeVisible();
    await expect.element(page.getByRole('button', { name: /Keep it local for now/ })).toBeVisible();
    await userEvent.click(page.getByRole('button', { name: /Seal and verify test Trace/ }));
    await expect.poll(pendingFirstProofTarget).toEqual({
      traceId: 'trc-browser-disposable-test',
      action: 'first-proof',
    });
  });

  test('does not retain a failed first-proof choice when the user keeps the Trace local', async () => {
    renderApp('?screen=onboarding&onboarding-finish=fail-once');

    await userEvent.click(page.getByRole('button', { name: /Begin setup/ }));
    await userEvent.click(page.getByRole('button', { name: /Protect traces/ }));
    await userEvent.click(page.getByRole('button', { name: /Continue with Exalto Seal/ }));
    await userEvent.click(page.getByRole('radio', { name: /API or SDK/ }));
    await userEvent.fill(
      page.getByLabelText('Optional temporary key for the onboarding test'),
      'sk-browser-test-failure-path',
    );
    await userEvent.click(page.getByRole('button', { name: /Start service and prepare test/ }));
    await userEvent.fill(page.getByLabelText('OpenAI model ID'), 'gpt-4.1-mini');
    await userEvent.click(page.getByRole('button', { name: 'Run in-app test' }));
    await expect.element(page.getByText('Test trace captured')).toBeVisible();
    await userEvent.click(page.getByRole('button', { name: 'Continue' }));

    await userEvent.click(page.getByRole('button', { name: /Seal and verify test Trace/ }));
    await expect.element(page.getByText('Setup completion failed', { exact: true })).toBeVisible();
    expect(pendingFirstProofTarget()).toBeNull();

    await userEvent.click(page.getByRole('button', { name: /Keep it local for now/ }));
    await expect.poll(pendingFirstProofTarget).toBeNull();
  });

  test('does not misreport a successful provider request when previews prevent confirmation', async () => {
    renderApp('?screen=onboarding&test-result=unconfirmed');
    await userEvent.click(page.getByRole('button', { name: /Begin setup/ }));
    await userEvent.click(page.getByRole('button', { name: /Protect traces/ }));
    await userEvent.click(page.getByRole('button', { name: /Continue with Exalto Seal/ }));
    await userEvent.click(page.getByRole('radio', { name: /API or SDK/ }));
    await userEvent.fill(page.getByLabelText('Optional temporary key for the onboarding test'), 'sk-browser-test-1234');
    await userEvent.click(page.getByRole('button', { name: /Start service and prepare test/ }));
    await userEvent.fill(page.getByLabelText('OpenAI model ID'), 'gpt-4.1-mini');
    await userEvent.click(page.getByRole('button', { name: 'Run in-app test' }));

    await expect.element(page.getByText('Request succeeded, trace not auto-confirmed')).toBeVisible();
    await expect.element(page.getByText(/automatic confirmation requires response previews/i)).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Continue' })).toBeVisible();
    await expect.element(page.getByText('No new trace yet')).not.toBeInTheDocument();
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

  test('reuses an externally managed service without taking ownership', async () => {
    renderApp('?screen=onboarding-external');
    await userEvent.click(page.getByRole('button', { name: /Begin setup/ }));
    await userEvent.click(page.getByRole('button', { name: /Protect traces/ }));
    await userEvent.click(page.getByRole('button', { name: /Continue with Exalto Seal/ }));
    await expect.element(page.getByText(/reuse it without taking ownership/)).toBeVisible();
    await userEvent.click(page.getByRole('radio', { name: /API or SDK/ }));
    await userEvent.fill(page.getByLabelText('Optional temporary key for the onboarding test'), 'sk-browser-test-1234');
    await userEvent.click(page.getByRole('button', { name: /Prepare disposable test/ }));
    await expect.element(page.getByRole('heading', { name: 'Capture one disposable trace' })).toBeVisible();
    await userEvent.fill(page.getByLabelText('OpenAI model ID'), 'gpt-4.1-mini');
    await userEvent.click(page.getByRole('button', { name: 'Run in-app test' }));
    await expect.element(page.getByText('Test trace captured')).toBeVisible();
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
    await userEvent.click(page.getByRole('radio', { name: /API or SDK/ }));
    const openAiKey = page.getByLabelText('Optional temporary key for the onboarding test');
    await userEvent.fill(openAiKey, 'unsaved provider secret');

    await act(async () => {
      window.dispatchEvent(new Event(SENSITIVE_INPUT_RESET_EVENT));
    });
    await userEvent.click(page.getByRole('radio', { name: /API or SDK/ }));
    await expect
      .element(page.getByLabelText('Optional temporary key for the onboarding test'))
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
    await expect.element(page.getByRole('heading', { name: 'Which local tool will you use first?' })).toBeVisible();
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
