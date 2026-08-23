import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = resolve(appRoot, '../..');
const outputDir = resolve(runtimeRoot, 'docs/images/admin-dashboard');
const port = Number(process.env.NOTARY_DOCS_SCREENSHOT_PORT ?? 4175);
const origin = `http://127.0.0.1:${port}`;
const fixtureNow = Date.UTC(2026, 6, 28, 16, 42, 0);

mkdirSync(outputDir, { recursive: true });

const server = spawn(
  resolve(appRoot, 'node_modules/.bin/vite'),
  ['--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  { cwd: appRoot, stdio: ['ignore', 'pipe', 'inherit'] },
);

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Vite exited with status ${server.exitCode}`);
    try {
      const response = await fetch(`${origin}/local.html`);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for ${origin}`);
}

async function fixturePage(browser, { scheme, viewport, route }) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
  });
  await context.addInitScript((colorScheme) => {
    window.localStorage.setItem('notary-admin-dashboard-color-scheme', colorScheme);
  }, scheme);
  const page = await context.newPage();
  await page.emulateMedia({
    colorScheme: scheme === 'dark' ? 'dark' : 'light',
    reducedMotion: 'reduce',
  });
  await page.goto(`${origin}/local.html?fixture=docs&fixture_now=${fixtureNow}&${route}`, {
    waitUntil: 'networkidle',
  });
  await page.addStyleTag({
    content: `
    *, *::before, *::after { animation: none !important; caret-color: transparent !important; transition: none !important; }
    .mantine-Notifications-root { display: none !important; }
  `,
  });
  await page.evaluate(() => document.fonts.ready);
  return { context, page };
}

async function capture(browser, spec) {
  const { context, page } = await fixturePage(browser, spec);
  if (spec.prepare) await spec.prepare(page);
  await page.evaluate(
    () =>
      new Promise((resolveFrame) => {
        requestAnimationFrame(() => requestAnimationFrame(resolveFrame));
      }),
  );
  await page.screenshot({ path: resolve(outputDir, spec.file) });
  await context.close();
  process.stdout.write(`Captured docs/images/admin-dashboard/${spec.file}\n`);
}

try {
  await waitForServer();
  const browser = await chromium.launch({ headless: true });
  try {
    const desktop = { width: 1440, height: 1000 };
    await capture(browser, {
      file: 'overview-light.png',
      scheme: 'light',
      viewport: desktop,
      route: 'view=overview',
    });
    await capture(browser, {
      file: 'traces-dark.png',
      scheme: 'dark',
      viewport: desktop,
      route: 'view=traces&id=trc-20260728-safety-review',
    });
    await capture(browser, {
      file: 'trace-verification.png',
      scheme: 'dark',
      viewport: desktop,
      route: 'view=traces&id=trc-20260727-research-brief',
      prepare: async (page) => {
        await page.getByRole('button', { name: 'Verify locally' }).click();
        await page.getByRole('tab', { name: 'Verification' }).click();
        await page.getByRole('tab', { name: 'Verification', selected: true }).waitFor();
        await page.getByText('Verification passed').waitFor();
        await page.waitForFunction(() => {
          const button = [...document.querySelectorAll('button')].find((candidate) =>
            candidate.textContent?.includes('Verify locally'),
          );
          return (
            button &&
            !button.hasAttribute('disabled') &&
            !button.querySelector('.mantine-Loader-root')
          );
        });
        await page.mouse.move(0, 0);
        await page.evaluate(
          () => document.activeElement instanceof HTMLElement && document.activeElement.blur(),
        );
        await page.evaluate(
          () =>
            new Promise((resolveFrame) => {
              requestAnimationFrame(() => requestAnimationFrame(resolveFrame));
            }),
        );
      },
    });
    await capture(browser, {
      file: 'providers-light.png',
      scheme: 'light',
      viewport: desktop,
      route: 'view=providers',
    });
    await capture(browser, {
      file: 'settings-dark.png',
      scheme: 'dark',
      viewport: desktop,
      route: 'view=settings',
    });
    await capture(browser, {
      file: 'mobile-navigation.png',
      scheme: 'light',
      viewport: { width: 390, height: 844 },
      route: 'view=traces&id=trc-20260728-knowledge-eval',
      prepare: async (page) => {
        await page.getByRole('button', { name: 'Open navigation' }).click();
        await page.getByRole('navigation', { name: 'Admin dashboard' }).last().waitFor();
      },
    });
    await capture(browser, {
      file: 'mobile-trace-detail.png',
      scheme: 'light',
      viewport: { width: 390, height: 844 },
      route: 'view=traces&id=trc-20260728-knowledge-eval',
      prepare: async (page) => {
        await page.getByRole('button', { name: 'All traces' }).waitFor();
        await page.getByRole('heading', { name: 'gpt-5.2' }).waitFor();
      },
    });
  } finally {
    await browser.close();
  }
} finally {
  server.kill('SIGTERM');
}
