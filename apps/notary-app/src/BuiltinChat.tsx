import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Copy, Plus, Send, Settings, Square, ExternalLink } from 'lucide-react';
import { Symbol } from './Symbol';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  errorMessage,
  isTauri,
  setCaptureEnabled,
  startDaemon,
  type DesktopState,
} from './bridge';
import * as bridge from './builtinBridge';
import { AxisSelect } from '../../../runtime/apps/admin-dashboard/src/shared';
import './chat.css';
const names = {
  chatgpt: 'ChatGPT plan',
  openai: 'OpenAI API',
  anthropic: 'Anthropic API',
};

export function ProviderConnections({
  onChange,
  disabled = false,
}: {
  onChange?: (connections: bridge.Connection[]) => void;
  disabled?: boolean;
}) {
  const [connections, setConnections] = useState<bridge.Connection[]>([]);
  const [provider, setProvider] = useState<bridge.ConnectionId>('chatgpt');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [login, setLogin] = useState<bridge.DeviceLogin | null>(null);
  const alive = useRef(true);
  const loginRef = useRef<bridge.DeviceLogin | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  async function refresh() {
    const saved = await bridge.listConnections();
    let status = 'disconnected';
    try {
      status = await bridge.chatgptStatus();
    } catch (e) {
      if (alive.current) setError(errorMessage(e));
    }
    if (status === 'connected') saved.push({ id: 'chatgpt', status });
    if (alive.current) {
      setConnections(saved);
      onChangeRef.current?.(saved);
    }
    return status;
  }
  useEffect(() => {
    alive.current = true;
    void refresh().catch((e) => {
      if (alive.current) setError(errorMessage(e));
    });
    return () => {
      alive.current = false;
      if (loginRef.current)
        void bridge
          .cancelChatgptLogin(loginRef.current.login_id)
          .catch(() => undefined);
    };
  }, []);
  useEffect(() => {
    if (!login) return;
    let disposed = false;
    let checking = false;
    const timer = window.setInterval(() => {
      if (checking) return;
      checking = true;
      void refresh()
        .then((status) => {
          if (!disposed && status === 'connected') {
            loginRef.current = null;
            setLogin(null);
          }
        })
        .catch((e) => {
          if (!disposed) setError(errorMessage(e));
        })
        .finally(() => {
          checking = false;
        });
    }, 3000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [login]);
  async function action(work: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await work();
      if (alive.current) await refresh();
    } catch (e) {
      if (alive.current) setError(errorMessage(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const blocked = disabled || busy;
  return (
    <section className="provider-connections" aria-label="Built-in connections">
      <div className="chat-section-heading">
        <h2>Connections</h2>
        <span>Saved on this Mac</span>
      </div>
      <p className="panel-lead">
        These credentials are used only by the chat in Capture.
      </p>
      {connections.length === 0 ? (
        <p className="connection-empty">
          No connection is saved yet. Add one below to chat in Capture.
        </p>
      ) : (
        <ul className="connection-list">
          {connections.map((connection) => (
            <li key={connection.id}>
              <div>
                <strong>{names[connection.id]}</strong>
                <span
                  className={`connection-state is-${connection.status}`}
                  data-state={connection.status}
                >
                  {connection.status === 'saved'
                    ? 'Key saved · checked on first request'
                    : connection.status === 'connected'
                      ? 'Connected'
                      : connection.status === 'locked'
                        ? 'Unlock vault'
                        : 'Reconnect required'}
                </span>
              </div>
              <button
                className="mac-button is-small"
                disabled={blocked || !!login}
                onClick={() => {
                  if (connection.status === 'locked') {
                    void action(bridge.unlockConnections);
                  } else {
                    setProvider(connection.id);
                    setKey('');
                  }
                }}
              >
                {connection.status === 'locked' ? 'Unlock' : 'Reconnect'}
              </button>
              <button
                className="mac-button is-small"
                disabled={blocked || !!login}
                onClick={() =>
                  void action(() => bridge.removeConnection(connection.id))
                }
              >
                Remove {names[connection.id]}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="connection-form">
        <div className="connection-select">
          <span>Add or replace</span>
          <AxisSelect
            ariaLabel="Connection type"
            value={provider}
            disabled={blocked || !!login}
            clearable={false}
            placeholder="Choose a connection"
            data={Object.entries(names).map(([value, label]) => ({ value, label }))}
            onChange={(value) => {
              if (!value) return;
              setKey('');
              setProvider(value as bridge.ConnectionId);
            }}
          />
        </div>
        {provider === 'chatgpt' ? (
          <>
            <p>
              Link through Codex using your ChatGPT plan. Requires an installed
              Codex app or CLI and device-code login enabled for your account.
              Capture uses a separate session; your usual Codex sign-in stays
              unchanged.
            </p>
            {!login && (
              <button
                className="mac-button is-primary"
                disabled={blocked}
                onClick={() =>
                  void action(async () => {
                    const result = await bridge.startChatgptLogin();
                    if (!alive.current) {
                      await bridge.cancelChatgptLogin(result.login_id);
                      return;
                    }
                    loginRef.current = result;
                    setLogin(result);
                  })
                }
              >
                {busy ? 'Starting sign-in…' : 'Link ChatGPT plan'}
              </button>
            )}
            {login && (
              <div className="device-link" role="status">
                <p>Enter this code on the OpenAI verification page:</p>
                <code>{login.user_code}</code>
                <div className="device-link-actions">
                  <button
                    className="mac-button is-primary"
                    onClick={() =>
                      void bridge
                        .openVerification(login.verification_url)
                        .catch((e) => setError(errorMessage(e)))
                    }
                  >
                    Open OpenAI verification <ExternalLink size={12} />
                  </button>
                  <button
                    className="mac-button"
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        await bridge.cancelChatgptLogin(login.login_id);
                        loginRef.current = null;
                        setLogin(null);
                      })
                    }
                  >
                    Cancel sign-in
                  </button>
                </div>
                <p>
                  Waiting for approval… If the code expires, cancel and start
                  again.
                </p>
              </div>
            )}
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const supplied = key;
              setKey('');
              void action(() => bridge.saveConnection(provider, supplied));
            }}
          >
            <label>
              <span>API key</span>
              <input
                aria-label={`${names[provider]} key`}
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={key}
                disabled={blocked}
                onChange={(e) => setKey(e.target.value)}
              />
            </label>
            <p>
              {provider === 'anthropic'
                ? 'Claude subscriptions cannot be linked to this chat. Use an Anthropic API key; API usage is billed separately.'
                : 'Use an OpenAI API key for API billing. To use your subscription, choose ChatGPT plan.'}
            </p>
            <button
              className="mac-button is-primary"
              type="submit"
              disabled={blocked || !key.trim()}
            >
              {busy ? 'Saving…' : 'Save connection'}
            </button>
          </form>
        )}
      </div>
      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
      <p className="chat-fine-print">
        Removing a connection deletes its saved credential, not existing Traces, and does not
        revoke it at the provider. Private captures may retain encrypted credential bytes.
      </p>
    </section>
  );
}

type Exchange = {
  prompt: string;
  response: string;
  model: string;
  sentAt: number;
  result?: bridge.ChatResult;
};

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

function shortTraceId(id: string) {
  return id.length > 14 ? `${id.slice(0, 4)}…${id.slice(-6)}` : id;
}
export function BuiltinChat({
  state,
  refresh,
  onOpenTrace,
}: {
  state: DesktopState;
  refresh: () => Promise<void>;
  onOpenTrace: (id: string) => void;
}) {
  const [connections, setConnections] = useState<bridge.Connection[]>([]);
  const [selected, setSelected] = useState<bridge.ConnectionId>('chatgpt');
  const [model, setModel] = useState('');
  const [models, setModels] = useState<bridge.ChatModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState('');
  const [modelsRevision, setModelsRevision] = useState(0);
  const [prompt, setPrompt] = useState('');
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [showConnections, setShowConnections] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<string | null>(null);
  const alive = useRef(true);
  const bottom = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  // File > New Chat clears the conversation and focuses the composer.
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    void listen<string>('exalto:menu', (event) => {
      if (event.payload !== 'new-chat' || request.current) return;
      setExchanges([]);
      setPrompt('');
      setError('');
      setShowConnections(false);
      requestAnimationFrame(() => composer.current?.focus());
    }).then((stopListening) => {
      if (disposed) stopListening();
      else unlisten = stopListening;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (request.current)
        void bridge.cancelChat(request.current).catch(() => undefined);
    };
  }, []);
  useEffect(() => {
    if (exchanges.length > 0)
      bottom.current?.scrollIntoView({ block: 'nearest' });
  }, [exchanges]);
  const connection = connections.find((c) => c.id === selected);
  const connectionStatus = connection?.status;
  useEffect(() => {
    if (!connectionStatus || showConnections || exchanges.length > 0) return;
    if (connectionStatus === 'locked') {
      setModels([]);
      setModel('');
      setModelsLoading(false);
      setModelsError('Unlock the vault in Connections to load models.');
      return;
    }
    let disposed = false;
    setModelsLoading(true);
    setModelsError('');
    setModel('');
    setModels([]);
    void bridge.listModels(selected).then((items) => {
      if (disposed) return;
      setModels(items);
      setModel((items.find((item) => item.is_default) || items[0])?.id || '');
      if (!items.length) setModelsError('No chat models are available for this connection. Reconnect or try another connection.');
    }).catch((error) => {
      if (!disposed) setModelsError(errorMessage(error));
    }).finally(() => {
      if (!disposed) setModelsLoading(false);
    });
    return () => { disposed = true; };
  }, [selected, connectionStatus, showConnections, modelsRevision, exchanges.length > 0]);
  const unfinished = exchanges.some((e) => e.result?.status !== 'complete');
  async function send() {
    if (
      busy ||
      !connection ||
      !prompt.trim() ||
      !model.trim() ||
      unfinished
    )
      return;
    const id = crypto.randomUUID();
    request.current = id;
    const message = prompt.trim();
    setPrompt('');
    setBusy(true);
    setError('');
    const history: bridge.ChatMessage[] = exchanges.flatMap((e) => [
      { role: 'user' as const, content: e.prompt },
      { role: 'assistant' as const, content: e.response },
    ]);
    history.push({ role: 'user', content: message });
    setExchanges((all) => [...all, { prompt: message, response: '', model: model.trim(), sentAt: Date.now() }]);
    try {
      const result = await bridge.sendChat(
        id,
        selected,
        model.trim(),
        history,
        (text) => {
          if (alive.current && request.current === id)
            setExchanges((all) =>
              all.map((e, i) =>
                i === all.length - 1
                  ? { ...e, response: e.response + text }
                  : e,
              ),
            );
        },
      );
      if (alive.current)
        setExchanges((all) =>
          all.map((e, i) => (i === all.length - 1 ? { ...e, result } : e)),
        );
    } catch (e) {
      if (alive.current)
        setExchanges((all) =>
          all.map((item, i) =>
            i === all.length - 1
              ? { ...item, result: { status: errorMessage(e), traces: [] } }
              : item,
          ),
        );
    } finally {
      request.current = null;
      if (alive.current) {
        setBusy(false);
        await refresh();
      }
    }
  }
  return (
    <section className="builtin-chat">
      <header className="chat-bar" data-tauri-drag-region="deep">
        {connections.length > 0 ? (
          <>
            <div className="chat-field">
              <span>Use</span>
              <AxisSelect
                ariaLabel="Chat connection"
                value={selected}
                disabled={busy || exchanges.length > 0}
                clearable={false}
                placeholder="Choose a connection"
                data={connections.map((connection) => ({
                  value: connection.id,
                  label: names[connection.id],
                }))}
                onChange={(value) => {
                  if (!value) return;
                  setSelected(value as bridge.ConnectionId);
                  setModel('');
                }}
              />
            </div>
            <div className="chat-field is-model">
              <span>Model</span>
              <AxisSelect
                ariaLabel="Model"
                value={model || null}
                disabled={busy || exchanges.length > 0 || modelsLoading}
                clearable={false}
                placeholder={modelsLoading ? 'Loading models…' : 'No models available'}
                data={models.map((item) => ({
                  value: item.id,
                  label: `${item.name}${item.is_default ? ' (default)' : ''}`,
                }))}
                onChange={(value) => setModel(value ?? '')}
              />
            </div>
          </>
        ) : (
          <h1>Chat</h1>
        )}
        <span className="chat-bar-spacer" />
        <button
          className="mac-button is-small"
          disabled={busy}
          onClick={() => {
            setExchanges([]);
            setPrompt('');
            setError('');
          }}
        >
          <Symbol name="plus" fallback={Plus} size={12} weight="semibold" /> New chat
        </button>
      </header>
      {connections.length === 0 && (
        <div className="chat-connections-panel">
          <ProviderConnections
            disabled={busy}
            onChange={(items) => {
              setConnections(items);
              if (!items.some((c) => c.id === selected) && items[0]) {
                setSelected(items[0].id);
                setExchanges([]);
              }
            }}
          />
        </div>
      )}
      {connections.length > 0 && showConnections && (
        /* Connections as a sheet: hangs from the top of the pane, dismisses with Done, Escape, or a click outside. */
        <div className="chat-sheet-overlay" onClick={() => setShowConnections(false)}>
          <section
            className="chat-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="Connections"
            tabIndex={-1}
            ref={(node) => node?.focus()}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setShowConnections(false);
            }}
          >
            <div className="chat-sheet-body">
              <ProviderConnections
                disabled={busy}
                onChange={(items) => {
                  setConnections(items);
                  if (!items.some((c) => c.id === selected) && items[0]) {
                    setSelected(items[0].id);
                    setExchanges([]);
                  }
                }}
              />
            </div>
            <footer className="chat-sheet-footer">
              <button className="mac-button is-primary" type="button" onClick={() => setShowConnections(false)}>
                Done
              </button>
            </footer>
          </section>
        </div>
      )}
      {connections.length > 0 && (
        <>
          {modelsError && <div className="chat-error" role="alert">{modelsError} <button className="mac-button is-small" disabled={busy || modelsLoading} onClick={() => setModelsRevision((n) => n + 1)}>Retry models</button></div>}
          <div className="chat-messages" role="log" aria-label="Conversation">
            {exchanges.map((exchange, i) => {
              const streaming = busy && i === exchanges.length - 1 && !exchange.result;
              const failed = exchange.result && exchange.result.status !== 'complete';
              return (
                <article className="chat-exchange" key={i}>
                  <div className="chat-user">
                    <p className="selectable-text">{exchange.prompt}</p>
                  </div>
                  <div className={`chat-response${streaming ? ' is-streaming' : ''}`}>
                    <div className="chat-meta">
                      <span className="chat-meta-model">
                        {models.find((m) => m.id === exchange.model)?.name ?? exchange.model ?? names[selected]}
                      </span>
                      <time dateTime={new Date(exchange.sentAt).toISOString()}>
                        {timeFormat.format(exchange.sentAt)}
                      </time>
                      {exchange.response && !streaming && (
                        <button
                          type="button"
                          className="chat-copy"
                          aria-label="Copy response"
                          title="Copy response"
                          onClick={() => void navigator.clipboard.writeText(exchange.response)}
                        >
                          <Symbol name="doc.on.doc" fallback={Copy} size={12} />
                        </button>
                      )}
                    </div>
                    <p className="selectable-text">
                      {exchange.response ||
                        (streaming ? '' : failed ? '' : 'No response received.')}
                      {streaming && <span className="chat-cursor" aria-hidden="true" />}
                    </p>
                  </div>
                  {/* The ledger line: what this exchange became. */}
                  <div className={`chat-ledger${failed ? ' is-failed' : ''}`} aria-live="polite">
                    {streaming ? (
                      <>
                        <span className="chat-ledger-mark is-live" aria-hidden="true" />
                        <span>{exchange.response ? 'Responding' : 'Sending'}</span>
                      </>
                    ) : failed ? (
                      <>
                        <span className="chat-ledger-mark is-failed" aria-hidden="true" />
                        <span role="alert">{exchange.result?.status}</span>
                        {exchange.result?.traces.length === 0 && <span>Capture not confirmed</span>}
                      </>
                    ) : exchange.result ? (
                      exchange.result.traces.length === 0 ? (
                        <>
                          <span className="chat-ledger-mark" aria-hidden="true" />
                          <span>Capture not confirmed</span>
                        </>
                      ) : (
                        exchange.result.traces.map((trace) => (
                          <button
                            type="button"
                            className="chat-ledger-trace"
                            key={trace.id}
                            onClick={() => onOpenTrace(trace.id)}
                            title={trace.id}
                          >
                            <span
                              className={`chat-ledger-mark${trace.captured ? ' is-captured' : ''}`}
                              aria-hidden="true"
                            />
                            <span>{trace.captured ? 'Captured' : 'Capture unconfirmed'}</span>
                            <code>{shortTraceId(trace.id)}</code>
                            <span className="chat-ledger-open">
                              Open Trace <Symbol name="chevron.right" fallback={ChevronRight} size={10} weight="semibold" />
                            </span>
                          </button>
                        ))
                      )
                    ) : null}
                  </div>
                </article>
              );
            })}
            <div ref={bottom} />
          </div>
          <footer className="chat-composer">
            {!state.capture_enabled && (
              <div className="chat-capture-off">
                <p>
                  {state.running
                    ? 'Capture is off. Turn it on to record a Trace for each exchange.'
                    : 'The local capture service is off. Start it to record a Trace for each exchange.'}
                </p>
                <button
                  className="mac-button is-small"
                  disabled={busy}
                  onClick={() => {
                    setError('');
                    void startDaemon()
                      .then(() => setCaptureEnabled(true))
                      .then(refresh)
                      .catch((e) => setError(errorMessage(e)));
                  }}
                >
                  Turn on capture
                </button>
              </div>
            )}
            {error && (
              <p className="chat-error" role="alert">
                {error}
              </p>
            )}
            {unfinished && !busy && (
              <p className="chat-composer-note" role="status">
                Start a new chat to continue after an incomplete response.
              </p>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <button
                className="chat-connections-button"
                type="button"
                aria-label="Connections"
                title="Connections"
                aria-haspopup="dialog"
                disabled={busy}
                onClick={() => setShowConnections(true)}
              >
                <Symbol name="gearshape" fallback={Settings} size={15} />
              </button>
              <textarea
                ref={composer}
                aria-label="Message"
                placeholder={
                  model.trim()
                    ? `Message ${models.find((m) => m.id === model.trim())?.name ?? model.trim()}`
                    : 'Write a message…'
                }
                value={prompt}
                disabled={busy || (unfinished && exchanges.length > 0)}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void send();
                  }
                }}
                rows={1}
              />
              {busy ? (
                <button
                  className="mac-button"
                  type="button"
                  onClick={() => {
                    if (request.current)
                      void bridge
                        .cancelChat(request.current)
                        .catch((e) => setError(errorMessage(e)));
                  }}
                >
                  <Symbol name="stop.fill" fallback={Square} size={11} /> Stop
                </button>
              ) : (
                <button
                  className="mac-button is-primary"
                  type="submit"
                  disabled={
                    !connection ||
                    !state.capture_enabled ||
                    !state.running ||
                    !model.trim() ||
                    !prompt.trim() ||
                    unfinished
                  }
                >
                  <Symbol name="paperplane.fill" fallback={Send} size={12} /> Send
                </button>
              )}
            </form>
          </footer>
        </>
      )}
    </section>
  );
}
