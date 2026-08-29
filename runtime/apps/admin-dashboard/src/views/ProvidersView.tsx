import { ActionIcon, Button, Group, Paper, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { Copy, ShieldCheck, Unplug } from 'lucide-react';
import type { LocalApi, Status } from '../api';
import { ProviderIdentity } from '../ProviderIdentity';
import { EmptyState, Fact, LoadingState, QueryError, StatusLabel } from '../shared';

type ProviderRoute = Awaited<ReturnType<LocalApi['providers']>>['providers'][number];

const codexConfig = (baseUrl: string) => `model_provider = "capture-chatgpt"

[model_providers.capture-chatgpt]
name = "Exalto Capture, ChatGPT plan"
base_url = "${baseUrl}"
requires_openai_auth = true
wire_api = "responses"
supports_websockets = false`;

const claudeCommand = (baseUrl: string) => `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN \\
  ANTHROPIC_BASE_URL=${baseUrl} \\
  claude`;

const apiKeyEnvironment: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

function setupNote(providerId: string) {
  if (providerId === 'openai') return 'Use this URL with OpenAI Responses or Chat Completions.';
  if (providerId === 'anthropic') {
    return 'Use this URL with the Anthropic Messages SDK when authenticating with an API key.';
  }
  if (providerId === 'openrouter') {
    return 'Keep the OpenRouter model namespace in the originating client.';
  }
  return 'Use this URL with the provider’s OpenAI-compatible client.';
}

function BaseUrl({
  route,
  label,
  onCopy,
}: {
  route: ProviderRoute;
  label: string;
  onCopy: (label: string, value: string) => void;
}) {
  return (
    <div className="api-link">
      <code>{route.proxy_base_url}</code>
      <ActionIcon
        variant="subtle"
        onClick={() => onCopy(label, route.proxy_base_url)}
        aria-label={`Copy ${label} base URL`}
      >
        <Copy size={15} />
      </ActionIcon>
    </div>
  );
}

function ClientSetupCard({
  client,
  route,
  onCopyBaseUrl,
  onCopySetup,
}: {
  client: 'codex' | 'claude';
  route: ProviderRoute;
  onCopyBaseUrl: (label: string, value: string) => void;
  onCopySetup: (label: string, value: string) => void;
}) {
  const codex = client === 'codex';
  const name = codex ? 'Codex CLI' : 'Claude Code';
  const setup = codex ? codexConfig(route.proxy_base_url) : claudeCommand(route.proxy_base_url);
  return (
    <Paper className="settings-panel provider-route">
      <Group justify="space-between" align="flex-start">
        <div>
          <Text className="eyebrow">
            {codex ? 'Saved ChatGPT sign-in' : 'Saved claude.ai sign-in'}
          </Text>
          <Title order={2}>{name}</Title>
        </div>
        <StatusLabel state={route.ready ? 'ready' : 'unavailable'} />
      </Group>
      <Text>
        {codex
          ? 'Use the ChatGPT login already managed by Codex CLI. Keep your current model setting.'
          : 'Use the claude.ai login already managed by Claude Code. Keep your current model setting.'}
      </Text>
      <dl className="receipt-list">
        <Fact
          label="Check sign-in"
          value={<code>{codex ? 'codex login status' : 'claude auth status'}</code>}
        />
        <Fact
          label={codex ? 'Config key' : 'Environment variable'}
          value={<code>{codex ? 'model_provider' : 'ANTHROPIC_BASE_URL'}</code>}
        />
        <Fact label="Local route" value={<code>{route.route_prefix}</code>} />
      </dl>
      <BaseUrl route={route} label={codex ? route.name : name} onCopy={onCopyBaseUrl} />
      <Text className="safe-note">
        <ShieldCheck size={15} />
        {codex
          ? ' Codex CLI keeps the saved ChatGPT login and sends it with requests. No API key is needed for this route.'
          : ' Claude Code keeps the saved claude.ai login and sends it with requests. No API key is needed for this route.'}
      </Text>
      <details className="notary-details">
        <summary>Setup {name}</summary>
        <Text>
          {codex
            ? 'Add this named provider to ~/.codex/config.toml. Do not add env_key, then run Codex normally.'
            : 'Run Claude Code with its API-key overrides removed so it uses the saved claude.ai login.'}
        </Text>
        <pre className="json-view">{setup}</pre>
        <Button
          variant="outline"
          leftSection={<Copy size={14} />}
          onClick={() => onCopySetup(codex ? 'Codex CLI config' : 'Claude Code command', setup)}
        >
          {codex ? 'Copy config' : 'Copy command'}
        </Button>
        {!codex && (
          <Text className="provider-setup-note">
            If Claude Code is signed out, unset ANTHROPIC_BASE_URL and sign in directly first. The
            native Claude desktop app cannot use this loopback route.
          </Text>
        )}
      </details>
    </Paper>
  );
}

function ApiRouteCard({
  route,
  status,
  onCopyBaseUrl,
}: {
  route: ProviderRoute;
  status: Status;
  onCopyBaseUrl: (label: string, value: string) => void;
}) {
  const supportsOnboardingTest = ['openai', 'anthropic', 'openrouter'].includes(route.id);
  return (
    <Paper className="settings-panel provider-route">
      <Group justify="space-between" align="flex-start">
        <div>
          <ProviderIdentity provider={route.id} detail={route.host} />
          <Title order={2}>{route.name}</Title>
        </div>
        <StatusLabel state={route.ready ? 'ready' : 'unavailable'} />
      </Group>
      <BaseUrl route={route} label={route.name} onCopy={onCopyBaseUrl} />
      <Text className="safe-note">
        <ShieldCheck size={15} /> Keep <code>{apiKeyEnvironment[route.id] ?? 'API_KEY'}</code> in
        the originating client. Exalto Capture does not store or substitute it.
        {supportsOnboardingTest
          ? ' Its optional onboarding test can hold a pasted key in memory for one setup session, but never saves it.'
          : ''}{' '}
        Model selection stays in the client.
      </Text>
      <Text className="provider-setup-note">{setupNote(route.id)}</Text>
      <details className="notary-details">
        <summary>{route.name} route details</summary>
        <dl className="receipt-list">
          <Fact label="Client API" value={route.client_api} />
          <Fact label="Allowed host" value={route.host} />
          <Fact label="Route" value={route.route_prefix} />
          <Fact label="Readiness" value={route.ready ? 'Ready' : 'Unavailable'} />
          <Fact
            label="Capture"
            value={
              status.capture_enabled
                ? 'On, supported requests create traces'
                : 'Off, requests pass through locally and create no trace'
            }
          />
        </dl>
      </details>
    </Paper>
  );
}

export function ProvidersView({
  api,
  status,
  embedded,
}: {
  api: LocalApi;
  status: Status;
  embedded: boolean;
}) {
  const providers = useQuery({ queryKey: ['providers'], queryFn: api.providers, retry: false });
  const isCluster = status.runtime_profile === 'cluster';
  const copyBaseUrl = async (label: string, baseUrl: string) => {
    await navigator.clipboard.writeText(baseUrl);
    notifications.show({
      title: `${label} base URL copied`,
      message:
        'Model selection and the API key stay in the tool. Exalto Capture does not store a second provider credential.',
    });
  };
  const copySetup = async (label: string, value: string) => {
    await navigator.clipboard.writeText(value);
    notifications.show({
      title: `${label} copied`,
      message: 'Review the destination before saving or running it.',
    });
  };
  const routes = providers.data?.providers ?? [];
  const codexRoute = routes.find((route) => route.id === 'openai_codex');
  const claudeRoute = routes.find((route) => route.id === 'anthropic');
  const apiRoutes = routes.filter((route) => route.id !== 'openai_codex');
  return (
    <div className="view-page providers-page">
      {!embedded && (
        <header className="view-heading">
          <div>
            <Text className="eyebrow">{isCluster ? 'Cluster admin' : 'Local admin'}</Text>
            <Title order={1}>AI connections</Title>
          </div>
          <Text>
            Connect the tool you already use by changing only its local endpoint. Model selection
            and saved product logins stay there. API keys also remain client-owned; setup can hold
            one temporarily only for its optional onboarding test.
          </Text>
        </header>
      )}
      {providers.isLoading ? (
        <LoadingState label="Loading AI connections" />
      ) : providers.error ? (
        <QueryError error={providers.error} title="AI connections are unavailable" />
      ) : !routes.length ? (
        <EmptyState
          icon={Unplug}
          title="No AI routes"
          copy="This service has no configured AI connection routes."
        />
      ) : (
        <>
          <section className="settings-group" aria-labelledby="ai-tools-title">
            <Text className="eyebrow">Recommended</Text>
            <Title order={2} id="ai-tools-title" className="settings-group-title">
              Connect your AI tool
            </Title>
            <Text className="provider-boundary-note">
              Codex CLI and Claude Code keep their own saved product sign-ins. This setup changes
              only their loopback endpoint and does not move those logins into Exalto Capture.
            </Text>
            <div className="provider-route-list provider-client-list">
              {codexRoute && (
                <ClientSetupCard
                  client="codex"
                  route={codexRoute}
                  onCopyBaseUrl={copyBaseUrl}
                  onCopySetup={copySetup}
                />
              )}
              {claudeRoute && (
                <ClientSetupCard
                  client="claude"
                  route={claudeRoute}
                  onCopyBaseUrl={copyBaseUrl}
                  onCopySetup={copySetup}
                />
              )}
            </div>
          </section>
          <section className="settings-group" aria-labelledby="api-routes-title">
            <Text className="eyebrow">API and SDK clients</Text>
            <Title order={2} id="api-routes-title" className="settings-group-title">
              Use a provider base URL
            </Title>
            <Text className="provider-boundary-note">
              Choose a provider route only when configuring an API or SDK client. Replace its base
              URL, then keep its API key and model configuration in that client. The optional Exalto
              Capture onboarding test can hold a pasted key only in memory for the current setup
              session; it does not save the key or create a second credential path.
            </Text>
            <div className="provider-route-list provider-api-list">
              {apiRoutes.map((route) => (
                <ApiRouteCard
                  key={route.id}
                  route={route}
                  status={status}
                  onCopyBaseUrl={copyBaseUrl}
                />
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
