import {
  AppShell,
  Badge,
  Burger,
  Button,
  Drawer,
  NavLink,
  PasswordInput,
  Text,
  TextInput,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  ChevronRight,
  FileCheck2,
  Gauge,
  Settings,
  ShieldCheck,
  Unplug,
} from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import type { LocalApi, LocalApiError, Status } from './api';
import { ErrorState, LoadingState } from './shared';
import { ActivityView } from './views/ActivityView';
import { OverviewView } from './views/OverviewView';
import { ProvidersView } from './views/ProvidersView';
import type { DesktopSettingsAction, DesktopSettingsState } from './views/SettingsView';
import {
  EmbeddedSettingsView,
  StandaloneSettingsView,
  useDesktopSettingsBridge,
} from './views/SettingsView';
import { TracesView } from './views/TracesView';

export type { DesktopSettingsAction, DesktopSettingsState } from './views/SettingsView';

import {
  type DashboardRoute,
  type DashboardView,
  dashboardRouteFromHash,
  dashboardRouteHash,
} from './routes';

const logoUrl = new URL('./assets/notary-mark.svg', import.meta.url).href;

type Route = DashboardRoute;
const navigation: Array<{ view: DashboardView; label: string; icon: typeof Gauge }> = [
  { view: 'overview', label: 'Overview', icon: Gauge },
  { view: 'traces', label: 'Traces', icon: FileCheck2 },
  { view: 'activity', label: 'Activity', icon: Activity },
  { view: 'providers', label: 'Providers', icon: Unplug },
  { view: 'settings', label: 'Settings', icon: Settings },
];

function goTo(route: Route) {
  window.location.hash = dashboardRouteHash(route);
}

