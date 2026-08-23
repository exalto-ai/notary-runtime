import { Button, Center, Loader, Stack, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { Archive, RefreshCw, Unplug } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { LocalApiError } from './api';

export function requiredValue<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`${label} is required`);
  return value;
}

export type AxisSelectOption = string | { value: string; label: ReactNode };

export function AxisSelect({
  value,
  onChange,
  data,
  placeholder,
  ariaLabel,
  label,
  clearable = true,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  data: AxisSelectOption[];
  placeholder: string;
  ariaLabel?: string;
  label?: string;
  clearable?: boolean;
}) {
  const allValue = '__axis_all__';
  const options = data.map((option) =>
    typeof option === 'string' ? { value: option, label: option } : option,
  );
  return (
    <div className="axis-select-field">
      {label && <span className="axis-select-label">{label}</span>}
      <Select
        value={value ?? (clearable ? allValue : undefined)}
        onValueChange={(next) => onChange(next === allValue ? null : next)}
      >
        <SelectTrigger className="axis-select-trigger" aria-label={ariaLabel ?? label}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent className="axis-select-content" position="popper" align="start">
          {clearable && <SelectItem value={allValue}>{placeholder}</SelectItem>}
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function formatDate(value?: number | null) {
  if (!value) return 'Not yet';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

export function formatBytes(value?: number | null) {
  if (value === undefined || value === null) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

export function stateTone(state: string) {
  if (['succeeded', 'verified', 'ready', 'success', 'admitted'].includes(state)) return 'ready';
  if (['failed', 'interrupted', 'error', 'unavailable', 'rejected', 'expired'].includes(state))
    return 'danger';
  if (['running', 'capturing', 'queued', 'uploading', 'verifying'].includes(state)) return 'active';
  return 'muted';
}

export function StatusLabel({ state }: { state: string }) {
  return (
    <span className={`status-label status-label--${stateTone(state)}`}>
      <span aria-hidden="true" />
      {state.replaceAll('_', ' ')}
    </span>
  );
}

export function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export function EmptyState({
  icon: Icon = Archive,
  title,
  copy,
}: {
  icon?: typeof Archive;
  title: string;
  copy: string;
}) {
  return (
    <Center className="empty-state">
      <Stack align="center" gap="sm">
        <Icon aria-hidden="true" />
        <Title order={3}>{title}</Title>
        <Text>{copy}</Text>
      </Stack>
    </Center>
  );
}

export function ErrorState({
  title = 'The local service is unavailable',
  onRetry,
}: {
  title?: string;
  onRetry?: () => void;
}) {
  return (
    <Center className="error-state">
      <Stack align="center" gap="md">
        <Unplug aria-hidden="true" />
        <Title order={2}>{title}</Title>
        <Text>Check that the foreground service is running on this loopback address.</Text>
        {onRetry && (
          <Button variant="outline" leftSection={<RefreshCw size={15} />} onClick={onRetry}>
            Try again
          </Button>
        )}
      </Stack>
    </Center>
  );
}

export function QueryError({ error, title }: { error: unknown; title?: string }) {
  const unauthorized = error instanceof LocalApiError && error.status === 401;
  return <ErrorState title={unauthorized ? 'The dashboard session expired' : title} />;
}

export function mutationError(title: string, error: unknown) {
  const code = error instanceof LocalApiError ? error.code : 'request_failed';
  notifications.show({
    color: 'red',
    title,
    message: `The service returned ${code}. Review Activity for safe details.`,
  });
}

export function timeRangeStart(range: string | null) {
  if (!range) return undefined;
  const milliseconds =
    range === 'hour'
      ? 60 * 60 * 1000
      : range === 'day'
        ? 24 * 60 * 60 * 1000
        : 7 * 24 * 60 * 60 * 1000;
  return Date.now() - milliseconds;
}

export function LoadingState({ label = 'Loading local evidence' }: { label?: string }) {
  return (
    <Center className="loading-state">
      <Stack align="center" gap="sm">
        <Loader size="sm" />
        <Text>{label}</Text>
      </Stack>
    </Center>
  );
}
