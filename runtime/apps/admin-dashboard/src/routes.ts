export const dashboardViews = ['overview', 'traces', 'activity', 'providers', 'settings'] as const;

export type DashboardView = (typeof dashboardViews)[number];

export type TraceRouteFilter = {
  state?: 'captured' | 'notarized';
  status?: 'notarizing' | 'needs_attention';
};

export type ActivityRouteFilter = { traceId?: string };

export type DashboardRoute = {
  view: DashboardView;
  id?: string;
  filters?: TraceRouteFilter & ActivityRouteFilter;
};

export function dashboardRouteFromHash(hash: string): DashboardRoute {
  const [path, query = ''] = hash.replace(/^#\/?/, '').split('?');
  const [candidate = 'overview', id] = path.split('/');
  const view = dashboardViews.find((value) => value === candidate);
  if (!view) return { view: 'overview' };
  if (id) return { view, id };

  const params = new URLSearchParams(query);
  if (view === 'activity') {
    const traceId = params.get('trace_id')?.trim();
    return traceId ? { view, filters: { traceId } } : { view };
  }
  if (view !== 'traces') return { view };
  const state = params.get('state');
  const status = params.get('status');
  const filters: TraceRouteFilter = {};
  if (state === 'captured' || state === 'notarized') filters.state = state;
  if (status === 'notarizing' || status === 'needs_attention') filters.status = status;
  return Object.keys(filters).length ? { view, filters } : { view };
}

export function dashboardRouteHash(route: DashboardRoute) {
  const path = `/${route.view}${route.id ? `/${route.id}` : ''}`;
  if (route.id || !route.filters) return path;
  const query = new URLSearchParams();
  if (route.view === 'traces') {
    if (route.filters.state) query.set('state', route.filters.state);
    if (route.filters.status) query.set('status', route.filters.status);
  }
  if (route.view === 'activity' && route.filters.traceId) {
    query.set('trace_id', route.filters.traceId);
  }
  const serialized = query.toString();
  return serialized ? `${path}?${serialized}` : path;
}
