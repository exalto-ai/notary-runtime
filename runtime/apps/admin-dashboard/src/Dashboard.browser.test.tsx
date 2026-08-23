import { createTheme, MantineProvider } from '@mantine/core';
import { Notifications, notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { type LocalApi, LocalApiError, type TraceSummary } from './api';
import { Dashboard, type DesktopSettingsAction, type DesktopSettingsState } from './Dashboard';
import { createFixtureApi, fixtureCaptures, fixtureNotaries } from './fixtures';
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
      .toEqual(['4Captured', '1Notarizing', '2Notarized', '1Needs attention']);
    await page.getByRole('button', { name: /Notarizing/ }).click();
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
    await expect
      .element(page.getByRole('button', { name: 'Notarized', exact: true }))
      .toBeVisible();
    await expect.element(page.getByRole('combobox', { name: 'Provider filter' })).toBeVisible();
    await expect.element(page.getByRole('combobox', { name: 'Trace time filter' })).toBeVisible();
    await expect
      .element(page.getByRole('combobox', { name: 'Operational status filter' }))
      .toBeVisible();
    await expect.element(page.getByText('notarizing', { exact: true }).first()).toBeVisible();

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
      .element(page.getByText('Captured · Notarizing', { exact: true }).first())
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

  test('opens notarized evidence from the same trace route', async () => {
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
    await expect.element(page.getByRole('tab', { name: 'Notarization' })).toBeVisible();
    await expect.element(page.getByRole('tab', { name: 'Evidence' })).toBeVisible();
    await expect.element(page.getByRole('tab', { name: 'Technical' })).toBeVisible();
    await expect.element(page.getByText('Private on this device', { exact: true })).toBeVisible();
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
    await expect.element(page.getByText('NOTARY-7K3')).toBeVisible();
    await page.getByRole('button', { name: 'Check approval' }).click();
    await expect
      .element(page.getByRole('heading', { name: 'Review and share this Trace' }))
      .toBeVisible();
    expect(window.location.hash).toBe('#/traces/trc-20260727-research-brief');
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
    await page.getByRole('tab', { name: 'Notarization' }).click();
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
    await expect.element(page.getByRole('button', { name: 'Retry notarization' })).toBeVisible();
    await page.getByRole('tab', { name: 'Notarization' }).click();
    await expect.element(page.getByText('Attempt 2', { exact: true })).toBeVisible();
    await expect.element(page.getByText('notary_capacity', { exact: true }).first()).toBeVisible();

    cleanup();
    renderDashboard('/traces/trc-20260728-auth-error');
    await expect
      .element(page.getByText('Provider response cannot be notarized', { exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByRole('button', { name: 'Notarize', exact: true }))
      .not.toBeInTheDocument();
  });

  test('moves a Trace atomically from Captured to Notarized on the same route', async () => {
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
    await expect.element(page.getByRole('button', { name: 'Notarize', exact: true })).toBeVisible();
    expect(packageReads).toBe(0);
    await page.getByRole('button', { name: 'Notarize', exact: true }).click();
    await expect.element(page.getByRole('button', { name: 'Export .llmtrace' })).toBeVisible();
    expect(window.location.hash).toBe(`#/traces/${captured.trace_id}`);
    expect(packageReads).toBeGreaterThan(0);
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
    await page.getByRole('button', { name: 'Notarized', exact: true }).click();
    await expect
      .element(page.getByRole('heading', { name: 'No traces have been notarized yet.' }))
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

  test('lists provider allowlist entries, readiness, and SDK base URLs', async () => {
    renderDashboard('/providers');
    await expect.element(page.getByRole('heading', { name: 'Providers' })).toBeVisible();
    await expect.element(page.getByText('Local admin').first()).toBeVisible();
    await expect.element(page.getByRole('heading', { name: 'OpenAI', exact: true })).toBeVisible();
    await expect
      .poll(() =>
        Array.from(document.querySelectorAll('.provider-route h2')).map((heading) =>
          heading.textContent?.trim(),
        ),
      )
      .toEqual(['OpenAI', 'OpenAI Codex', 'Anthropic', 'DeepSeek', 'OpenRouter']);
    await expect.element(page.getByText('api.openai.com', { exact: true }).first()).toBeVisible();
    await expect.element(page.getByText('http://127.0.0.1:8787/openai/v1')).toBeVisible();
    await expect.element(page.getByText('http://127.0.0.1:8787/codex')).toBeVisible();
    await expect.element(page.getByText('Ready', { exact: true }).first()).toBeVisible();
    await expect.element(page.getByText(/client still selects its provider model/)).toBeVisible();
    await expect
      .element(page.getByText('On — supported requests create Traces', { exact: true }).first())
      .toBeVisible();
    await expect
      .element(page.getByText('Use the OpenAI Responses client with this base URL.'))
      .toBeVisible();
    await expect
      .element(page.getByText('Use Codex CLI with its saved ChatGPT login and this base URL.'))
      .toBeVisible();
    await expect.element(page.getByText('Ollama', { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByPlaceholder('Provider host')).not.toBeInTheDocument();
  });

  test('copies provider setup without moving credentials or model selection into Notary', async () => {
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    renderDashboard('/providers');
    await page.getByRole('button', { name: 'Copy OpenAI base URL' }).click();
    expect(writeText).toHaveBeenCalledWith('http://127.0.0.1:8787/openai/v1');
    await expect
      .element(page.getByText(/key environment variable and model selection unchanged/).first())
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
      .toEqual([
        'General',
        'Account',
        'Notarization',
        'Security & storage',
        'Service',
        'Developer',
      ]);
    await expect.element(page.getByText('Proxy base URLs')).not.toBeInTheDocument();
  });

  test('changes capture behavior and persists an explicit theme', async () => {
    const api = createFixtureApi();
    renderDashboard('/settings', api);
    const toggle = page.getByRole('switch', { name: 'Capture requests' });
    await toggle.click();
    await expect.element(toggle).not.toBeChecked();
    await expect
      .element(page.getByText('Off — requests still pass through', { exact: false }))
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
        'Accepts new captures and notarizations',
        'Notarization-only',
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
    renderDashboard('/overview', api);
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
    renderDashboard('/providers', createFixtureApi(), true);
    await expect.element(page.getByRole('heading', { name: 'OpenAI', exact: true })).toBeVisible();
    await expect.element(page.getByRole('heading', { name: 'Providers' })).not.toBeInTheDocument();
    await expect
      .element(page.getByRole('navigation', { name: 'Admin dashboard' }))
      .not.toBeInTheDocument();
  });

  test('uses exactly five Settings groups in embedded desktop mode', async () => {
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
      .toEqual(['General', 'Account', 'Security', 'Updates', 'Advanced']);
    await expect.element(page.getByRole('switch', { name: 'Capture new requests' })).toBeChecked();
    await expect
      .element(page.getByRole('switch', { name: 'Open Notary at sign-in' }))
      .toBeChecked();
    await expect
      .element(page.getByText(/Closing the window leaves Notary available/))
      .toBeVisible();
    await expect
      .element(page.getByText('Menu-bar controller', { exact: true }))
      .not.toBeInTheDocument();
    await page.getByRole('switch', { name: 'Capture new requests' }).click();
    await expect
      .element(page.getByText('Off — requests pass through locally and create no Trace.'))
      .toBeVisible();
    await page.getByRole('switch', { name: 'Open Notary at sign-in' }).click();
    await page.getByRole('button', { name: 'Check now' }).click();
    await page.getByRole('button', { name: 'Restart to update' }).click();
    expect(actions).toEqual([
      { action: 'set_launch_at_login', enabled: false },
      { action: 'check_for_updates' },
      { action: 'restart_to_update' },
    ]);
  });

  test('shows embedded account, local-data, Notaries, update, and Advanced consequences', async () => {
    renderDashboard('/settings', createFixtureApi(), true, desktopSettings);
    await expect.element(page.getByText('Sample User', { exact: true })).toBeVisible();
    await expect.element(page.getByText(/does not upload or share local Traces/)).toBeVisible();
    await expect.element(page.getByText('Local data', { exact: true })).toBeVisible();
    await expect.element(page.getByRole('heading', { name: 'Alice' })).toBeVisible();
    await expect
      .element(page.getByText('Operated by Exalto', { exact: true }).first())
      .toBeVisible();
    await expect.element(page.getByText('Active verification key', { exact: true })).toBeVisible();
    await page.getByText('View details', { exact: true }).click();
    await expect.element(page.getByText('Verification key', { exact: true }).first()).toBeVisible();
    await expect.element(page.getByText('ai.exalto.notary', { exact: false })).toBeVisible();
    await expect.element(page.getByText('Service', { exact: true })).toBeVisible();
    await expect.element(page.getByText('Developer', { exact: true })).toBeVisible();
    await expect.element(page.getByText('Provider routes')).not.toBeInTheDocument();
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
      restart_block_reason: 'Finish the active notarization before restarting.',
    });
    await expect.element(page.getByRole('button', { name: 'Reconnect' })).toBeVisible();
    await expect
      .element(page.getByText('Finish the active notarization before restarting.'))
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
    await expect.element(page.getByText('Notarization completed').first()).toBeVisible();
    await expect.element(page.getByText('Notarization failed')).not.toBeInTheDocument();
  });

  test('opens Trace-linked activity and keeps safe technical details inspectable', async () => {
    renderDashboard('/activity');
    const failed = page.getByText('Notarization failed', { exact: true }).first();
    await expect.element(failed).toBeVisible();
    const failedRow = Array.from(document.querySelectorAll<HTMLElement>('.event-row')).find((row) =>
      row.textContent?.includes('Notarization failed'),
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
    await expect.element(divider).toHaveAttribute('aria-valuenow', '320');
    document.querySelector<HTMLElement>('[role="separator"]')?.focus();
    await userEvent.keyboard('{ArrowRight}');
    await expect.element(divider).toHaveAttribute('aria-valuenow', '336');
    expect(localStorage.getItem('notary-admin-dashboard-split-width')).toBe('336');
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

  test('keeps an expired share editable without presenting it as stopped', async () => {
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
