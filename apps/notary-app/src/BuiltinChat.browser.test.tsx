import { cleanup, render } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { BuiltinChat, ProviderConnections } from './BuiltinChat';
import * as bridge from './builtinBridge';
import { getDesktopState } from './bridge';
import { exaltoTheme } from '../../../runtime/apps/admin-dashboard/src/theme';
import './styles.css';
vi.mock('./builtinBridge', () => ({
  listConnections: vi.fn(),
  listModels: vi.fn(),
  unlockConnections: vi.fn(),
  chatgptStatus: vi.fn(),
  saveConnection: vi.fn(),
  removeConnection: vi.fn(),
  startChatgptLogin: vi.fn(),
  cancelChatgptLogin: vi.fn(),
  openVerification: vi.fn(),
  cancelChat: vi.fn(),
  sendChat: vi.fn(),
}));
beforeEach(() => {
  window.history.replaceState({}, '', '/?screen=capture-on');
  vi.mocked(bridge.listConnections).mockResolvedValue([
    { id: 'openai', status: 'saved' },
  ]);
  vi.mocked(bridge.chatgptStatus).mockResolvedValue('disconnected');
  vi.mocked(bridge.listModels).mockResolvedValue([{ id: 'offline-test-model', name: 'Test model', is_default: true }]);
  for (const fn of [
    bridge.saveConnection,
    bridge.removeConnection,
    bridge.cancelChatgptLogin,
    bridge.openVerification,
    bridge.cancelChat,
  ])
    vi.mocked(fn).mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});

function renderWithTheme(view: ReactNode) {
  return render(<MantineProvider theme={exaltoTheme}>{view}</MantineProvider>);
}

async function chat() {
  const open = vi.fn();
  renderWithTheme(
    <BuiltinChat
      state={await getDesktopState()}
      refresh={async () => undefined}
      onOpenTrace={open}
    />,
  );
  await expect
    .element(page.getByRole('combobox', { name: 'Chat connection' }))
    .toHaveValue('OpenAI API');
  await expect.element(page.getByRole('combobox', { name: 'Model' })).toHaveValue('Test model (default)');
  return open;
}

test('uses the shared Mantine selects in the chat toolbar', async () => {
  await chat();
  expect(document.querySelectorAll('.chat-bar select')).toHaveLength(0);
  expect(document.querySelectorAll('.chat-bar .axis-select-trigger')).toHaveLength(2);
});

test('saves a key through native storage and clears the field without browser persistence', async () => {
  renderWithTheme(<ProviderConnections />);
  await page.getByRole('combobox', { name: 'Connection type' }).click();
  await page.getByRole('option', { name: 'OpenAI API' }).click();
  await userEvent.fill(
    page.getByLabelText('OpenAI API key'),
    'sk-explicit-user-secret',
  );
  await userEvent.click(page.getByRole('button', { name: 'Save connection' }));
  expect(bridge.saveConnection).toHaveBeenCalledWith(
    'openai',
    'sk-explicit-user-secret',
  );
  await expect.element(page.getByLabelText('OpenAI API key')).toHaveValue('');
  expect(document.body.textContent).not.toContain('sk-explicit-user-secret');
  expect(JSON.stringify(localStorage)).not.toContain('sk-explicit-user-secret');
  expect(JSON.stringify(sessionStorage)).not.toContain(
    'sk-explicit-user-secret',
  );
  await userEvent.click(
    page.getByRole('button', { name: 'Remove OpenAI API' }),
  );
  expect(bridge.removeConnection).toHaveBeenCalledWith('openai');
});

test('does not pretend to save a key when the vault is locked', async () => {
  vi.mocked(bridge.saveConnection).mockRejectedValue(
    new Error('Unlock the vault before managing connections.'),
  );
  renderWithTheme(<ProviderConnections />);
  await page.getByRole('combobox', { name: 'Connection type' }).click();
  await page.getByRole('option', { name: 'Anthropic API' }).click();
  await userEvent.fill(
    page.getByLabelText('Anthropic API key'),
    'sk-offline-secret',
  );
  await userEvent.click(page.getByRole('button', { name: 'Save connection' }));
  await expect
    .element(page.getByRole('alert'))
    .toHaveTextContent('Unlock the vault');
  await expect
    .element(page.getByLabelText('Anthropic API key'))
    .toHaveValue('');
});

