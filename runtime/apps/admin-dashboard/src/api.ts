import type { components, paths } from './generated/api.generated';

export type Status = components['schemas']['StatusResponse'];
export type CaptureSetting = components['schemas']['CaptureSettingResponse'];
export type Notaries = components['schemas']['NotariesResponse'];
export type Notary = components['schemas']['Notary'];
export type Providers = components['schemas']['ProvidersResponse'];
export type TraceSummary = components['schemas']['TraceSummary'];
export type TraceDetail = components['schemas']['TraceDetail'];
export type Operation = components['schemas']['TechnicalOperation'];
export type OperationSummary = Operation;
export type Event = components['schemas']['ActivityItem'];
export type TraceContent = components['schemas']['TraceContent'];
export type Verification = components['schemas']['VerificationResult'];
export type AccountConnection = components['schemas']['AccountConnectionResponse'];
export type AccountConnectionStarted = components['schemas']['AccountConnectionStartedResponse'];
export type Share = components['schemas']['TraceShare'];
export type ShareVisibility = components['schemas']['ShareVisibility'];
export type ShareSettings =
  paths['/v1/traces/{trace_id}/share']['put']['requestBody']['content']['application/json'];
type TraceList = paths['/v1/traces']['get']['responses'][200]['content']['application/json'];
type TraceFilters = NonNullable<paths['/v1/traces']['get']['parameters']['query']>;
type NotarizationResult =
  paths['/v1/traces/{trace_id}/notarizations']['post']['responses'][202]['content']['application/json'];
type EventList = paths['/v1/activity']['get']['responses'][200]['content']['application/json'];
type ActivityFilters = NonNullable<paths['/v1/activity']['get']['parameters']['query']>;
export class LocalApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  basicAuth?: { username: string; password: string };
};

function basicAuthorization(username: string, password: string) {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return `Basic ${btoa(binary)}`;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    headers: {
      'x-notary-request': 'dashboard',
      ...(options.basicAuth
        ? {
            authorization: basicAuthorization(
              options.basicAuth.username,
              options.basicAuth.password,
            ),
          }
        : {}),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    throw new LocalApiError(
      response.status,
      payload?.error?.code ?? 'request_failed',
      payload?.error?.message ?? 'The local service could not complete the request.',
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

async function requestBlob(path: string): Promise<Blob> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'x-notary-request': 'dashboard' },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    throw new LocalApiError(
      response.status,
      payload?.error?.code ?? 'request_failed',
      payload?.error?.message ?? 'The local service could not complete the request.',
    );
  }
  return response.blob();
}

function queryString(values: Record<string, string | number | boolean | undefined>) {
  const query = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== '') query.set(key, String(value));
  });
  const encoded = query.toString();
  return encoded ? `?${encoded}` : '';
}

export const localApi = {
  session: (username: string, password: string) =>
    request<void>('/v1/session', {
      method: 'POST',
      basicAuth: { username, password },
    }),
  endSession: () => request<void>('/v1/session', { method: 'DELETE' }),
  status: () => request<Status>('/v1/status'),
  captureSetting: () => request<CaptureSetting>('/v1/settings/capture'),
  updateCaptureSetting: (enabled: boolean) =>
    request<CaptureSetting>('/v1/settings/capture', {
      method: 'PUT',
      body: { enabled },
    }),
  notaries: () => request<Notaries>('/v1/notaries'),
  providers: () => request<Providers>('/v1/providers'),
  traces: (filters: TraceFilters = {}) => request<TraceList>(`/v1/traces${queryString(filters)}`),
  trace: (traceId: string) => request<TraceDetail>(`/v1/traces/${encodeURIComponent(traceId)}`),
  startNotarization: (traceId: string) =>
    request<NotarizationResult>(`/v1/traces/${encodeURIComponent(traceId)}/notarizations`, {
      method: 'POST',
    }),
  events: (filters: ActivityFilters = {}) =>
    request<EventList>(`/v1/activity${queryString(filters)}`),
  traceContent: (traceId: string) =>
    request<TraceContent>(`/v1/traces/${encodeURIComponent(traceId)}/content`),
  downloadPackage: (traceId: string) =>
    requestBlob(`/v1/traces/${encodeURIComponent(traceId)}/package.llmtrace`),
  verify: (traceId: string) =>
    request<Verification>(`/v1/traces/${encodeURIComponent(traceId)}/verify`, {
      method: 'POST',
    }),
  account: () => request<AccountConnection>('/v1/account'),
  startAccountConnection: () =>
    request<AccountConnectionStarted>('/v1/account', {
      method: 'POST',
      body: {},
    }),
  pollAccountConnection: (requestId: string) =>
    request<AccountConnection>(`/v1/account/${encodeURIComponent(requestId)}`),
  disconnectAccount: () => request<void>('/v1/account', { method: 'DELETE' }),
  share: (traceId: string, settings: ShareSettings) =>
    request<Share>(`/v1/traces/${encodeURIComponent(traceId)}/share`, {
      method: 'PUT',
      body: settings,
    }),
  shareStatus: (traceId: string) =>
    request<Share>(`/v1/traces/${encodeURIComponent(traceId)}/share`),
  stopSharing: (traceId: string) =>
    request<Share>(`/v1/traces/${encodeURIComponent(traceId)}/share`, { method: 'DELETE' }),
};

export type LocalApi = typeof localApi;
