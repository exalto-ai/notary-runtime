import { createTheme, MantineProvider } from '@mantine/core';
import { Notifications, notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { type AccountConnection, type LocalApi, LocalApiError, type TraceSummary } from './api';
import { Dashboard, type DesktopSettingsAction, type DesktopSettingsState } from './Dashboard';
import { createFixtureApi, fixtureCaptures, fixtureNotaries, fixtureOperations } from './fixtures';
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';

const theme = createTheme({ defaultRadius: 0, primaryColor: 'dark' });

const desktopSettings: DesktopSettingsState = {
  launch_at_login: true,
  launch_ready: true,
  vault_label: 'Protected by Keychain',
  vault_detail: 'The vault key is protected by this Mac.',
  app_version: '0.1.0',
  app_build_id: 'desktop-build-a',
  update: {
    enabled: true,
    phase: 'ready',
    current_build_id: 'desktop-build-a',
    latest_build_id: 'desktop-build-b',
    downloaded_bytes: 42 * 1024 * 1024,
    total_bytes: 42 * 1024 * 1024,
    message: 'The signed update is ready.',
  },
  update_busy: false,
  restart_block_reason: null,
  notice: null,
};

function renderDashboard(
  hash = '/overview',
  api: LocalApi = createFixtureApi(),
  embedded = false,
  settings: DesktopSettingsState | null = null,
  onDesktopSettingsAction?: (action: DesktopSettingsAction) => void,
) {
  window.location.hash = hash;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MantineProvider theme={theme} defaultColorScheme="auto">
      <Notifications />
      <QueryClientProvider client={queryClient}>
        <Dashboard
          api={api}
          fixture
          embedded={embedded}
          desktopSettings={settings}
          onDesktopSettingsAction={onDesktopSettingsAction}
        />
      </QueryClientProvider>
    </MantineProvider>,
  );
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  notifications.clean();
  notifications.cleanQueue();
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Notary admin dashboard', () => {
  test('exposes exactly the five Milestone 2 destinations', async () => {
    renderDashboard();
    await expect
      .poll(() =>
        Array.from(document.querySelectorAll('.local-topbar nav button')).map((node) =>
          node.textContent?.replace(/\s+/g, '').trim(),
        ),
      )
      .toEqual(['Overview', 'Traces4', 'Activity', 'Providers', 'Settings']);
    await expect.element(page.getByText('Captures', { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByText('Notarizations', { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByText('Share', { exact: true })).not.toBeInTheDocument();
  });

  test('does not preserve aliases for removed routes', async () => {
    renderDashboard('/captures/trc-20260727-benchmark');
    await expect.element(page.getByRole('heading', { name: 'Online' })).toBeVisible();
    await expect.element(page.getByLabelText('Search traces')).not.toBeInTheDocument();
  });

  test('shows the four canonical trace counts and routes all of them to Traces', async () => {
    renderDashboard();
    await expect
      .poll(() =>
        Array.from(document.querySelectorAll('.count-strip button')).map((node) =>
          node.textContent?.replace(/\s+/g, ' ').trim(),
        ),
      )
      .toEqual(['4Captured', '1Sealing', '2Sealed', '1Needs attention']);
    await page.getByRole('button', { name: /Sealing/ }).click();
    await expect.element(page.getByLabelText('Search traces')).toBeVisible();
  });

  test('filters the unified trace collection and opens a trace', async () => {
    renderDashboard('/traces');
    await page.getByLabelText('Search traces').fill('**benchmark**');
    await expect
      .element(
        page.getByRole('list', { name: 'Traces' }).getByText('deepseek-v4-flash', { exact: true }),
      )
      .toBeVisible();
    await expect.element(page.getByText('gpt-5.2', { exact: true })).not.toBeInTheDocument();
    await page.getByRole('list', { name: 'Traces' }).getByRole('button').click();
    await expect.element(page.getByText('trc-20260727-benchmark').first()).toBeVisible();
  });

  test('keeps lifecycle primary while placing operational filters under More filters', async () => {
    renderDashboard('/traces?status=notarizing');
    await expect.element(page.getByRole('button', { name: 'All', exact: true })).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Captured', exact: true })).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Sealed', exact: true })).toBeVisible();
    await expect.element(page.getByRole('combobox', { name: 'Provider filter' })).toBeVisible();
    await expect.element(page.getByRole('combobox', { name: 'Trace time filter' })).toBeVisible();
    await expect
      .element(page.getByRole('combobox', { name: 'Operational status filter' }))
      .toBeVisible();
    await expect.element(page.getByText('Sealing', { exact: true }).first()).toBeVisible();

    cleanup();
    renderDashboard('/traces');
    await expect
      .element(page.getByRole('combobox', { name: 'Operational status filter' }))
      .not.toBeInTheDocument();
    await page.getByRole('button', { name: 'More filters' }).click();
    await expect.element(page.getByLabelText('Model filter')).toBeVisible();
    await expect.element(page.getByRole('combobox', { name: 'Streaming filter' })).toBeVisible();
  });

  test('uses the provider identity when no private prompt preview is retained', async () => {
    const fixture = createFixtureApi();
    const fallback: TraceSummary = {
      ...structuredClone(fixtureCaptures[0]),
      prompt_preview: '',
      provider: 'openai',
      state: 'captured',
      status: 'notarizing',
    };
    const api: LocalApi = {
      ...fixture,
      traces: async () => ({ items: [fallback], next_cursor: null }),
      trace: async () => ({ ...(await fixture.trace(fallback.trace_id)), ...fallback }),
    };
    renderDashboard('/traces', api);
    await expect.element(page.getByText('OpenAI request', { exact: true }).first()).toBeVisible();
    await expect
      .element(page.getByText('Captured · Sealing', { exact: true }).first())
      .toBeVisible();
  });

  test('loads another trace cursor without downloading the catalog', async () => {
    const fixture = createFixtureApi();
    const samples = (await fixture.traces({ limit: 200 })).items;
    const cursors: Array<string | undefined> = [];
    const api: LocalApi = {
      ...fixture,
      traces: async (filters = {}) => {
        const cursor = typeof filters.cursor === 'string' ? filters.cursor : undefined;
        cursors.push(cursor);
        return cursor === 'fixture:next'
          ? { items: [samples[1]], next_cursor: null }
          : { items: [samples[0]], next_cursor: 'fixture:next' };
      },
    };
    renderDashboard('/traces', api);
    await page.getByRole('button', { name: 'Load more traces' }).click();
    await expect.poll(() => cursors).toContain('fixture:next');
    await expect.element(page.getByText(samples[1].requested_model ?? '')).toBeVisible();
  });

  test('opens sealed evidence from the same trace route', async () => {
    const fixture = createFixtureApi();
    let requestedSettings: Parameters<LocalApi['share']>[1] | null = null;
    const api: LocalApi = {
      ...fixture,
      share: async (traceId, settings) => {
        requestedSettings = settings;
        return fixture.share(traceId, settings);
      },
    };
    renderDashboard('/traces/trc-20260727-research-brief', api);
    await expect
      .element(page.getByRole('heading', { name: 'Prompt and response preview' }))
      .toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Verify locally' })).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Export .llmtrace' })).toBeVisible();
    await expect.element(page.getByRole('tab', { name: 'Summary' })).toBeVisible();
    await expect.element(page.getByRole('tab', { name: 'Sealing' })).toBeVisible();
    await expect.element(page.getByRole('tab', { name: 'Evidence' })).toBeVisible();
    await expect.element(page.getByRole('tab', { name: 'Technical' })).toBeVisible();
    await expect.element(page.getByText('Private on this device', { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Evidence' }).click();
    await expect
      .poll(() => document.querySelectorAll('.trace-message--human').length)
      .toBeGreaterThan(0);
    await expect
      .poll(() => document.querySelectorAll('.trace-message--model').length)
      .toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Share' }).click();
    await expect
      .element(page.getByRole('heading', { name: 'Review and share this Trace' }))
      .toBeVisible();
    await expect.element(page.getByText('Exact package disclosure')).toBeVisible();
    await expect.element(page.getByText('Sample User')).toBeVisible();
    await expect
      .element(page.getByText('Raw HTTP header values and provider credentials'))
      .toBeVisible();
    await expect.element(page.getByText(/Unlisted is not private/)).toBeVisible();
    await page.getByLabelText('Share visibility').click();
    await page.getByRole('option', { name: 'Listed · public discovery' }).click();
    await page.getByLabelText('Optional password').fill('evidence-pass');
    await page.getByLabelText('Share expiration').click();
    await page.getByRole('option', { name: '7 days' }).click();
    await page.getByRole('button', { name: 'Share trace' }).click();
    await expect.element(page.getByText('Verifying', { exact: true })).toBeVisible();
    expect(requestedSettings).toEqual({
      visibility: 'listed',
      password: 'evidence-pass',
      expires_in_days: 7,
    });
  });

  test('connects an account in place and returns to the same Trace review', async () => {
    const api = createFixtureApi();
    await api.disconnectAccount();
    renderDashboard('/traces/trc-20260727-research-brief', api);

    await page.getByRole('button', { name: 'Share' }).click();
    await expect
      .element(page.getByRole('heading', { name: 'Connect an account to share' }))
      .toBeVisible();
    await expect
      .element(page.getByText(/Connecting an account does not upload or share local evidence/))
      .toBeVisible();
    await page.getByRole('button', { name: 'Connect account' }).click();
    await expect.element(page.getByText('7A3C-91F2')).toBeVisible();
    await page.getByRole('button', { name: 'Check approval' }).click();
    await expect
      .element(page.getByRole('heading', { name: 'Review and share this Trace' }))
      .toBeVisible();
    expect(window.location.hash).toBe('#/traces/trc-20260727-research-brief');
  });

  test('keeps a canceled account authorization canceled after an in-flight approval check', async () => {
    const fixture = createFixtureApi();
    const connectedAccount = await fixture.account();
    await fixture.disconnectAccount();
    let startCalls = 0;
    let pollCalls = 0;
    let pollReturned = false;
    let resolvePoll: (account: AccountConnection) => void = () => {};
    const deferredPoll = new Promise<AccountConnection>((resolve) => {
      resolvePoll = resolve;
    });
    const api: LocalApi = {
      ...fixture,
      startAccountConnection: async () => {
        startCalls += 1;
        return fixture.startAccountConnection();
      },
      pollAccountConnection: async () => {
        pollCalls += 1;
        const account = await deferredPoll;
        pollReturned = true;
        return account;
      },
    };
    renderDashboard('/settings', api);

    await page.getByRole('button', { name: 'Sign in or create account' }).click();
    await expect.element(page.getByText('7A3C-91F2')).toBeVisible();
    const activeButton = page.getByRole('button', { name: 'Authorization in progress' });
    await expect.element(activeButton).toBeDisabled();
    const activeButtonElement = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Authorization in progress'),
    );
    if (!(activeButtonElement instanceof HTMLButtonElement))
      throw new Error('active authorization button was not rendered');
    activeButtonElement.click();
    expect(startCalls).toBe(1);

    await page.getByRole('button', { name: 'Check approval' }).click();
    await expect.poll(() => pollCalls).toBe(1);
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect.element(page.getByText('7A3C-91F2')).not.toBeInTheDocument();
    await expect
      .element(page.getByRole('button', { name: 'Sign in or create account' }))
      .toBeEnabled();

    resolvePoll(connectedAccount);
    await expect.poll(() => pollReturned).toBe(true);
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    await expect.element(page.getByText('7A3C-91F2')).not.toBeInTheDocument();
    await expect.element(page.getByText('Sample User', { exact: true })).not.toBeInTheDocument();
    await expect
      .element(page.getByRole('button', { name: 'Sign in or create account' }))
      .toBeEnabled();
  });

  test('keeps every share progress stage inline on the originating Trace', async () => {
    const traceId = 'trc-20260727-research-brief';
    for (const progress of ['verifying', 'shared'] as const) {
      renderDashboard(
        `/traces/${traceId}`,
        createFixtureApi({
          initialShare: { traceId, visibility: 'unlisted', accessEnabled: true, progress },
        }),
      );
      const timeline = page.getByRole('list', { name: 'Share progress' });
      await expect
        .element(timeline.getByText(progress[0].toUpperCase() + progress.slice(1)))
        .toHaveAttribute('aria-current', 'step');
      await expect.element(page.getByRole('button', { name: 'Stop sharing' })).toBeVisible();
      await expect
        .element(page.getByRole('button', { name: 'Delete', exact: true }))
        .toBeDisabled();
      cleanup();
    }
  });

  test('shows private Captured detail, progress, retry, and ineligibility in one inspector', async () => {
    renderDashboard('/traces/trc-20260728-safety-review');
    await expect.element(page.getByText('Private on this device', { exact: true })).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Copy Trace ID' })).toBeVisible();
    await expect
      .element(page.getByRole('button', { name: 'Share', exact: true }))
      .not.toBeInTheDocument();
    await page.getByRole('tab', { name: 'Sealing' }).click();
    await expect
      .element(page.getByRole('progressbar', { name: 'Private transcript bytes authenticated' }))
      .toHaveAttribute('aria-valuenow', '612352');
    await expect.element(page.getByText('Attempt 1', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'View Trace activity' }).click();
    await expect
      .element(page.getByLabelText('Activity Trace ID'))
      .toHaveValue('trc-20260728-safety-review');

    cleanup();
    renderDashboard('/traces/trc-20260727-benchmark');
    await expect.element(page.getByRole('button', { name: 'Retry sealing' })).toBeVisible();
    await page.getByRole('tab', { name: 'Sealing' }).click();
    await expect.element(page.getByText('Attempt 2', { exact: true })).toBeVisible();
    await expect.element(page.getByText('notary_capacity', { exact: true }).first()).toBeVisible();

    cleanup();
    renderDashboard('/traces/trc-20260728-auth-error');
    await expect
      .element(page.getByText('Provider response cannot be sealed', { exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByRole('button', { name: 'Seal trace', exact: true }))
      .not.toBeInTheDocument();
  });

  test('moves a Trace atomically from Captured to Sealed on the same route', async () => {
    const fixture = createFixtureApi();
    const captured = structuredClone(fixtureCaptures[0]);
    const packageTemplate = await fixture.traceContent('trc-20260727-research-brief');
    let current: TraceSummary = captured;
    let packageReads = 0;
    const api: LocalApi = {
      ...fixture,
      traces: async () => ({ items: [current], next_cursor: null }),
      trace: async () => ({ ...(await fixture.trace(captured.trace_id)), ...current }),
      startNotarization: async (traceId) => {
        const result = await fixture.startNotarization(traceId);
        current = { ...current, state: 'notarized', status: null };
        return result;
      },
      traceContent: async (traceId) => {
        packageReads += 1;
        return { ...packageTemplate, trace_id: traceId };
      },
    };
    renderDashboard(`/traces/${captured.trace_id}`, api);
    await expect
      .element(page.getByRole('button', { name: 'Seal trace', exact: true }))
      .toBeVisible();
    expect(packageReads).toBe(0);
    await page.getByRole('button', { name: 'Seal trace', exact: true }).click();
    await expect.element(page.getByRole('button', { name: 'Export .llmtrace' })).toBeVisible();
    expect(window.location.hash).toBe(`#/traces/${captured.trace_id}`);
    expect(packageReads).toBeGreaterThan(0);
  });

  test('deletes one local Trace only after explicit confirmation', async () => {
    const fixture = createFixtureApi();
    const traceId = fixtureCaptures[0].trace_id;
    const deleteTrace = vi.fn((id: string) => fixture.deleteTrace(id));
    renderDashboard(`/traces/${traceId}`, { ...fixture, deleteTrace });

    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    const dialog = page.getByRole('alertdialog');
    await expect.element(dialog.getByRole('heading', { name: 'Delete this Trace?' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Delete Trace' }).click();

    await expect.poll(() => deleteTrace).toHaveBeenCalledWith(traceId);
    await expect.poll(() => window.location.hash).toBe('#/traces');
    await expect.element(page.getByText(traceId, { exact: false })).not.toBeInTheDocument();
  });

  test('keeps a local Trace when deletion confirmation is cancelled', async () => {
    const fixture = createFixtureApi();
    const traceId = 'trc-20260727-research-brief';
    const deleteTrace = vi.fn((id: string) => fixture.deleteTrace(id));
    renderDashboard(`/traces/${traceId}`, { ...fixture, deleteTrace });

    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    expect(deleteTrace).not.toHaveBeenCalled();
    expect(window.location.hash).toBe(`#/traces/${traceId}`);
    await expect.element(page.getByText(traceId, { exact: false }).first()).toBeVisible();
  });

  test('exports the exact package bytes with the canonical Trace identity', async () => {
    const fixture = createFixtureApi();
    const traceId = 'trc-20260727-research-brief';
    const packageBytes = new Blob(['exact package bytes'], { type: 'application/zip' });
    const downloadPackage = vi.fn(async () => packageBytes);
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:exact-package');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    let downloadedAs = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloadedAs = this.download;
    });
    renderDashboard(`/traces/${traceId}`, { ...fixture, downloadPackage });
    await page.getByRole('button', { name: 'Export .llmtrace' }).click();
    await expect.poll(() => downloadPackage).toHaveBeenCalledWith(traceId);
    expect(createObjectURL).toHaveBeenCalledWith(packageBytes);
    expect(downloadedAs).toBe(`${traceId}.llmtrace`);
  });

  test('opens the exact post-onboarding action for a sealed Trace', async () => {
    const fixture = createFixtureApi();
    const traceId = 'trc-20260727-research-brief';
    const packageBytes = new Blob(['first proof package'], { type: 'application/zip' });
    const downloadPackage = vi.fn(async () => packageBytes);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:first-proof-package');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    renderDashboard(`/traces/${traceId}?action=export`, { ...fixture, downloadPackage });
    await expect.poll(() => downloadPackage).toHaveBeenCalledWith(traceId);
    expect(window.location.hash).toBe(`#/traces/${traceId}?action=export`);

    cleanup();
    renderDashboard(`/traces/${traceId}?action=share`, fixture);
    await expect
      .element(page.getByRole('heading', { name: 'Review and share this Trace' }))
      .toBeVisible();
    expect(window.location.hash).toBe(`#/traces/${traceId}?action=share`);
  });

  test('automatically queues a captured first proof exactly once and shows sealing progress', async () => {
    const fixture = createFixtureApi();
    const traceId = fixtureCaptures[0].trace_id;
    const startNotarization = vi.fn((id: string) => fixture.startNotarization(id));

    renderDashboard(`/traces/${traceId}?action=first-proof`, {
      ...fixture,
      startNotarization,
    });

    await expect.poll(() => startNotarization).toHaveBeenCalledTimes(1);
    expect(startNotarization).toHaveBeenCalledWith(traceId);
    await expect.element(page.getByText('Waiting for proof worker', { exact: true })).toBeVisible();
    expect(window.location.hash).toBe(`#/traces/${traceId}?action=first-proof`);

    await page.getByRole('tab', { name: 'Summary' }).click();
    await page.getByRole('tab', { name: 'Sealing' }).click();
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    expect(startNotarization).toHaveBeenCalledTimes(1);
  });

  test('disarms a guided first proof when an active sealing attempt later fails', async () => {
    const fixture = createFixtureApi();
    const traceId = fixtureCaptures[0].trace_id;
    const baseDetail = await fixture.trace(traceId);
    const operationTemplate = structuredClone(fixtureOperations[0]);
    let started = false;
    let postStartDetailReads = 0;
    const startNotarization = vi.fn(async (id: string) => {
      const result = await fixture.startNotarization(id);
      started = true;
      return result;
    });
    const trace = vi.fn(async () => {
      if (!started) return baseDetail;
      postStartDetailReads += 1;
      const failed = postStartDetailReads > 1;
      return {
        ...baseDetail,
        status: failed ? ('notarization_failed' as const) : ('notarizing' as const),
        notarization: {
          ...operationTemplate,
          operation_id: 'op-first-proof-transition',
          trace_id: traceId,
          state: failed ? ('failed' as const) : ('queued' as const),
          retryable: failed,
          failure_code: failed ? 'notary_capacity' : null,
        },
      };
    });

    renderDashboard(`/traces/${traceId}?action=first-proof`, {
      ...fixture,
      trace,
      startNotarization,
    });

    await expect.poll(() => startNotarization).toHaveBeenCalledTimes(1);
    await expect
      .element(
        page.getByText(
          'A previous sealing attempt needs attention. Review it, then choose Retry sealing explicitly.',
          { exact: true },
        ),
      )
      .toBeVisible();
    expect(startNotarization).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe(`#/traces/${traceId}`);
  });

  test('keeps a completed seal armed while the captured summary catches up', async () => {
    const fixture = createFixtureApi();
    const traceId = fixtureCaptures[0].trace_id;
    const baseDetail = await fixture.trace(traceId);
    const completedOperation = structuredClone(
      fixtureOperations.find((operation) => operation.state === 'succeeded') ??
        fixtureOperations[0],
    );
    const startNotarization = vi.fn((id: string) => fixture.startNotarization(id));
    const trace = vi.fn(async () => ({
      ...baseDetail,
      notarization: {
        ...completedOperation,
        operation_id: 'op-first-proof-complete',
        trace_id: traceId,
        state: 'succeeded' as const,
        retryable: false,
      },
    }));

    renderDashboard(`/traces/${traceId}?action=first-proof`, {
      ...fixture,
      trace,
      startNotarization,
    });

    await expect
      .element(page.getByText('Creating your first proof', { exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByRole('button', { name: 'Seal trace', exact: true }))
      .not.toBeInTheDocument();
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    expect(startNotarization).not.toHaveBeenCalled();
    expect(window.location.hash).toBe(`#/traces/${traceId}?action=first-proof`);
  });

  test('never retries a failed first-proof sealing attempt without an explicit choice', async () => {
    const fixture = createFixtureApi();
    const traceId = 'trc-20260727-benchmark';
    const startNotarization = vi.fn((id: string) => fixture.startNotarization(id));

    renderDashboard(`/traces/${traceId}?action=first-proof`, {
      ...fixture,
      startNotarization,
    });

    await expect
      .element(
        page.getByText(
          'A previous sealing attempt needs attention. Review it, then choose Retry sealing explicitly.',
          { exact: true },
        ),
      )
      .toBeVisible();
    expect(startNotarization).not.toHaveBeenCalled();
    expect(window.location.hash).toBe(`#/traces/${traceId}`);
    await page.getByRole('button', { name: 'Retry sealing', exact: true }).click();
    await expect.poll(() => startNotarization).toHaveBeenCalledTimes(1);
  });

  test('automatically verifies a sealed first proof exactly once across rerenders', async () => {
    const fixture = createFixtureApi();
    const traceId = 'trc-20260727-research-brief';
    const verify = vi.fn((id: string) => fixture.verify(id));

    renderDashboard(`/traces/${traceId}?action=first-proof`, { ...fixture, verify });

    await expect.poll(() => verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith(traceId);
    await expect
      .element(page.getByText('Your first proof is sealed and verified.', { exact: true }))
      .toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Export .llmtrace' })).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Share' })).toBeVisible();
    expect(window.location.hash).toBe(`#/traces/${traceId}`);

    await page.getByRole('tab', { name: 'Technical' }).click();
    await page.getByRole('tab', { name: 'Evidence' }).click();
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    expect(verify).toHaveBeenCalledTimes(1);
  });

  test('reports the exact consumed first-proof handoff to the embedded desktop shell', async () => {
    const fixture = createFixtureApi();
    const traceId = 'trc-20260727-research-brief';
    const postMessage = vi.spyOn(window.parent, 'postMessage');

    renderDashboard(`/traces/${traceId}?action=first-proof`, fixture, true);

    await expect
      .poll(() =>
        postMessage.mock.calls.some(
          ([message]) =>
            typeof message === 'object' &&
            message !== null &&
            'type' in message &&
            message.type === 'notary:desktop-trace-action-consumed' &&
            'payload' in message &&
            (message.payload as { traceId?: unknown; action?: unknown }).traceId === traceId &&
            (message.payload as { action?: unknown }).action === 'first-proof',
        ),
      )
      .toBe(true);
  });

  test('does not celebrate a terminal verification result that did not pass', async () => {
    const fixture = createFixtureApi();
    const traceId = 'trc-20260727-research-brief';
    const verify = vi.fn(async (id: string) => ({
      ...(await fixture.verify(id)),
      outcome: 'failed' as const,
      failure_code: 'transcript_authentication_failed',
    }));

    renderDashboard(`/traces/${traceId}?action=first-proof`, { ...fixture, verify });

    await expect.poll(() => verify).toHaveBeenCalledTimes(1);
    await expect
      .element(
        page.getByText('The sealed package did not pass local verification.', { exact: false }),
      )
      .toBeVisible();
    await expect
      .element(page.getByText('Your first proof is sealed and verified.', { exact: true }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByText('Verification passed', { exact: true }))
      .not.toBeInTheDocument();
    expect(window.location.hash).toBe(`#/traces/${traceId}`);
  });

  test('keeps an unsupported verification result out of the passed receipt', async () => {
    const fixture = createFixtureApi();
    const traceId = 'trc-20260727-research-brief';
    const verify = vi.fn(async (id: string) => ({
      ...(await fixture.verify(id)),
      outcome: 'unsupported' as const,
      failure_code: 'package_version_unsupported',
    }));

    renderDashboard(`/traces/${traceId}?action=first-proof`, { ...fixture, verify });

    await expect
      .element(
        page.getByText('Local verification does not support this sealed package yet.', {
          exact: false,
        }),
      )
      .toBeVisible();
    await expect
      .element(page.getByText('Verification passed', { exact: true }))
      .not.toBeInTheDocument();
    expect(window.location.hash).toBe(`#/traces/${traceId}`);
  });

  test('rejects a passed verification response for a different Trace identity', async () => {
    const fixture = createFixtureApi();
    const traceId = 'trc-20260727-research-brief';
    const verify = vi.fn(async (id: string) => ({
      ...(await fixture.verify(id)),
      trace_id: 'trc-different-trace',
    }));

    renderDashboard(`/traces/${traceId}?action=first-proof`, { ...fixture, verify });

    await expect.poll(() => verify).toHaveBeenCalledTimes(1);
    await expect
      .element(
        page.getByText('The verification result did not identify this exact Trace.', {
          exact: false,
        }),
      )
      .toBeVisible();
    await expect
      .element(page.getByText('Your first proof is sealed and verified.', { exact: true }))
      .not.toBeInTheDocument();
    expect(window.location.hash).toBe(`#/traces/${traceId}`);
  });

  test('clears a persisted first-proof handoff when its exact Trace was deleted', async () => {
    const fixture = createFixtureApi();
    const missingTraceId = 'trc-missing-onboarding-test';
    const trace = vi.fn(async (id: string) => {
      if (id === missingTraceId) {
        throw new LocalApiError(404, 'trace_not_found', 'Trace not found');
      }
      return fixture.trace(id);
    });

    renderDashboard(`/traces/${missingTraceId}?action=first-proof`, { ...fixture, trace });

    await expect
      .element(page.getByText('First proof Trace not found', { exact: true }))
      .toBeVisible();
    expect(window.location.hash).toBe('#/traces');
  });

  test('keeps a failed guided verification explicit without hiding proof actions', async () => {
    const fixture = createFixtureApi();
    const traceId = 'trc-20260727-research-brief';
    const verify = vi.fn(async () => {
      throw new LocalApiError(422, 'trace_verification_failed', 'Trace verification failed');
    });

    renderDashboard(`/traces/${traceId}?action=first-proof`, { ...fixture, verify });

    await expect.poll(() => verify).toHaveBeenCalledTimes(1);
    await expect
      .element(
        page.getByText('Your first proof was sealed, but local verification failed.', {
          exact: true,
        }),
      )
      .toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Verify locally' })).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Export .llmtrace' })).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Share' })).toBeVisible();
  });

  test('uses explicit empty, loading, and error states for the trace collection', async () => {
    const fixture = createFixtureApi();
    const emptyApi: LocalApi = {
      ...fixture,
      traces: async () => ({ items: [], next_cursor: null }),
    };
    renderDashboard('/traces', emptyApi);
    await expect
      .element(page.getByRole('heading', { name: 'No traces have been captured yet.' }))
      .toBeVisible();
    await page.getByRole('button', { name: 'Captured', exact: true }).click();
    await expect
      .element(
        page.getByRole('heading', { name: 'No traces are currently in the Captured state.' }),
      )
      .toBeVisible();
    await page.getByRole('button', { name: 'Sealed', exact: true }).click();
    await expect
      .element(page.getByRole('heading', { name: 'No traces have been sealed yet.' }))
      .toBeVisible();
    await page.getByLabelText('Search traces').fill('missing');
    await expect
      .element(page.getByRole('heading', { name: 'No traces match these filters.' }))
      .toBeVisible();

    cleanup();
    renderDashboard('/traces', {
      ...fixture,
      traces: async () => {
        throw new LocalApiError(503, 'service_unavailable', 'Unavailable');
      },
    });
    await expect
      .element(page.getByRole('heading', { name: 'Traces are unavailable' }))
      .toBeVisible();

    cleanup();
    renderDashboard('/traces', {
      ...fixture,
      traces: () => new Promise(() => undefined),
    });
    await expect.element(page.getByText('Loading local evidence', { exact: true })).toBeVisible();
  });

  test('uses the generated Trace date-filter contract', async () => {
    const fixture = createFixtureApi();
    const filters: Array<Parameters<LocalApi['traces']>[0]> = [];
    const api: LocalApi = {
      ...fixture,
      traces: async (next = {}) => {
        filters.push(next);
        return fixture.traces(next);
      },
    };
    renderDashboard('/traces', api);
    await page.getByLabelText('Trace time filter').click();
    await page.getByRole('option', { name: 'Last 24 hours' }).click();
    await expect.poll(() => filters.at(-1)?.created_from_unix_ms).toBeTypeOf('number');
  });

  test('puts signed-in AI tools before provider API and SDK routes', async () => {
    renderDashboard('/providers');
    await expect.element(page.getByRole('heading', { name: 'AI connections' })).toBeVisible();
    await expect.element(page.getByText('Local admin').first()).toBeVisible();
    await expect.element(page.getByRole('heading', { name: 'Connect your AI tool' })).toBeVisible();
    await expect
      .poll(() =>
        Array.from(document.querySelectorAll('.provider-client-list h2')).map((heading) =>
          heading.textContent?.trim(),
        ),
      )
      .toEqual(['Codex CLI', 'Claude Code']);
    await expect
      .poll(() =>
        Array.from(document.querySelectorAll('.provider-api-list h2')).map((heading) =>
          heading.textContent?.trim(),
        ),
      )
      .toEqual(['OpenAI', 'Anthropic', 'DeepSeek', 'OpenRouter']);
    await expect
      .element(page.getByRole('heading', { name: 'OpenAI Codex' }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByText('http://127.0.0.1:8787/openai/v1', { exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByText('http://127.0.0.1:8787/codex', { exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByText('http://127.0.0.1:8787/anthropic', { exact: true }).first())
      .toBeVisible();
    await expect.element(page.getByText('ready', { exact: true }).first()).toBeVisible();
    await expect.element(page.getByText(/saved product logins stay there/)).toBeVisible();
    await page.getByText('Setup Codex CLI', { exact: true }).click();
    await expect
      .element(page.getByText(/base_url = "http:\/\/127\.0\.0\.1:8787\/codex"/))
      .toBeVisible();
    await expect.element(page.getByText(/model_provider = "capture-chatgpt"/)).toBeVisible();
    await page.getByText('Setup Claude Code', { exact: true }).click();
    await expect
      .element(page.getByText(/ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:8787\/anthropic/))
      .toBeVisible();
    await page.getByText('OpenAI route details', { exact: true }).click();
    await expect.element(page.getByText('api.openai.com', { exact: true }).first()).toBeVisible();
    await expect
      .element(page.getByText('On, supported requests create traces', { exact: true }).first())
      .toBeVisible();
    await expect.element(page.getByText('Ollama', { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByPlaceholder('Provider host')).not.toBeInTheDocument();
  });

  test('copies tool setup and explains temporary onboarding API keys', async () => {
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    renderDashboard('/providers');
    for (const name of [
      'Copy OpenAI Codex base URL',
      'Copy Claude Code base URL',
      'Copy OpenAI base URL',
      'Copy Anthropic base URL',
      'Copy DeepSeek base URL',
      'Copy OpenRouter base URL',
    ]) {
      await expect.element(page.getByRole('button', { name })).toBeVisible();
    }
    await page.getByRole('button', { name: 'Copy OpenAI base URL' }).click();
    expect(writeText).toHaveBeenCalledWith('http://127.0.0.1:8787/openai/v1');
    await page.getByText('Setup Codex CLI', { exact: true }).click();
    await page.getByRole('button', { name: 'Copy config' }).click();
    expect(writeText).toHaveBeenLastCalledWith(
      expect.stringContaining('requires_openai_auth = true'),
    );
    await page.getByText('Setup Claude Code', { exact: true }).click();
    await page.getByRole('button', { name: 'Copy command' }).click();
    expect(writeText).toHaveBeenLastCalledWith(
      expect.stringContaining('ANTHROPIC_BASE_URL=http://127.0.0.1:8787/anthropic'),
    );
    await expect
      .element(page.getByText(/optional onboarding test can hold a pasted key in memory/).first())
      .toBeVisible();
    await expect
      .poll(
        () =>
          Array.from(document.querySelectorAll('.provider-route')).find(
            (card) => card.querySelector('h2')?.textContent === 'OpenAI',
          )?.textContent,
      )
      .toContain('never saves it');
    await expect
      .poll(
        () =>
          Array.from(document.querySelectorAll('.provider-route')).find(
            (card) => card.querySelector('h2')?.textContent === 'DeepSeek',
          )?.textContent,
      )
      .toContain('does not store or substitute it');
  });

  test('builds signed-in client setup from the advertised route URLs', async () => {
    const fixture = createFixtureApi();
    const api: LocalApi = {
      ...fixture,
      providers: async () => {
        const catalog = await fixture.providers();
        return {
          providers: catalog.providers.map((route) => ({
            ...route,
            proxy_base_url: `https://capture.example${route.route_prefix}`,
          })),
        };
      },
    };
    renderDashboard('/providers', api);
    await page.getByText('Setup Codex CLI', { exact: true }).click();
    await expect
      .element(page.getByText(/base_url = "https:\/\/capture\.example\/codex"/))
      .toBeVisible();
    await page.getByText('Setup Claude Code', { exact: true }).click();
    await expect
      .element(page.getByText(/ANTHROPIC_BASE_URL=https:\/\/capture\.example\/anthropic/))
      .toBeVisible();
  });

  test('keeps provider routes out of Settings and preserves the required group order', async () => {
    renderDashboard('/settings');
    await expect
      .poll(() =>
        Array.from(document.querySelectorAll('.settings-group-title')).map(
          (heading) => heading.textContent,
        ),
      )
      .toEqual(['General', 'Account', 'Sealing', 'Security & storage', 'Service', 'Developer']);
    await expect.element(page.getByText('Proxy base URLs')).not.toBeInTheDocument();
  });

  test('changes capture behavior and persists an explicit theme', async () => {
    const api = createFixtureApi();
    renderDashboard('/settings', api);
    const toggle = page.getByRole('switch', { name: 'Capture requests' });
    await toggle.click();
    await expect.element(toggle).not.toBeChecked();
    await expect
      .element(page.getByText('Off, requests still pass through', { exact: false }))
      .toBeVisible();
    await expect.poll(async () => (await api.captureSetting()).enabled).toBe(false);
    await page.getByRole('button', { name: 'Dark color scheme' }).click();
    expect(localStorage.getItem('mantine-color-scheme-value')).toBe('dark');
  });

  test('turns capture on directly from Overview', async () => {
    const fixture = createFixtureApi();
    let captureEnabled = false;
    const api: LocalApi = {
      ...fixture,
      status: async () => ({
        ...(await fixture.status()),
        capture_enabled: captureEnabled,
        counts: {
          captured: 0,
          notarizing: 0,
          notarized: 0,
          needs_attention: 0,
          capturing: 0,
          capture_failed: 0,
        },
      }),
      updateCaptureSetting: async (enabled) => {
        captureEnabled = enabled;
        return { enabled };
      },
    };
    renderDashboard('/overview', api);
    await page.getByRole('button', { name: 'Turn capture on' }).click();
    await expect.poll(() => captureEnabled).toBe(true);
    await expect.element(page.getByRole('button', { name: 'View providers' })).toBeVisible();
  });

  test('shows pinned notary lifecycle records in trust order without health claims', async () => {
    const api: LocalApi = {
      ...createFixtureApi(),
      notaries: async () => ({
        ...structuredClone(fixtureNotaries),
        notaries: [...structuredClone(fixtureNotaries.notaries)].reverse(),
      }),
    };
    renderDashboard('/settings', api);
    await expect
      .poll(() =>
        Array.from(document.querySelectorAll('.local-notary-record h3')).map(
          (node) => node.textContent,
        ),
      )
      .toEqual([
        'Accepts new captures and sealing',
        'Sealing-only',
        'Historical verification only',
        'Untrusted',
      ]);
    await expect.element(page.getByText('Online', { exact: true })).not.toBeInTheDocument();
  });

  test('renders cluster administration context without making local-only claims', async () => {
    const fixture = createFixtureApi();
    const clusterStatus = {
      ...(await fixture.status()),
      runtime_profile: 'cluster',
      instance_id: 'notary-2',
      proxy_origin: 'https://proxy.notary.example',
      admin_origin: 'https://admin.notary.example',
      metadata_backend: 'postgres',
      artifact_backend: 's3',
      vault: 'shared cluster key',
    };
    const api: LocalApi = {
      ...fixture,
      status: async () => clusterStatus,
      providers: async () => ({
        providers: [
          {
            id: 'openai',
            name: 'OpenAI',
            host: 'api.openai.com',
            client_api: 'responses',
            route_prefix: '/openai/v1',
            proxy_base_url: 'https://proxy.notary.example/openai/v1',
            ready: true,
          },
        ],
      }),
    };
    renderDashboard('/providers', api);
    await expect.element(page.getByText('Cluster admin').first()).toBeVisible();
    await expect.element(page.getByText('https://proxy.notary.example/openai/v1')).toBeVisible();
    cleanup();
    renderDashboard('/settings', api);
    await expect.element(page.getByRole('heading', { name: 'Cluster endpoints' })).toBeVisible();
    await expect.element(page.getByText('notary-2', { exact: true })).toBeVisible();
    await expect
      .element(page.getByText('Both listeners are restricted to loopback.', { exact: true }))
      .not.toBeInTheDocument();
    await expect.element(page.getByText('Cluster admin')).toBeVisible();
  });

  test('keeps admin authentication distinct from the hosted Account setting', async () => {
    const api: LocalApi = {
      ...createFixtureApi(),
      status: async () => {
        throw new LocalApiError(401, 'unauthorized', 'Unauthorized');
      },
    };
    renderDashboard('/overview', api, true);
    await expect.element(page.getByText('Exalto Capture', { exact: true })).toBeVisible();
    await expect
      .element(page.getByText('Exalto Capture administration', { exact: true }))
      .toBeVisible();
    await expect.element(page.getByText('Notary', { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect
      .element(page.getByText('credentials configured under admin.auth', { exact: false }))
      .toBeVisible();
    await expect.element(page.getByText('Hosted account connection')).not.toBeInTheDocument();
    await expect.element(page.getByText('Loopback only')).not.toBeInTheDocument();
  });

  test('does not show stale readiness after a status failure', async () => {
    const api: LocalApi = {
      ...createFixtureApi(),
      status: async () => {
        throw new LocalApiError(503, 'service_unavailable', 'Unavailable');
      },
    };
    renderDashboard('/overview', api);
    await expect
      .element(page.getByRole('heading', { name: 'The local service is unavailable' }))
      .toBeVisible();
    await expect.element(page.getByText('Online', { exact: true })).not.toBeInTheDocument();
  });

  test('uses the same route content in embedded mode without standalone navigation', async () => {
    const postMessage = vi.spyOn(window.parent, 'postMessage');
    renderDashboard('/providers', createFixtureApi(), true);
    await expect.element(page.getByRole('heading', { name: 'OpenAI', exact: true })).toBeVisible();
    await expect
      .element(page.getByRole('heading', { name: 'AI connections' }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole('navigation', { name: 'Admin dashboard' }))
      .not.toBeInTheDocument();
    await expect
      .poll(() =>
        postMessage.mock.calls.some(
          ([message]) =>
            typeof message === 'object' &&
            message !== null &&
            'type' in message &&
            message.type === 'notary:desktop-route-change' &&
            'payload' in message &&
            (message.payload as { view?: unknown }).view === 'providers',
        ),
      )
      .toBe(true);
    postMessage.mockClear();
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window.parent,
        data: { type: 'notary:desktop-ready-request' },
      }),
    );
    await expect
      .poll(() =>
        postMessage.mock.calls.some(
          ([message]) =>
            typeof message === 'object' &&
            message !== null &&
            'type' in message &&
            message.type === 'notary:desktop-route-change' &&
            'payload' in message &&
            (message.payload as { view?: unknown }).view === 'providers',
        ),
      )
      .toBe(true);
  });

  test('uses exactly four Settings groups in embedded desktop mode', async () => {
    const actions: DesktopSettingsAction[] = [];
    renderDashboard('/settings', createFixtureApi(), true, desktopSettings, (action) =>
      actions.push(action),
    );
    await expect
      .poll(() =>
        Array.from(document.querySelectorAll('.settings-group-title')).map(
          (heading) => heading.textContent,
        ),
      )
      .toEqual(['Connections', 'Privacy & storage', 'App', 'Advanced']);
    await expect
      .element(page.getByRole('switch', { name: 'Open Exalto Capture at sign-in' }))
      .toBeChecked();
    await expect
      .element(page.getByText(/Closing the window leaves Exalto Capture available/))
      .toBeVisible();
    await expect
      .element(page.getByText('Menu-bar controller', { exact: true }))
      .not.toBeInTheDocument();
    await page.getByRole('switch', { name: 'Open Exalto Capture at sign-in' }).click();
    await page.getByRole('button', { name: 'Check now' }).click();
    await page.getByRole('button', { name: 'Restart to update' }).click();
    expect(actions).toEqual([
      { action: 'set_launch_at_login', enabled: false },
      { action: 'check_for_updates' },
      { action: 'restart_to_update' },
    ]);
  });

  test('shows embedded account, local data, sealing service, updates, and advanced consequences', async () => {
    renderDashboard('/settings', createFixtureApi(), true, desktopSettings);
    await expect.element(page.getByText('Sample User', { exact: true })).toBeVisible();
    await expect.element(page.getByText(/does not upload or share local traces/)).toBeVisible();
    await expect.element(page.getByText('Local data', { exact: true })).toBeVisible();
    await expect
      .element(page.getByText(/not protected by the private-capture vault/))
      .toBeVisible();
    await expect.element(page.getByRole('heading', { name: 'Exalto Seal' })).toBeVisible();
    await expect.element(page.getByText('Signer', { exact: true }).first()).toBeVisible();
    await expect.element(page.getByText('Seal', { exact: true }).first()).toBeVisible();
    await expect
      .element(page.getByText('Operated by Exalto', { exact: true }).first())
      .not.toBeInTheDocument();
    await expect.element(page.getByText('Alice', { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByText('Active verification key', { exact: true })).toBeVisible();
    await page.getByText('View details', { exact: true }).click();
    await expect.element(page.getByRole('heading', { name: 'seal1' })).toBeVisible();
    await expect.element(page.getByRole('heading', { name: 'seal3' })).toBeVisible();
    await expect.element(page.getByText('Verification key', { exact: true }).first()).toBeVisible();
    await expect.element(page.getByText(/installed macOS identity/)).toBeVisible();
    await expect
      .element(page.getByText('ai.exalto.capture', { exact: false }))
      .not.toBeInTheDocument();
    await expect.element(page.getByText('Service', { exact: true })).toBeVisible();
    await expect.element(page.getByText('Developer', { exact: true })).toBeVisible();
    await expect.element(page.getByText('Provider routes')).not.toBeInTheDocument();
  });

  test('does not brand third-party or explicit sealing trust as Exalto Seal', async () => {
    const thirdParty: LocalApi = {
      ...createFixtureApi(),
      notaries: async () => ({
        ...fixtureNotaries,
        registry_source: 'https://seal.example/api/registry',
        notaries: fixtureNotaries.notaries.map((record, index) => ({
          ...record,
          name: index === 0 ? 'Northstar Seal' : record.name,
        })),
      }),
    };
    renderDashboard('/settings', thirdParty, true, desktopSettings);
    await expect.element(page.getByRole('heading', { name: 'Northstar Seal' })).toBeVisible();
    await expect.element(page.getByText('Exalto Seal', { exact: true })).not.toBeInTheDocument();

    cleanup();
    const explicit: LocalApi = {
      ...createFixtureApi(),
      notaries: async () => ({
        ...fixtureNotaries,
        source: 'explicit_configuration',
        registry_source: null,
        active_key_id: null,
        notaries: [
          {
            ...fixtureNotaries.notaries[0],
            name: 'Configured notary',
            lifecycle: 'configured',
          },
        ],
      }),
    };
    renderDashboard('/settings', explicit, true, desktopSettings);
    await expect
      .element(page.getByRole('heading', { name: 'Configured sealing service' }))
      .toBeVisible();
    await expect.element(page.getByText('Exalto Seal', { exact: true })).not.toBeInTheDocument();
  });

  test('renders reconnect and blocked-update states without implying local upload', async () => {
    const fixture = createFixtureApi();
    const readyUpdate = desktopSettings.update;
    if (!readyUpdate) throw new Error('desktop update fixture is required');
    const api: LocalApi = {
      ...fixture,
      account: async () => ({
        signed_in: false,
        connection_state: 'reauthorization_required',
        links: (await fixture.account()).links,
      }),
    };
    renderDashboard('/settings', api, true, {
      ...desktopSettings,
      update: { ...readyUpdate, phase: 'ready' },
      restart_block_reason: 'Wait for the active seal to finish before restarting to update.',
    });
    await expect.element(page.getByRole('button', { name: 'Reconnect' })).toBeVisible();
    await expect
      .element(page.getByText('Wait for the active seal to finish before restarting to update.'))
      .toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Restart to update' })).toBeDisabled();
  });

  test('uses an accessible navigation drawer on narrow screens', async () => {
    await page.viewport(800, 760);
    renderDashboard();
    await page.getByRole('button', { name: 'Open navigation' }).click();
    const drawer = page.getByRole('dialog');
    await expect.element(drawer).toBeVisible();
    await drawer.getByRole('button', { name: /Activity/ }).click();
    await expect.element(page.getByRole('combobox', { name: 'Activity severity' })).toBeVisible();
  });

  test('sends activity filters to the service', async () => {
    const fixture = createFixtureApi();
    let receivedFilters: Record<string, string | number | boolean | undefined> = {};
    const api: LocalApi = {
      ...fixture,
      events: async (filters = {}) => {
        receivedFilters = filters;
        return fixture.events(filters);
      },
    };
    renderDashboard('/activity', api);
    await expect.element(page.getByRole('combobox', { name: 'Activity severity' })).toBeVisible();
    await expect
      .element(page.getByRole('combobox', { name: 'Activity time filter' }))
      .toBeVisible();
    await expect.element(page.getByLabelText('Activity Trace ID')).toBeVisible();
    await expect.element(page.getByLabelText('Activity operation ID')).not.toBeInTheDocument();
    await page.getByRole('button', { name: 'More filters' }).click();
    await page.getByLabelText('Activity raw event name').fill('notarization_completed');
    await expect.poll(() => receivedFilters.event_type).toBe('notarization_completed');
    await expect.element(page.getByText('Sealing completed').first()).toBeVisible();
    await expect.element(page.getByText('Sealing failed')).not.toBeInTheDocument();
  });

  test('opens Trace-linked activity and keeps safe technical details inspectable', async () => {
    renderDashboard('/activity');
    const failed = page.getByText('Sealing failed', { exact: true }).first();
    await expect.element(failed).toBeVisible();
    const failedRow = Array.from(document.querySelectorAll<HTMLElement>('.event-row')).find((row) =>
      row.textContent?.includes('Sealing failed'),
    );
    const technicalDetails = failedRow?.querySelector<HTMLElement>('summary');
    if (!technicalDetails) throw new Error('failed Activity details are missing');
    await userEvent.click(technicalDetails);
    await expect.element(page.getByText('notary_capacity', { exact: true })).toBeVisible();
    await expect.element(page.getByText('notarization_failed', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Trace ID · trc-20260728-safety-review' }).click();
    await expect.element(page.getByRole('button', { name: 'Copy Trace ID' })).toBeVisible();
    expect(window.location.hash).toBe('#/traces/trc-20260728-safety-review');
  });

  test('keeps service-only events inspectable and Activity free of Trace contents', async () => {
    const fixture = createFixtureApi();
    const api: LocalApi = {
      ...fixture,
      events: async () => ({
        items: [
          {
            event_id: 99,
            created_at_unix_ms: Date.now(),
            event_type: 'capture_enabled',
            severity: 'info',
            message: 'Capture enabled',
          },
        ],
        next_cursor: null,
        high_water_cursor: null,
      }),
    };
    renderDashboard('/activity', api);
    await expect.element(page.getByText('Capture turned on', { exact: true })).toBeVisible();
    await expect.element(page.getByText('Service event', { exact: true })).toBeVisible();
    await page.getByText('Technical details').click();
    await expect.element(page.getByText('capture_enabled', { exact: true })).toBeVisible();
    await expect
      .element(page.getByText(fixtureCaptures[0].prompt_preview, { exact: true }))
      .not.toBeInTheDocument();
  });

  test('uses a separate trace list and detail view on mobile', async () => {
    await page.viewport(390, 760);
    renderDashboard('/traces');
    await expect.element(page.getByRole('list', { name: 'Traces' })).toBeVisible();
    await page.getByRole('list', { name: 'Traces' }).getByRole('button').first().click();
    await expect.element(page.getByRole('button', { name: 'All traces' })).toBeVisible();
    await expect.element(page.getByRole('list', { name: 'Traces' })).not.toBeInTheDocument();
  });

  test('persists the adjustable trace list width', async () => {
    await page.viewport(1280, 800);
    renderDashboard('/traces');
    const divider = page.getByRole('separator', { name: 'Resize list and detail panels' });
    await expect.element(divider).toHaveAttribute('aria-valuenow', '380');
    document.querySelector<HTMLElement>('[role="separator"]')?.focus();
    await userEvent.keyboard('{ArrowRight}');
    await expect.element(divider).toHaveAttribute('aria-valuenow', '396');
    expect(localStorage.getItem('notary-admin-dashboard-split-width')).toBe('396');
  });

  test('preserves a persisted Listed share without changing its visibility', async () => {
    const traceId = 'trc-20260727-research-brief';
    const api = createFixtureApi({
      initialShare: { traceId, visibility: 'listed', accessEnabled: true },
    });
    renderDashboard(`/traces/${traceId}`, api);

    await expect.element(page.getByText('Shared', { exact: true }).first()).toBeVisible();
    await expect
      .element(page.getByText('This disclosed Trace is publicly listed and readable.'))
      .toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Copy link' })).toBeVisible();
    await expect.element(page.getByRole('link', { name: 'Open shared trace' })).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Manage access' })).toBeVisible();
    await expect
      .element(page.getByRole('button', { name: 'Share', exact: true }))
      .not.toBeInTheDocument();
  });

  test('manages visibility, password, and expiration on the canonical share', async () => {
    const traceId = 'trc-20260727-research-brief';
    const fixture = createFixtureApi({
      initialShare: {
        traceId,
        visibility: 'listed',
        accessEnabled: true,
        passwordProtected: true,
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      },
    });
    let requestedSettings: Parameters<LocalApi['share']>[1] | null = null;
    const api: LocalApi = {
      ...fixture,
      share: async (id, settings) => {
        requestedSettings = settings;
        return fixture.share(id, settings);
      },
    };
    renderDashboard(`/traces/${traceId}`, api);

    await page.getByRole('button', { name: 'Manage access' }).click();
    await expect.element(page.getByRole('heading', { name: 'Manage access' })).toBeVisible();
    await page.getByLabelText('Share visibility').click();
    await page.getByRole('option', { name: 'Unlisted · link access' }).click();
    await page.getByLabelText('Password protection').click();
    await page.getByRole('option', { name: 'Remove password' }).click();
    await page.getByLabelText('Share expiration').click();
    await page.getByRole('option', { name: 'No expiration' }).click();
    await page.getByRole('button', { name: 'Save access' }).click();

    expect(requestedSettings).toEqual({
      visibility: 'unlisted',
      password: '',
      expires_in_days: 0,
    });
    await expect
      .element(page.getByText('Anyone with this URL can read the disclosed Trace.'))
      .toBeVisible();
    await expect
      .element(page.getByRole('link', { name: 'Open shared trace' }))
      .toHaveAttribute('href', 'https://notary.example/traces/share-fixture');
  });

  test('keeps failed and rejected shares actionable with safe details', async () => {
    const traceId = 'trc-20260727-research-brief';
    renderDashboard(
      `/traces/${traceId}`,
      createFixtureApi({
        initialShare: {
          traceId,
          visibility: 'unlisted',
          accessEnabled: false,
          progress: 'failed',
          failureCode: 'upload_expired',
        },
      }),
    );
    await expect.element(page.getByText('Sharing failed', { exact: true })).toBeVisible();
    await expect.element(page.getByText('upload_expired')).toBeVisible();
    await page.getByRole('button', { name: 'Retry sharing' }).click();
    await expect
      .element(page.getByRole('heading', { name: 'Review and retry sharing' }))
      .toBeVisible();
    await page.getByRole('button', { name: 'Share trace' }).click();
    await expect.element(page.getByText('Verifying', { exact: true }).first()).toBeVisible();

    cleanup();
    const rejectedFixture = createFixtureApi({
      initialShare: {
        traceId,
        visibility: 'unlisted',
        accessEnabled: false,
        progress: 'rejected',
        failureCode: 'high_entropy_value_trace',
      },
    });
    let retrySettings: Parameters<LocalApi['share']>[1] | null = null;
    renderDashboard(`/traces/${traceId}`, {
      ...rejectedFixture,
      share: async (id, settings) => {
        retrySettings = settings;
        return rejectedFixture.share(id, settings);
      },
    });
    await expect.element(page.getByText('Rejected', { exact: true })).toBeVisible();
    await expect.element(page.getByText('high_entropy_value_trace')).toBeVisible();
    await page.getByRole('button', { name: 'Review and retry' }).click();
    await expect
      .element(page.getByText(/Retry can override only a reviewed unexplained high-entropy/))
      .toBeVisible();
    await page.getByRole('button', { name: 'Share trace' }).click();
    await expect.element(page.getByText('Verifying', { exact: true }).first()).toBeVisible();
    expect(retrySettings).toEqual({ visibility: 'unlisted', force: true });
  });

  test('offers an explicit local review for unexplained high-entropy disclosure', async () => {
    const traceId = 'trc-20260727-research-brief';
    const fixture = createFixtureApi();
    const requestedSettings: Parameters<LocalApi['share']>[1][] = [];
    let firstAttempt = true;
    const api: LocalApi = {
      ...fixture,
      share: async (id, settings) => {
        requestedSettings.push(settings);
        if (firstAttempt) {
          firstAttempt = false;
          throw new LocalApiError(
            409,
            'share_high_entropy_review_required',
            'Disclosure review is required',
          );
        }
        return fixture.share(id, settings);
      },
    };
    renderDashboard(`/traces/${traceId}`, api);

    await page.getByRole('button', { name: 'Share', exact: true }).click();
    await page.getByRole('button', { name: 'Share trace' }).click();
    await expect
      .element(page.getByText(/An unexplained high-entropy value was found/))
      .toBeVisible();
    await page.getByRole('button', { name: 'Share after review' }).click();
    expect(requestedSettings).toEqual([
      { visibility: 'unlisted', expires_in_days: 0, password: '' },
      { visibility: 'unlisted', expires_in_days: 0, password: '', force: true },
    ]);
  });

  test('does not present an access-disabled share as publicly readable', async () => {
    const traceId = 'trc-20260727-research-brief';
    const api = createFixtureApi({
      initialShare: {
        traceId,
        visibility: 'unlisted',
        accessEnabled: false,
        progress: 'stopped',
      },
    });
    renderDashboard(`/traces/${traceId}`, api);

    await expect.element(page.getByText('Public access is disabled for this share.')).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Manage access' })).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Resume sharing' })).toBeVisible();
    await expect
      .element(page.getByRole('button', { name: 'Stop sharing' }))
      .not.toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Copy link' })).not.toBeInTheDocument();
    await expect
      .element(page.getByRole('button', { name: 'Share', exact: true }))
      .not.toBeInTheDocument();
  });

  test('keeps an expired access-disabled share editable and locally deletable', async () => {
    const traceId = 'trc-20260727-research-brief';
    const api = createFixtureApi({
      initialShare: {
        traceId,
        visibility: 'unlisted',
        accessEnabled: false,
        progress: 'shared',
        expiresAt: Date.now() - 60_000,
      },
    });
    renderDashboard(`/traces/${traceId}`, api);

    await expect.element(page.getByText('Public access for this share has expired.')).toBeVisible();
    await expect
      .element(page.getByRole('button', { name: 'Resume sharing' }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole('button', { name: 'Stop sharing' }))
      .not.toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Delete', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Manage access' }).click();
    await page.getByLabelText('Share expiration').click();
    await page.getByRole('option', { name: '7 days from now' }).click();
    await page.getByRole('button', { name: 'Save access' }).click();
    await expect
      .element(page.getByText('Anyone with this URL can read the disclosed Trace.'))
      .toBeVisible();
  });

  test('requires a new expiration choice when resuming an expired stopped share', async () => {
    const traceId = 'trc-20260727-research-brief';
    const fixture = createFixtureApi({
      initialShare: {
        traceId,
        visibility: 'unlisted',
        accessEnabled: false,
        progress: 'stopped',
        expiresAt: Date.now() - 60_000,
      },
    });
    let requestedSettings: Parameters<LocalApi['share']>[1] | null = null;
    const api: LocalApi = {
      ...fixture,
      share: async (id, settings) => {
        requestedSettings = settings;
        return fixture.share(id, settings);
      },
    };
    renderDashboard(`/traces/${traceId}`, api);

    await page.getByRole('button', { name: 'Resume sharing' }).click();
    await expect
      .element(page.getByLabelText('Share expiration'))
      .toHaveTextContent('No expiration');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Resume sharing' }).click();
    expect(requestedSettings).toEqual({
      visibility: 'unlisted',
      expires_in_days: 0,
      reactivate: true,
    });
    await expect
      .element(page.getByText('Anyone with this URL can read the disclosed Trace.'))
      .toBeVisible();
  });

  test('keeps the last persisted share visible when status refresh fails', async () => {
    const traceId = 'trc-20260727-research-brief';
    const fixture = createFixtureApi({
      initialShare: { traceId, visibility: 'unlisted', accessEnabled: true },
    });
    const api: LocalApi = {
      ...fixture,
      shareStatus: async () => {
        throw new LocalApiError(503, 'share_status_unavailable', 'Unavailable');
      },
    };
    renderDashboard(`/traces/${traceId}`, api);

    await expect.element(page.getByText('Shared', { exact: true }).first()).toBeVisible();
    await expect
      .element(page.getByText('Could not refresh share status. Showing the last known state.'))
      .toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Stop sharing' })).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Retry status' })).toBeVisible();
    await expect
      .element(page.getByRole('button', { name: 'Share', exact: true }))
      .not.toBeInTheDocument();
  });

  test('restores a persisted share when the Trace inspector reloads', async () => {
    const traceId = 'trc-20260727-research-brief';
    const fixture = createFixtureApi();
    const resharedSettings: Parameters<LocalApi['share']>[1][] = [];
    const api: LocalApi = {
      ...fixture,
      share: async (id, settings) => {
        resharedSettings.push(settings);
        return fixture.share(id, settings);
      },
    };
    await fixture.share(traceId, { visibility: 'unlisted' });
    await api.shareStatus(traceId);
    await api.shareStatus(traceId);
    await api.shareStatus(traceId);

    renderDashboard(`/traces/${traceId}`, api);
    await expect.element(page.getByRole('button', { name: 'Copy link' })).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Stop sharing' })).toBeVisible();

    cleanup();
    renderDashboard(`/traces/${traceId}`, api);
    await expect.element(page.getByRole('button', { name: 'Copy link' })).toBeVisible();
    await page.getByRole('button', { name: 'Stop sharing' }).click();
    await expect
      .element(page.getByRole('heading', { name: 'Stop sharing this Trace?' }))
      .toBeVisible();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Stop sharing' }).click();
    await expect
      .element(page.getByRole('button', { name: 'Stop sharing' }))
      .not.toBeInTheDocument();
    await expect.element(page.getByText('Public access is disabled for this share.')).toBeVisible();

    await page.getByRole('button', { name: 'Manage access' }).click();
    await page.getByRole('button', { name: 'Save access' }).click();
    await expect.element(page.getByText('Public access is disabled for this share.')).toBeVisible();
    expect(resharedSettings.at(-1)).toEqual({ visibility: 'unlisted' });

    await page.getByRole('button', { name: 'Resume sharing' }).click();
    await expect.element(page.getByRole('heading', { name: 'Resume sharing' })).toBeVisible();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Resume sharing' }).click();
    await expect.element(page.getByRole('button', { name: 'Copy link' })).toBeVisible();
    expect(resharedSettings.at(-1)).toEqual({ visibility: 'unlisted', reactivate: true });
  });
});
