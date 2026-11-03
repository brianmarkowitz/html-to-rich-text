// Verify that saving the tool uses no network and never includes a later draft.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { expectedPolicy } from '../tools/update-csp.mjs';
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
const work = mkdtempSync(join(tmpdir(), 'story-tool-http-'));
let browser;
try {
  browser = await playwright.chromium.launch();
  const context = await browser.newContext({ acceptDownloads: true });
  const origin = `http://127.0.0.1:${server.address().port}`;
  // Local and offline copies must never contact the site-visits counter or anything else.
  const external = [];
  context.on('request', (r) => { if (/^https?:/.test(r.url()) && !r.url().startsWith(origin + '/')) external.push(r.url()); });
  const page = await context.newPage();
  await page.goto(origin + '/');
  const draft = 'SYNTHETIC_PRIVATE_DRAFT_SENTINEL_82164';
  await page.locator('#source').fill(`<center><b>${draft}</b></center>\n\nA second paragraph.`);
  await page.locator('#preview strong').waitFor();
  // A filename in a prior download status must not leak into the saved tool.
  const storyPending = page.waitForEvent('download', { timeout: 10000 });
  await page.locator('#moreSave > summary').click();
  await page.locator('#txtBtn').click();
  await storyPending;
  assert.equal(await page.locator('#moreSave').evaluate(e => e.open), true, 'saving a file must leave other save choices reachable');
  assert.ok((await page.locator('#status').textContent()).includes('synthetic-private-draft'));
  const requestsBefore = requests.length;
  const pending = page.waitForEvent('download', { timeout: 10000 });
  await page.locator('#saveTool').click();
  const download = await pending;
  assert.equal(download.suggestedFilename(), 'text-unwrapped.html');
  const saved = join(work, 'renamed-tool.html');
  await download.saveAs(saved);
  const downloaded = readFileSync(saved, 'utf8');
  assert.ok(!downloaded.includes(draft), 'draft must not be embedded in the tool');
  assert.ok(!downloaded.includes('synthetic-private-draft'), 'draft filename must not be embedded');
  assert.equal(requests.length, requestsBefore, 'tool download must need no network request');
  assert.ok(requests.every(r => r.method === 'GET' && r.url === '/'), 'only initial static page request');
  assert.equal(downloaded.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/)[1], expectedPolicy(downloaded));
  await context.setOffline(true);
  const offline = await context.newPage();
  await offline.goto(pathToFileURL(saved).href);
  assert.equal(await offline.locator('#source').inputValue(), '');
  assert.equal(await offline.locator('#preview').textContent(), '');
  assert.equal(await offline.locator('#status').textContent(), '');
  assert.equal(await offline.locator('#htmlMode').inputValue(), 'auto');
  assert.equal(await offline.locator('#adjust').evaluate(e => e.open), false);
  assert.equal(await offline.locator('#moreSave').evaluate(e => e.open), false);
  await offline.locator('#source').fill('Fresh <b>offline</b> text.\n\nNext paragraph.');
  await offline.locator('#preview strong').waitFor();
  assert.equal(await offline.locator('#preview p').count(), 2);
  assert.equal(await offline.locator('#preview strong').textContent(), 'offline');
  // Saving the renamed tool again remains blank and independent of its draft.
  const againPending = offline.waitForEvent('download', { timeout: 10000 });
  await offline.locator('#moreSave > summary').click();
  await offline.locator('#saveTool').click();
  const again = await againPending;
  assert.ok(!readFileSync(await again.path(), 'utf8').includes('Fresh <b>offline</b> text.'));
  assert.equal(await offline.locator('#visits').isVisible(), false, 'no counter in local copies');
  assert.deepEqual(external, [], 'no external requests from local or offline pages');
  console.log('Hosted/offline tool download passed: blank copy, valid CSP, no draft or filename, no network; renamed offline copy converts and saves again.');
  await context.close();
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
  rmSync(work, { recursive: true, force: true });
}
