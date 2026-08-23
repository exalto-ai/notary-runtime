import { ActionIcon, Group, Paper, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { Copy, ShieldCheck, Unplug } from 'lucide-react';
import type { LocalApi, Status } from '../api';
import { ProviderIdentity } from '../ProviderIdentity';
import { EmptyState, Fact, LoadingState, QueryError, StatusLabel } from '../shared';

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
  const copyBaseUrl = async (providerName: string, baseUrl: string) => {
    await navigator.clipboard.writeText(baseUrl);
    notifications.show({
      title: `${providerName} base URL copied`,
      message: 'Keep the provider credential in your SDK and replace only its base URL.',
    });
  };
  const setupNote = (providerId: string) => {
    if (providerId === 'openai') return 'Use the OpenAI Responses client with this base URL.';
    if (providerId === 'openai_codex') {
      return 'Use Codex CLI with its saved ChatGPT login and this base URL.';
    }
    if (providerId === 'anthropic') return 'Use the Anthropic Messages client with this base URL.';
    if (providerId === 'openrouter') {
      return 'Keep the OpenRouter model namespace in the external client.';
    }
    return 'Use the provider’s OpenAI-compatible client with this base URL.';
  };
  return (
    <div className="view-page providers-page">
      {!embedded && (
        <header className="view-heading">
          <div>
            <Text className="eyebrow">{isCluster ? 'Cluster admin' : 'Local admin'}</Text>
            <Title order={1}>Providers</Title>
          </div>
          <Text>
            Route supported SDK traffic through Notary. Credentials stay in the client and are never
            sent to the remote notary. The client still selects its provider model.
          </Text>
        </header>
      )}
      {embedded && (
        <Text className="provider-boundary-note">
          Credentials and model selection remain in the originating client.
        </Text>
      )}
      {providers.isLoading ? (
        <LoadingState label="Loading providers" />
      ) : providers.error ? (
        <QueryError error={providers.error} title="Providers are unavailable" />
      ) : !providers.data?.providers.length ? (
        <EmptyState
          icon={Unplug}
          title="No provider routes"
          copy="This service has no configured provider allowlist entries."
        />
      ) : (
        <section className="provider-route-list" aria-label="Provider routes">
          {providers.data.providers.map((provider) => (
            <Paper className="settings-panel provider-route" key={provider.id}>
              <Group justify="space-between" align="flex-start">
                <div>
                  <ProviderIdentity provider={provider.id} detail={provider.host} />
                  <Title order={2}>{provider.name}</Title>
                </div>
                <StatusLabel state={provider.ready ? 'ready' : 'unavailable'} />
              </Group>
              <dl className="receipt-list">
                <Fact label="Client API" value={provider.client_api} />
                <Fact label="Allowed host" value={provider.host} />
                <Fact label="Route" value={provider.route_prefix} />
                <Fact label="Readiness" value={provider.ready ? 'Ready' : 'Unavailable'} />
                <Fact
                  label="Capture"
                  value={
                    status.capture_enabled
                      ? 'On — supported requests create Traces'
                      : 'Off — requests pass through locally and create no Trace'
                  }
                />
              </dl>
              <div className="api-link">
                <code>{provider.proxy_base_url}</code>
                <ActionIcon
                  variant="subtle"
                  onClick={() => copyBaseUrl(provider.name, provider.proxy_base_url)}
                  aria-label={`Copy ${provider.name} base URL`}
                >
                  <Copy size={15} />
                </ActionIcon>
              </div>
              <Text className="safe-note">
                <ShieldCheck size={15} /> Configure this as the SDK base URL. Keep the original API
                key environment variable and model selection unchanged.
              </Text>
              <Text className="provider-setup-note">{setupNote(provider.id)}</Text>
            </Paper>
          ))}
        </section>
      )}
    </div>
  );
}