test('links with a device code and cancels pending authorization when the panel closes', async () => {
  vi.mocked(bridge.startChatgptLogin).mockResolvedValue({
    login_id: 'test-login',
    user_code: 'ABCD-EFGH',
    verification_url: 'https://auth.openai.com/codex/device',
  });
  const view = renderWithTheme(<ProviderConnections />);
  await userEvent.click(
    page.getByRole('button', { name: 'Link ChatGPT plan' }),
  );
  await expect.element(page.getByText('ABCD-EFGH')).toBeVisible();
  expect(bridge.openVerification).not.toHaveBeenCalled();
  await userEvent.click(
    page.getByRole('button', { name: /Open OpenAI verification/ }),
  );
  expect(bridge.openVerification).toHaveBeenCalledWith(
    'https://auth.openai.com/codex/device',
  );
  view.unmount();
  expect(bridge.cancelChatgptLogin).toHaveBeenCalledWith('test-login');
});

test('streams multi-turn messages and opens the exact Trace', async () => {
  vi.mocked(bridge.sendChat).mockImplementation(
    async (_id, _connection, _model, _messages, onDelta) => {
      onDelta('First ');
      onDelta('response');
      return {
        status: 'complete',
        traces: [{ id: 'trc-exact-response', captured: true }],
      };
    },
  );
  const open = await chat();
  await userEvent.fill(page.getByLabelText('Message'), 'First question');
  await userEvent.click(
    page.getByRole('button', { name: 'Send', exact: true }),
  );
  await expect
    .element(page.getByText('First response', { exact: true }))
    .toBeVisible();
  await userEvent.click(
    page.getByRole('button', { name: /^Captured .*Open Trace$/ }),
  );
  expect(open).toHaveBeenCalledWith('trc-exact-response');
  await userEvent.fill(page.getByLabelText('Message'), 'Follow-up question');
  await userEvent.click(
    page.getByRole('button', { name: 'Send', exact: true }),
  );
  await expect.poll(() => vi.mocked(bridge.sendChat).mock.calls.length).toBe(2);
  expect(vi.mocked(bridge.sendChat).mock.calls[1][3]).toEqual([
    { role: 'user', content: 'First question' },
    { role: 'assistant', content: 'First response' },
    { role: 'user', content: 'Follow-up question' },
  ]);
});

test('keeps an unconfirmed capture distinct from a completed response', async () => {
  vi.mocked(bridge.sendChat).mockResolvedValue({
    status: 'complete',
    traces: [{ id: 'trc-pending', captured: false }],
  });
  await chat();
  await userEvent.fill(page.getByLabelText('Message'), 'Test');
  await userEvent.click(
    page.getByRole('button', { name: 'Send', exact: true }),
  );
  await expect
    .element(
      page.getByRole('button', { name: /^Capture unconfirmed .*Open Trace$/ }),
    )
    .toBeVisible();
  await expect
    .element(page.getByRole('button', { name: /^Captured .*Open Trace$/ }))
    .not.toBeInTheDocument();
});

test('shows expired credentials without claiming capture and allows a fresh conversation', async () => {
  vi.mocked(bridge.sendChat).mockResolvedValue({
    status: 'Reconnect this provider: its credential was rejected.',
    traces: [],
  });
  await chat();
  await userEvent.fill(page.getByLabelText('Message'), 'Test');
  await userEvent.click(
    page.getByRole('button', { name: 'Send', exact: true }),
  );
  await expect
    .element(page.getByRole('alert'))
    .toHaveTextContent('Reconnect this provider');
  await expect.element(page.getByText('Capture not confirmed')).toBeVisible();
  await expect.element(page.getByLabelText('Message')).toBeDisabled();
  await userEvent.click(page.getByRole('button', { name: 'New chat' }));
  await expect.element(page.getByLabelText('Message')).toBeEnabled();
});

