import { Button, Switch } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type DesktopState, errorMessage, localApi } from './bridge';
import type { View } from './product';

/**
 * The main screen's header: Traces, with the auto-seal and capture switches
 * beside it. Capture is only possible once the sealing service's trusted
 * transport is reachable, so the header also says when it is not.
 */
export function TracesHeader({
  state,
  busy,
  notice,
  onStartCapture,
  onStopCapture,
  onRetryConnections,
  onNavigate,
}: {
  state: DesktopState;
  busy: string | null;
  notice: string | null;
  onStartCapture: () => void;
  onStopCapture: () => void;
  onRetryConnections: () => void;
  onNavigate: (view: View) => void;
}) {
  const recording = state.running && state.capture_enabled;
  const queryClient = useQueryClient();
  const autoSeal = useQuery({
    queryKey: ['auto-seal'],
    queryFn: localApi.autoSealSetting,
    enabled: state.running,
  });
  const setAutoSeal = useMutation({
    mutationFn: localApi.updateAutoSealSetting,
    onSuccess: (setting) => queryClient.setQueryData(['auto-seal'], setting),
    onError: (error) =>
      notifications.show({ color: 'red', title: 'Auto-seal', message: errorMessage(error) }),
  });
  const autoSealing = autoSeal.data?.enabled === true;
  const sealingServiceName = state.sealing_service?.name ?? 'Exalto Seal';
  const sealingPhase = state.sealing_service_readiness.phase;
  const sealingReady = sealingPhase === 'ready';
  const captureCanStart = sealingReady || (!state.running && sealingPhase === 'off');
  const sealingStarting = sealingPhase === 'starting';
  const sealingNeedsAttention =
    sealingPhase === 'unreachable' || sealingPhase === 'trust_unavailable';
  const status =
    busy === 'capture-start'
      ? 'Starting capture…'
      : recording
        ? autoSealing
          ? 'Capturing. New traces are sealed as they arrive.'
          : 'Capturing. Make a request in a connected AI client.'
        : sealingStarting
          ? `Checking the connection to ${sealingServiceName}. Capture is available when it succeeds.`
          : 'Capture is off. Requests sent while it is off can’t be sealed later.';
  const message = notice ?? (state.running ? state.message : null);

  return (
    <header className="native-page-header traces-header" data-tauri-drag-region="deep">
      <div>
        <h1 data-tauri-drag-region>Traces</h1>
        <p className={recording ? 'is-recording' : undefined}>{status}</p>
      </div>
      <div className="traces-header-switches">
        <Switch
          className="capture-switch"
          label="Auto-seal"
          labelPosition="left"
          size="md"
          checked={autoSealing}
          disabled={!autoSeal.isSuccess || setAutoSeal.isPending}
          title="Seal each new trace as it is captured. Each seal uses your monthly sealing allowance."
          onChange={(event) => setAutoSeal.mutate(event.currentTarget.checked)}
        />
        <Switch
          className="capture-switch"
          label="Capture"
          labelPosition="left"
          size="md"
          checked={recording}
          disabled={busy !== null || (!recording && !captureCanStart)}
          title={
            recording || captureCanStart
              ? undefined
              : `Capture needs a reachable connection to ${sealingServiceName}.`
          }
          onChange={(event) => (event.currentTarget.checked ? onStartCapture() : onStopCapture())}
        />
      </div>
      {sealingNeedsAttention && (
        <div className="traces-header-alert" role="status">
          <div>
            <strong>
              {sealingPhase === 'unreachable'
                ? `${sealingServiceName} can’t be reached`
                : 'Sealing trust needs attention'}
            </strong>
            <span>
              {state.sealing_service_readiness.message ??
                (sealingPhase === 'unreachable'
                  ? 'The trusted endpoint did not complete its transport handshake.'
                  : 'The configured trust source did not resolve a trusted sealing endpoint.')}
            </span>
          </div>
          <Button size="xs" variant="outline" onClick={onRetryConnections}>
            Try again
          </Button>
          <Button size="xs" variant="subtle" onClick={() => onNavigate('settings')}>
            Sealing settings
          </Button>
        </div>
      )}
      {message && (
        <p className="traces-header-notice" role="status">
          {message}
        </p>
      )}
    </header>
  );
}