function useRoute() {
  const [route, setRoute] = useState<Route>(() => dashboardRouteFromHash(window.location.hash));
  useEffect(() => {
    const change = () => setRoute(dashboardRouteFromHash(window.location.hash));
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  return route;
}

function AuthGate({ api, onAuthenticated }: { api: LocalApi; onAuthenticated: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const mutation = useMutation({
    mutationFn: () => api.session(username, password),
    onSuccess: () => {
      setUsername('');
      setPassword('');
      onAuthenticated();
    },
    onError: () =>
      notifications.show({
        color: 'red',
        title: 'Authentication failed',
        message: 'Check the username and password configured under admin.auth.',
      }),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (username && password) mutation.mutate();
  };
  return (
    <main className="auth-shell">
      <section className="auth-document">
        <Brand />
        <Text className="eyebrow">Notary administration</Text>
        <Title order={1}>Sign in</Title>
        <Text className="auth-copy">
          This service requires the credentials configured under admin.auth.
        </Text>
        <form onSubmit={submit}>
          <TextInput
            label="Username"
            value={username}
            onChange={(event) => setUsername(event.currentTarget.value)}
            autoComplete="username"
            autoFocus
          />
          <PasswordInput
            label="Password"
            value={password}
            onChange={(event) => setPassword(event.currentTarget.value)}
            autoComplete="current-password"
          />
          <Button
            type="submit"
            loading={mutation.isPending}
            disabled={!username || !password}
            rightSection={<ChevronRight size={15} />}
          >
            Open dashboard
          </Button>
        </form>
        <div className="trust-note">
          <ShieldCheck aria-hidden="true" />
          <div>
            <b>Authenticated administration</b>
            <span>
              Use the credentials configured for this service. Access may be loopback or an
              explicitly configured cluster ingress.
            </span>
          </div>
        </div>
      </section>
    </main>
  );
}

function Brand() {
  return (
    <div className="local-brand">
      <span className="local-mark" aria-hidden="true">
        <img src={logoUrl} alt="" width={30} height={30} />
      </span>
      <span>Notary</span>
    </div>
  );
}

function Sidebar({
  route,
  status,
  onNavigate,
}: {
  route: Route;
  status: Status;
  onNavigate: (route: Route) => void;
}) {
  const count = (view: DashboardView) => (view === 'traces' ? status.counts.captured : undefined);
  return (
    <div className="sidebar-inner">
      <div className="sidebar-primary">
        <nav aria-label="Admin dashboard">
          {navigation.map(({ view, label, icon: Icon }) => (
            <NavLink
              key={view}
              component="button"
              type="button"
              aria-label={label}
              active={route.view === view}
              label={label}
              leftSection={<Icon size={17} strokeWidth={1.7} />}
              rightSection={count(view) ? <Badge size="xs">{count(view)}</Badge> : null}
              onClick={() => onNavigate({ view })}
            />
          ))}
        </nav>
      </div>
    </div>
  );
}

function TopNav({
  route,
  status,
  onNavigate,
  opened,
  onOpenNavigation,
  fixture,
}: {
  route: Route;
  status: Status;
  onNavigate: (route: Route) => void;
  opened: boolean;
  onOpenNavigation: () => void;
  fixture: boolean;
}) {
  const count = (view: DashboardView) => (view === 'traces' ? status.counts.captured : undefined);
  return (
    <header className="local-topbar">
      <Brand />
      <nav aria-label="Admin dashboard">
        {navigation.map(({ view, label, icon: Icon }) => (
          <UnstyledButton
            key={view}
            className={route.view === view ? 'is-active' : ''}
            onClick={() => onNavigate({ view })}
          >
            <Icon size={15} aria-hidden="true" />
            <span>{label}</span>
            {count(view) ? <b>{count(view)}</b> : null}
          </UnstyledButton>
        ))}
      </nav>
      <div className="local-topbar-status">
        <span className="admin-context-label">
          {status.runtime_profile === 'cluster' ? 'Cluster admin' : 'Local admin'}
        </span>
        {fixture && (
          <span className="sample-data-label" title="This preview uses synthetic sample data">
            Sample data
          </span>
        )}
        <Burger opened={opened} onClick={onOpenNavigation} size="sm" aria-label="Open navigation" />
      </div>
    </header>
  );
}

export function Dashboard({
  api,
  fixture = false,
  embedded = false,
  desktopSettings,
  onDesktopSettingsAction,
}: {
  api: LocalApi;
  fixture?: boolean;
  embedded?: boolean;
  desktopSettings?: DesktopSettingsState | null;
  onDesktopSettingsAction?: (action: DesktopSettingsAction) => void;
}) {
  const route = useRoute();
  const queryClient = useQueryClient();
  const [navOpened, { open: openNav, close: closeNav }] = useDisclosure(false);
  const desktopBridge = useDesktopSettingsBridge(
    embedded,
    desktopSettings,
    onDesktopSettingsAction,
  );
  const statusQuery = useQuery({
    queryKey: ['status'],
    queryFn: api.status,
    retry: false,
    refetchInterval: 10_000,
  });
  const navigate = (next: Route) => {
    closeNav();
    goTo(next);
  };

  if (statusQuery.isLoading) return <LoadingState label="Connecting to the local service" />;
  if (statusQuery.error && (statusQuery.error as LocalApiError).status === 401) {
    return (
      <AuthGate
        api={api}
        onAuthenticated={() => queryClient.invalidateQueries({ queryKey: ['status'] })}
      />
    );
  }
  if (statusQuery.error) return <ErrorState onRetry={() => statusQuery.refetch()} />;
  if (!statusQuery.data) return <ErrorState onRetry={() => statusQuery.refetch()} />;
  const status = statusQuery.data;
  if (embedded) {
    return (
      <main className="dashboard-shell dashboard-shell--embedded dashboard-main">
        <View
          route={route}
          status={status}
          api={api}
          navigate={navigate}
          fixture={fixture}
          embedded
          desktopBridge={desktopBridge}
        />
      </main>
    );
  }
  return (
    <AppShell header={{ height: 50 }} padding={0} className="dashboard-shell">
      <AppShell.Header className="dashboard-header">
        <TopNav
          route={route}
          status={status}
          onNavigate={navigate}
          opened={navOpened}
          onOpenNavigation={openNav}
          fixture={fixture}
        />
      </AppShell.Header>
      <Drawer
        opened={navOpened}
        onClose={closeNav}
        title="Navigation"
        size="min(88vw, 340px)"
        classNames={{ body: 'mobile-nav-body' }}
      >
        <Sidebar route={route} status={status} onNavigate={navigate} />
      </Drawer>
      <AppShell.Main className="dashboard-main">
        <View
          route={route}
          status={status}
          api={api}
          navigate={navigate}
          fixture={fixture}
          embedded={false}
          desktopBridge={desktopBridge}
        />
      </AppShell.Main>
    </AppShell>
  );
}

function View({
  route,
  status,
  api,
  navigate,
  embedded,
  desktopBridge,
}: {
  route: Route;
  status: Status;
  api: LocalApi;
  navigate: (route: Route) => void;
  fixture: boolean;
  embedded: boolean;
  desktopBridge: {
    state: DesktopSettingsState | null;
    send: (action: DesktopSettingsAction) => void;
  };
}) {
  switch (route.view) {
    case 'traces':
      return (
        <TracesView
          api={api}
          selectedId={route.id}
          initialFilters={route.filters}
          navigate={navigate}
        />
      );
    case 'activity':
      return <ActivityView api={api} initialTraceId={route.filters?.traceId} navigate={navigate} />;
    case 'providers':
      return <ProvidersView api={api} status={status} embedded={embedded} />;
    case 'settings':
      return embedded ? (
        <EmbeddedSettingsView
          status={status}
          api={api}
          desktopSettings={desktopBridge.state}
          onDesktopAction={desktopBridge.send}
        />
      ) : (
        <StandaloneSettingsView status={status} api={api} />
      );
    default:
      return <OverviewView api={api} status={status} navigate={navigate} />;
  }
}
