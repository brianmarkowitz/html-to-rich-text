// Test the hosted offline-tool link separately from file:// conversion tests.
// Only synthetic text is used; the HTTP server exists only for this test.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'playwright')); }
const html = readFileSync(new URL('../docs/index.html', import.meta.url));
const requests = [];
const server = createServer((req, res) => {
  requests.push({ method: req.method, url: req.url });
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await playwright.chromium.launch();
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(origin + '/');
  const draft = 'SYNTHETIC_PRIVATE_DRAFT_SENTINEL_82164';
  await page.locator('#source').fill(draft);
  assert.equal(await page.locator('#saveTool').getAttribute('href'), 'index.html');
  const pending = page.waitForEvent('download', { timeout: 10000 });
  await page.locator('#saveTool').click();
  const download = await pending;
  assert.equal(download.suggestedFilename(), 'story-to-rich-text.html');
  const downloaded = readFileSync(await download.path());
  assert.deepEqual(downloaded, html, 'offline download must be the unchanged blank tool');
  assert.ok(!downloaded.includes(Buffer.from(draft)), 'draft must not be embedded in the tool');
  assert.ok(requests.some(r => r.url === '/index.html'), 'download must request the static HTML file');
  assert.ok(requests.every(r => r.method === 'GET' && !r.url.includes(draft) && !r.url.includes('?')), 'only static GET requests, no draft upload');
  console.log('HTTP download passed: original blank tool, no draft in file or requests.');
  await context.close();
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
