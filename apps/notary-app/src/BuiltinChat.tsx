import { useEffect, useRef, useState } from 'react';
import { Plus, Send, Square, ExternalLink } from 'lucide-react';
import {
  errorMessage,
  setCaptureEnabled,
  startDaemon,
  type DesktopState,
} from './bridge';
import * as bridge from './builtinBridge';
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
        These credentials are used only by the chat in Capture. External Codex
        and Claude sessions keep their own sign-in.
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
        <label className="connection-select">
          <span>Add or replace</span>
          <select
            aria-label="Connection type"
            value={provider}
            disabled={blocked || !!login}
            onChange={(e) => {
              setKey('');
              setProvider(e.target.value as bridge.ConnectionId);
            }}
          >
            {Object.entries(names).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
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
        API keys are encrypted in your local vault. Codex manages its linked
        login in a separate local session. Removing a connection deletes its saved credential,
        not existing Traces, and does not revoke it at the provider. Private
        captures may retain encrypted credential bytes.
      </p>
    </section>
  );
}

type Exchange = {
  prompt: string;
  response: string;
  result?: bridge.ChatResult;
};
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
  const [consent, setConsent] = useState(false);
  const request = useRef<string | null>(null);
  const alive = useRef(true);
  const bottom = useRef<HTMLDivElement>(null);
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
      !consent ||
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
    setExchanges((all) => [...all, { prompt: message, response: '' }]);
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
      <header className="chat-bar">
        {connections.length > 0 && !showConnections ? (
          <>
            <label className="chat-field">
              <span>Use</span>
              <select
                aria-label="Chat connection"
                value={selected}
                disabled={busy || exchanges.length > 0}
                onChange={(e) => {
                  setSelected(e.target.value as bridge.ConnectionId);
                  setModel('');
                }}
              >
                {connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {names[c.id]}
                  </option>
                ))}
              </select>
            </label>
            <label className="chat-field is-model">
              <span>Model</span>
              <select
                aria-label="Model"
                value={model}
                disabled={busy || exchanges.length > 0 || modelsLoading}
                onChange={(e) => setModel(e.target.value)}
              >
                {!model && <option value="">{modelsLoading ? 'Loading models…' : 'No models available'}</option>}
                {models.map((item) => <option key={item.id} value={item.id}>{item.name}{item.is_default ? ' (default)' : ''}</option>)}
              </select>
            </label>
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
          <Plus size={13} /> New chat
        </button>
        <button
          className="mac-button is-small"
          aria-expanded={showConnections}
          disabled={busy}
          onClick={() => setShowConnections(!showConnections)}
        >
          {showConnections ? 'Done' : 'Connections'}
        </button>
      </header>
      <div
        className="chat-connections-panel"
        hidden={!showConnections && connections.length > 0}
      >
        <ProviderConnections
          key={String(showConnections)}
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
      {connections.length > 0 && !showConnections && (
        <>
          {modelsError && <div className="chat-error" role="alert">{modelsError} <button className="mac-button is-small" disabled={busy || modelsLoading} onClick={() => setModelsRevision((n) => n + 1)}>Retry models</button></div>}
          <div className="chat-messages" role="log" aria-label="Conversation">
            {exchanges.length === 0 && (
              <div className="chat-empty">
                <h2>Start a chat</h2>
                <p>
                  Each exchange is captured as its own private Trace in your
                  vault. The chat text stays in memory until you close this
                  window.
                </p>
              </div>
            )}
            {exchanges.map((exchange, i) => (
              <article className="chat-exchange" key={i}>
                <div className="chat-user">
                  <strong>You</strong>
                  <p className="selectable-text">{exchange.prompt}</p>
                </div>
                <div className="chat-response">
                  <strong>{names[selected]}</strong>
                  <p className="selectable-text">
                    {exchange.response ||
                      (busy && i === exchanges.length - 1
                        ? 'Waiting for response…'
                        : 'No response received.')}
                  </p>
                </div>
                {exchange.result && (
                  <div className="chat-receipt">
                    {exchange.result.status !== 'complete' && (
                      <p role="alert">{exchange.result.status}</p>
                    )}
                    {exchange.result.traces.length === 0 && (
                      <span>Capture not confirmed</span>
                    )}
                    {exchange.result.traces.map((trace) => (
                      <button
                        className="mac-button is-small"
                        key={trace.id}
                        onClick={() => onOpenTrace(trace.id)}
                      >
                        {trace.captured
                          ? 'Captured · Open Trace'
                          : 'Capture unconfirmed · Inspect Trace'}
                      </button>
                    ))}
                  </div>
                )}
              </article>
            ))}
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
            {!consent && (
              <label className="chat-consent">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                <span>
                  I understand sending uses my provider’s API balance or ChatGPT
                  plan allowance and saves a private encrypted Trace. It does
                  not seal or share it.
                </span>
              </label>
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
              <textarea
                aria-label="Message"
                placeholder="Write a message…"
                value={prompt}
                disabled={busy || (unfinished && exchanges.length > 0)}
                onChange={(e) => setPrompt(e.target.value)}
                rows={2}
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
                  <Square size={13} /> Stop
                </button>
              ) : (
                <button
                  className="mac-button is-primary"
                  type="submit"
                  disabled={
                    !connection ||
                    !consent ||
                    !state.capture_enabled ||
                    !state.running ||
                    !model.trim() ||
                    !prompt.trim() ||
                    unfinished
                  }
                >
                  <Send size={13} /> Send
                </button>
              )}
            </form>
          </footer>
        </>
      )}
    </section>
  );
}