test('marks an expired connection with the reconnect warning dot', async () => {
  vi.mocked(bridge.listConnections).mockResolvedValue([{ id: 'openai', status: 'reconnect' }]);
  renderWithTheme(<ProviderConnections />);
  const state = page.getByText('Reconnect required');
  await expect.element(state).toHaveClass('connection-state', 'is-reconnect');
  const dot = getComputedStyle(state.element(), '::before');
  expect(dot.backgroundColor).toBe(dot.borderTopColor);
  expect(dot.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
});

test('stops the exact active request and retains its partial response', async () => {
  let complete: ((result: bridge.ChatResult) => void) | undefined;
  vi.mocked(bridge.sendChat).mockImplementation(
    (_id, _connection, _model, _messages, delta) => {
      delta('Partial response');
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
  );
  await chat();
  await userEvent.fill(page.getByLabelText('Message'), 'Test');
  await userEvent.click(
    page.getByRole('button', { name: 'Send', exact: true }),
  );
  await expect.element(page.getByText('Partial response')).toBeVisible();
  await userEvent.click(
    page.getByRole('button', { name: 'Stop', exact: true }),
  );
  expect(bridge.cancelChat).toHaveBeenCalledWith(
    vi.mocked(bridge.sendChat).mock.calls[0][0],
  );
  complete?.({
    status: 'Response stopped. Any partial Trace remains local.',
    traces: [],
  });
  await expect
    .element(page.getByRole('alert'))
    .toHaveTextContent('Response stopped');
  await expect.element(page.getByText('Partial response')).toBeVisible();
});


test('loads connection models and selects the catalog default automatically', async () => {
  vi.mocked(bridge.listModels).mockResolvedValue([
    { id: 'first-model', name: 'First model', is_default: false },
    { id: 'preferred-model', name: 'Preferred model', is_default: true },
  ]);
  renderWithTheme(<BuiltinChat state={await getDesktopState()} refresh={async () => undefined} onOpenTrace={() => undefined} />);
  await expect.element(page.getByRole('combobox', { name: 'Model' })).toHaveValue('Preferred model (default)');
  expect(bridge.listModels).toHaveBeenCalledWith('openai');
  await page.getByRole('combobox', { name: 'Model' }).click();
  await page.getByRole('option', { name: 'First model' }).click();
  await expect.element(page.getByRole('combobox', { name: 'Model' })).toHaveValue('First model');
});

test('model discovery failure can be retried without inventing an available model', async () => {
  vi.mocked(bridge.listModels).mockRejectedValueOnce(new Error('Model service unavailable.'));
  renderWithTheme(<BuiltinChat state={await getDesktopState()} refresh={async () => undefined} onOpenTrace={() => undefined} />);
  await expect.element(page.getByRole('alert')).toHaveTextContent('Model service unavailable.');
  await expect.element(page.getByRole('combobox', { name: 'Model' })).toHaveValue('');
  await expect.element(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await userEvent.click(page.getByRole('button', { name: 'Retry models' }));
  await expect.element(page.getByRole('combobox', { name: 'Model' })).toHaveValue('Test model (default)');
});


test('locked connections do not load credentials in the background and unlock is explicit', async () => {
  vi.mocked(bridge.listConnections).mockResolvedValue([{ id: 'openai', status: 'locked' }]);
  vi.mocked(bridge.unlockConnections).mockResolvedValue(undefined);
  renderWithTheme(<BuiltinChat state={await getDesktopState()} refresh={async () => undefined} onOpenTrace={() => undefined} />);
  await expect.element(page.getByRole('alert')).toHaveTextContent('Unlock the vault in Connections');
  expect(bridge.listModels).not.toHaveBeenCalled();
  expect(bridge.unlockConnections).not.toHaveBeenCalled();
  await userEvent.click(page.getByRole('button', { name: 'Connections', exact: true }));
  await userEvent.click(page.getByRole('button', { name: 'Unlock', exact: true }));
  expect(bridge.unlockConnections).toHaveBeenCalledTimes(1);
});
