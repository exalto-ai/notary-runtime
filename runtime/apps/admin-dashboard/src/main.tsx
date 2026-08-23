import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/instrument-sans';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-ext-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import '@fontsource/ibm-plex-mono/latin-ext-500.css';
import { createTheme, localStorageColorSchemeManager, MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import './shadcn.css';
import './styles.css';
import './axis.css';
import { localApi } from './api';
import { Dashboard } from './Dashboard';
import { createFixtureApi } from './fixtures';

const colorSchemeManager = localStorageColorSchemeManager({
  key: 'notary-admin-dashboard-color-scheme',
});
const theme = createTheme({
  fontFamily: 'Instrument Sans Variable, system-ui, sans-serif',
  fontFamilyMonospace: '"IBM Plex Mono", ui-monospace, monospace',
  headings: { fontFamily: 'Instrument Sans Variable, system-ui, sans-serif', fontWeight: '600' },
  primaryColor: 'axis',
  defaultRadius: 0,
  colors: {
    axis: [
      '#edf4ff',
      '#dceaff',
      '#b9d8ff',
      '#8db8ff',
      '#6fa7ff',
      '#4e8df2',
      '#3775df',
      '#285fd1',
      '#1c55cd',
      '#143d94',
    ],
    verify: [
      '#edf4ff',
      '#dceaff',
      '#b9d8ff',
      '#8db8ff',
      '#6fa7ff',
      '#4e8df2',
      '#3775df',
      '#285fd1',
      '#1c55cd',
      '#143d94',
    ],
  },
  components: {
    Button: { defaultProps: { radius: 0 } },
    Paper: { defaultProps: { radius: 0, shadow: undefined } },
    Modal: { defaultProps: { radius: 0, overlayProps: { blur: 0 } } },
    Drawer: { defaultProps: { radius: 0, overlayProps: { blur: 0 } } },
    Input: { defaultProps: { radius: 0 } },
    Badge: { defaultProps: { radius: 0 } },
  },
});

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 2_000, retry: 1, refetchOnWindowFocus: true } },
});
const params = new URLSearchParams(window.location.search);
const fixture = params.get('fixture') === 'docs';
const embedded = params.get('embedded') === 'desktop';
const requestedFixtureClock = Number(params.get('fixture_now'));
const fixtureClock =
  Number.isFinite(requestedFixtureClock) && requestedFixtureClock > 0
    ? requestedFixtureClock
    : Date.now();
if (!window.location.hash && params.get('view')) {
  const id = params.get('id');
  window.location.hash = `/${params.get('view')}${id ? `/${id}` : ''}`;
}

const applicationRoot = document.getElementById('local-root');
if (!applicationRoot) throw new Error('Admin dashboard root element is missing');

createRoot(applicationRoot).render(
  <StrictMode>
    <MantineProvider
      theme={theme}
      defaultColorScheme="auto"
      colorSchemeManager={colorSchemeManager}
    >
      <Notifications position="bottom-right" />
      <QueryClientProvider client={queryClient}>
        <Dashboard
          api={fixture ? createFixtureApi({ nowUnixMs: fixtureClock }) : localApi}
          fixture={fixture}
          embedded={embedded}
        />
      </QueryClientProvider>
    </MantineProvider>
  </StrictMode>,
);
