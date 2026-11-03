// Browser test suite for docs/index.html. Uses an already-installed Playwright
// (local or global) with Chromium; nothing is downloaded. All input is synthetic.
// Usage: node tests/run-tests.mjs
import { createRequire } from 'node:module';
import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { expectedPolicy } from '../tools/update-csp.mjs';

const require = createRequire(import.meta.url);
function loadPlaywright() {
  try { return require('playwright'); } catch {}
  const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
  return require(join(root, 'playwright'));
}
const { chromium } = loadPlaywright();

const appFile = fileURLToPath(new URL('../docs/index.html', import.meta.url));
const appUrl = pathToFileURL(appFile).href;
const appSource = readFileSync(appFile, 'utf8');
const work = mkdtempSync(join(tmpdir(), 'story-rt-tests-'));

const results = [];
async function test(name, fn) {
  try { await fn(); results.push([true, name]); console.log(`  ok    ${name}`); }
  catch (e) { results.push([false, name]); console.log(`  FAIL  ${name}\n        ${String(e && e.stack || e).split('\n').slice(0, 6).join('\n        ')}`); }
}

// Records any attempt to use the network or persistent storage from page code.
const INSTRUMENT = `(() => {
  const calls = [];
  Object.defineProperty(window, '__calls', { value: calls });
  const wrap = (obj, key, label) => {
    if (!obj || !(key in obj)) return;
    const orig = obj[key];
    try { obj[key] = function () { calls.push(label); return orig.apply(this, arguments); }; } catch (e) {}
  };
  wrap(window, 'fetch', 'fetch');
  wrap(XMLHttpRequest.prototype, 'open', 'xhr');
  wrap(Navigator.prototype, 'sendBeacon', 'beacon');
  wrap(Storage.prototype, 'setItem', 'storage.setItem');
  wrap(Storage.prototype, 'getItem', 'storage.getItem');
  wrap(IDBFactory.prototype, 'open', 'indexedDB');
  if (window.CacheStorage) wrap(CacheStorage.prototype, 'open', 'caches');
  const WS = window.WebSocket;
  window.WebSocket = function () { calls.push('websocket'); return new WS(...arguments); };
  const ES = window.EventSource;
  window.EventSource = function () { calls.push('eventsource'); return new ES(...arguments); };
  const ls = Object.getOwnPropertyDescriptor(window, 'localStorage');
  if (ls && ls.get) Object.defineProperty(window, 'localStorage', { get() { calls.push('localStorage'); return ls.get.call(this); } });
  const ss = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
  if (ss && ss.get) Object.defineProperty(window, 'sessionStorage', { get() { calls.push('sessionStorage'); return ss.get.call(this); } });
  const ck = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
  Object.defineProperty(document, 'cookie', { get() { calls.push('cookie'); return ''; }, set() { calls.push('cookie'); } });
})();`;

const browser = await chromium.launch();
// offline: true proves the downloaded file works without a network.
const context = await browser.newContext({ offline: true, acceptDownloads: true });
const requests = [];
const consoleErrors = [];
context.on('request', (r) => requests.push(r.url()));
await context.addInitScript(INSTRUMENT);
await context.route(/^(https?|wss?):/, (route) => { requests.push('ROUTED ' + route.request().url()); route.abort(); });

async function openApp(init) {
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  if (init) await page.addInitScript(init);
  await page.goto(appUrl);
  return page;
}

const page = await openApp();

// Run the converter in the page and return compact HTML (default margins removed).
async function h(input, opts = {}, spacing = 'spaced') {
  return page.evaluate(([input, opts, spacing]) => {
    const S = window.StoryToRichText;
    return S.renderHTML(S.convert(input, opts), { spacing })
      .replace(/ style="margin:0 0 1em"/g, '').replace(/margin:0 0 1em;/g, '').replace(/\n/g, '');
  }, [input, opts, spacing]);
}
const run = (fn, arg) => page.evaluate(fn, arg);

console.log('Conversion');

await test('missing <p>: single newline -> <br>, blank line -> new paragraph', async () => {
  assert.equal(await h('One.\nTwo.\n\nThree.'), '<p>One.<br>Two.</p><p>Three.</p>');
});
await test('CRLF and CR line endings behave like LF', async () => {
  assert.equal(await h('One.\r\nTwo.\r\n\r\nThree.'), '<p>One.<br>Two.</p><p>Three.</p>');
  assert.equal(await h('One.\rTwo.'), '<p>One.<br>Two.</p>');
});
await test('extra blank lines collapse by default, kept as spacers when asked', async () => {
  assert.equal(await h('A\n\n\n\nB'), '<p>A</p><p>B</p>');
  assert.equal(await h('A\n\n\n\nB', { keepExtra: true }), '<p>A</p><p><br></p><p><br></p><p>B</p>');
  assert.equal(await h('A\n\n\nB', { keepExtra: true }), '<p>A</p><p><br></p><p>B</p>');
});
await test('five blank lines with "keep extra" become four spacers in HTML, RTF and TXT', async () => {
  const input = 'Before.\n\n\n\n\n\nAfter.'; // five blank lines
  assert.equal(await h(input), '<p>Before.</p><p>After.</p>');
  assert.equal(await h(input, { keepExtra: true }), '<p>Before.</p>' + '<p><br></p>'.repeat(4) + '<p>After.</p>');
  const out = await run((input) => {
    const S = window.StoryToRichText;
    const blocks = S.convert(input, { keepExtra: true });
    return { txt: S.renderPlain(blocks), rtf: S.renderRTF(blocks), plainOff: S.renderPlain(S.convert(input)) };
  }, input);
  assert.equal(out.txt, input + '\n');
  assert.equal(out.plainOff, 'Before.\n\nAfter.\n');
  assert.equal((out.rtf.match(/\\pard[^\n]* \\par\n/g) || []).length, 4, out.rtf);
  assert.ok(out.rtf.indexOf('Before.') < out.rtf.indexOf('After.'));
});
await test('leading/trailing blank lines and spaces never create empty paragraphs', async () => {
  assert.equal(await h('\n\n   \n  Hello  \n\n\n'), '<p>Hello</p>');
  assert.equal(await h('   \n\t\n'), '');
});
await test('existing block HTML with indentation between blocks makes no gaps', async () => {
  const input = '<h2>Title</h2>\n\n    <p>First para.</p>\n    <p>Second\n    line.</p>\n\n\n\nAfter.';
  assert.equal(await h(input), '<h2>Title</h2><p>First para.</p><p>Second<br>line.</p><p>After.</p>');
  assert.equal(await h(input, { keepExtra: true }), '<h2>Title</h2><p>First para.</p><p>Second<br>line.</p><p>After.</p>');
});
await test('<br> followed by a newline is one break; <br><br> is kept', async () => {
  assert.equal(await h('a<br>\nb'), '<p>a<br>b</p>');
  assert.equal(await h('a<br/>  \n  b'), '<p>a<br>b</p>');
  assert.equal(await h('a<br><br>b'), '<p>a<br><br>b</p>');
  assert.equal(await h('a<br>\n\nb'), '<p>a</p><p>b</p>');
  assert.equal(await h('a<br>'), '<p>a</p>');
});
await test('center + bold title, then plain lines', async () => {
  assert.equal(await h('<center><b>Title</b></center>\nText'),
    '<p style="text-align:center"><strong>Title</strong></p><p>Text</p>');
});
await test('newlines inside inline markup split correctly and keep formatting', async () => {
  assert.equal(await h('<b>one\ntwo\n\nthree</b> four'),
    '<p><strong>one<br>two</strong></p><p><strong>three</strong> four</p>');
  assert.equal(await h('<i>a <b>b\nc</b> d</i>'), '<p><em>a <strong>b<br>c</strong> d</em></p>');
});
await test('inline formatting: bold/italic/underline/strike/sub/sup/code', async () => {
  assert.equal(await h('<strong>s</strong> <em>e</em> <u>u</u> <ins>i</ins> <s>x</s> <strike>y</strike> <del>z</del> H<sub>2</sub>O x<sup>2</sup> <code>c</code>'),
    '<p><strong>s</strong> <em>e</em> <u>u</u> <u>i</u> <s>x</s> <s>y</s> <s>z</s> H<sub>2</sub>O x<sup>2</sup> <code>c</code></p>');
});
await test('formatting from safe inline styles only', async () => {
  assert.equal(await h('<span style="font-weight:700;font-style:italic">a</span> <span style="text-decoration: underline line-through">b</span>'),
    '<p><strong><em>a</em></strong> <u><s>b</s></u></p>');
  assert.equal(await h('<span style="color:red;font-family:Comic Sans;background:url(https://evil.example/x)">plain</span>'), '<p>plain</p>');
});
await test('text-align from style/align attribute, validated', async () => {
  assert.equal(await h('<p style="text-align: RIGHT !important">r</p>'), '<p style="text-align:right">r</p>');
  assert.equal(await h('<div align="justify">j</div>'), '<p style="text-align:justify">j</p>');
  assert.equal(await h('<h1 style="text-align:center">H</h1>'), '<h1 style="text-align:center">H</h1>');
  assert.equal(await h('<p style="text-align: expression(alert(1))">x</p>'), '<p>x</p>');
  assert.equal(await h('<div style="text-align:center">a\nb\n\nc</div>'),
    '<p style="text-align:center">a<br>b</p><p style="text-align:center">c</p>');
});
await test('lists, ordered start and blockquote', async () => {
  assert.equal(await h('<ul>\n  <li>One</li>\n  <li><b>Two</b></li>\n</ul>'), '<ul><li>One</li><li><strong>Two</strong></li></ul>');
  assert.equal(await h('<ol start="3"><li>c</li><li>d</li></ol>'), '<ol start="3"><li>c</li><li>d</li></ol>');
  assert.equal(await h('<blockquote>Said\nquietly.</blockquote>'),
    '<blockquote style="margin:0 0 1em 2em"><p>Said<br>quietly.</p></blockquote>');
});
await test('mixed plain text and HTML blocks', async () => {
  assert.equal(await h('Intro line\n<p>Para</p>\nTail one\nTail two\n\n<i>End</i>'),
    '<p>Intro line</p><p>Para</p><p>Tail one<br>Tail two</p><p><em>End</em></p>');
});
await test('encoded HTML: shown literally by default, formatted in escaped mode', async () => {
  const input = '&lt;b&gt;Bold&lt;/b&gt; and &amp;lt;i&amp;gt; stays literal';
  assert.equal(await h(input), '<p>&lt;b&gt;Bold&lt;/b&gt; and &amp;lt;i&amp;gt; stays literal</p>');
  assert.equal(await h(input, { htmlMode: 'escaped' }), '<p><strong>Bold</strong> and &lt;i&gt; stays literal</p>');
  assert.equal(await h('&lt;script&gt;alert(1)&lt;/script&gt;Safe', { htmlMode: 'escaped' }), '<p>Safe</p>');
});
await test('plain-text mode shows tags as text and still keeps breaks', async () => {
  assert.equal(await h('<b>x</b>\ny\n\nz', { htmlMode: 'text' }), '<p>&lt;b&gt;x&lt;/b&gt;<br>y</p><p>z</p>');
});
await test('join mode merges wrapped lines, keeps <br> and paragraphs', async () => {
  assert.equal(await h('a\nb\n\nc<br>d', { lineBreaks: 'join' }), '<p>a b</p><p>c<br>d</p>');
});
await test('spaces collapse, non-breaking spaces survive', async () => {
  assert.equal(await h('  a   b \t \n   c'), '<p>a b<br>c</p>');
  assert.ok((await h('a&nbsp;&nbsp;b')).includes('a  b'));
});
await test('Unicode survives conversion and plain text', async () => {
  const text = 'Café — naïve “quotes” ‘é’ 😀 日本語 עברית';
  assert.equal(await h(text), `<p>${text}</p>`);
  const plain = await run((t) => window.StoryToRichText.renderPlain(window.StoryToRichText.convert(t)), text);
  assert.equal(plain, text + '\n');
});
await test('paragraph styles: indented and compact exports', async () => {
  const out = await page.evaluate(() => window.StoryToRichText.renderHTML(window.StoryToRichText.convert('A\n\nB\n\nC'), { spacing: 'indented' }));
  assert.equal(out.replace(/\n/g, ''), '<p style="margin:0">A</p><p style="margin:0;text-indent:1.5em">B</p><p style="margin:0;text-indent:1.5em">C</p>');
  const compact = await page.evaluate(() => window.StoryToRichText.renderHTML(window.StoryToRichText.convert('A\n\nB'), { spacing: 'compact' }));
  assert.equal(compact.replace(/\n/g, ''), '<p style="margin:0">A</p><p style="margin:0">B</p>');
});
await test('plain text export: paragraphs, breaks, lists and links', async () => {
  const plain = await run(() => {
    const S = window.StoryToRichText;
    return S.renderPlain(S.convert('<h2>T</h2>One\ntwo\n\n<ul><li>a</li><li>b</li></ul><ol start="2"><li>c</li></ol><a href="https://example.com/x">site</a>'));
  });
  assert.equal(plain, 'T\n\nOne\ntwo\n\n• a\n• b\n\n2. c\n\nsite (https://example.com/x)\n');
});

console.log('Security');

await test('links: only absolute http(s) kept; dangerous or relative URLs dropped', async () => {
  assert.equal(await h('<a href="https://example.com/a?b=1&amp;c=2">ok</a>'),
    '<p><a href="https://example.com/a?b=1&amp;c=2" rel="noopener noreferrer">ok</a></p>');
  for (const bad of ['javascript:alert(1)', ' JaVaScRiPt:alert(1)', 'java\nscript:alert(1)', 'data:text/html,<b>x</b>',
    'vbscript:x', '//evil.example/x', '/relative', '#top', 'mailto:a@b.c', 'https://user:pw@evil.example/', 'http://']) {
    assert.equal(await h(`<a href="${bad.replace(/"/g, '&quot;')}">t</a>`), '<p>t</p>', bad);
  }
});
const MALICIOUS = `Hello <script>window.__pwned=1</script>
<img src="https://evil.example/img.png" onerror="window.__pwned=2">
<iframe src="https://evil.example/frame"></iframe><svg onload="window.__pwned=3"><a href="https://evil.example">svg</a></svg>
<style>body{background:url(https://evil.example/bg)}</style><object data="https://evil.example/o"></object>
<embed src="https://evil.example/e"><form action="https://evil.example/f"><input value="x"><button>Send</button></form>
<meta http-equiv="refresh" content="0;url=https://evil.example/r"><link rel="stylesheet" href="https://evil.example/s.css">
<base href="https://evil.example/"><video poster="https://evil.example/p.png" src="https://evil.example/v.mp4"></video>
<math><mtext>m</mtext></math><template><img src="https://evil.example/t.png"></template><noscript>ns</noscript>
<p onclick="window.__pwned=4" style="background:url(https://evil.example/x);text-align:center" class="x" id="y">kept <b onmouseover="window.__pwned=5">bold</b></p>
<a href="javascript:window.__pwned=6">click</a> <details open ontoggle="window.__pwned=7"><summary>s</summary>d</details>
<picture><source srcset="https://evil.example/s.png"></picture><audio src="https://evil.example/a.mp3"></audio><x-custom onfocus="1">custom</x-custom>
<!-- comment --><table background="https://evil.example/tb"><tr><td>cell</td></tr></table>`;
await test('malicious markup: no active or network elements, events or arbitrary styles', async () => {
  const out = await h(MALICIOUS);
  for (const bad of ['<script', 'onerror', 'onclick', 'onload', 'onmouseover', 'ontoggle', 'evil.example', '<img', '<iframe',
    '<svg', '<style', '<object', '<embed', '<form', '<input', '<meta', '<link', '<base', '<video', 'background', 'javascript:',
    'class=', 'id=', '__pwned', '<template', 'comment', 'Send', 'x-custom']) {
    assert.ok(!out.includes(bad), `found ${bad} in ${out}`);
  }
  assert.ok(out.includes('<p style="text-align:center">kept <strong>bold</strong></p>'), out);
  for (const keep of ['Hello', 'click', 'cell', 'custom', '>s<', 'd']) assert.ok(out.includes(keep), keep);
});
await test('malicious input in the live UI: nothing runs, loads, or leaks into the preview', async () => {
  await page.fill('#source', MALICIOUS);
  await page.waitForTimeout(200);
  const info = await page.evaluate(() => {
    const allowedTags = new Set(['P', 'BR', 'STRONG', 'EM', 'U', 'S', 'SUB', 'SUP', 'CODE', 'A', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
      'BLOCKQUOTE', 'UL', 'OL', 'LI', 'PRE', 'HR']);
    const allowedAttrs = new Set(['class', 'href', 'rel', 'target', 'start']);
    const bad = [];
    for (const el of document.getElementById('preview').querySelectorAll('*')) {
      if (!allowedTags.has(el.tagName)) bad.push(el.tagName);
      for (const a of el.attributes) {
        if (!allowedAttrs.has(a.name)) bad.push(a.name);
        if (a.name === 'class' && !/^(al-(left|right|center|justify)|spacer)$/.test(a.value)) bad.push('class=' + a.value);
        if (a.name === 'href' && !/^https?:\/\//.test(a.value)) bad.push('href=' + a.value);
      }
    }
    return { bad, pwned: window.__pwned, title: document.title, base: document.baseURI };
  });
  assert.deepEqual(info.bad, []);
  assert.equal(info.pwned, undefined);
  assert.equal(info.title, 'Story to Rich Text');
  assert.equal(info.base, appUrl);
  assert.ok(!requests.some((u) => u.includes('evil.example')), 'request to evil.example');
});
await test('exported HTML is sanitized and carries its own restrictive CSP', async () => {
  const html = await run(() => window.StoryToRichText.renderStandaloneHTML(
    window.StoryToRichText.convert(document.getElementById('source').value)));
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'/);
  assert.equal((html.match(/<script/g) || []).length, 0);
  for (const bad of ['evil.example', 'onerror', 'onclick', 'javascript:']) assert.ok(!html.includes(bad), bad);
  const rtf = await run(() => window.StoryToRichText.renderRTF(
    window.StoryToRichText.convert(document.getElementById('source').value)));
  assert.ok(!rtf.includes('evil.example') && !rtf.includes('pwned'));
});
await test('RTF escapes control characters so input cannot inject RTF', async () => {
  const rtf = await run(() => window.StoryToRichText.renderRTF(window.StoryToRichText.convert('a {\\b injected} \\par b')));
  assert.ok(rtf.includes('a \\{\\\\b injected\\} \\\\par b'), rtf);
});

console.log('RTF');

function balanced(rtf) {
  let depth = 0;
  for (let i = 0; i < rtf.length; i++) {
    if (rtf[i] === '\\') { i++; continue; }
    if (rtf[i] === '{') depth++;
    if (rtf[i] === '}' && --depth < 0) return false;
  }
  return depth === 0;
}
await test('RTF: Unicode escapes incl. astral characters, paragraph and inline formatting', async () => {
  const rtf = await run(() => window.StoryToRichText.renderRTF(window.StoryToRichText.convert(
    '<center><b>Café</b></center>\nLine one\nline <i>two</i> 😀\n\n<u>Under</u> <s>gone</s> H<sub>2</sub>O x<sup>2</sup> <a href="https://example.com/">link</a>')));
  assert.ok(rtf.startsWith('{\\rtf1\\ansi'), 'header');
  assert.ok(balanced(rtf), 'balanced braces');
  assert.ok(/^[\x00-\x7f]*$/.test(rtf), 'pure ASCII output');
  assert.ok(rtf.includes('\\qc') && rtf.includes('{\\b Caf\\u233?}'), 'centered bold é');
  assert.ok(rtf.includes('Line one\\line line {\\i two} \\u-10179?\\u-8704?'), 'line break, italic, emoji surrogates');
  assert.ok(rtf.includes('{\\ul Under}') && rtf.includes('{\\strike gone}') && rtf.includes('{\\sub 2}') && rtf.includes('{\\super 2}'));
  assert.ok(rtf.includes('HYPERLINK "https://example.com/"'), 'hyperlink field');
  assert.equal((rtf.match(/\\par\n/g) || []).length, 3);
});

const hasTextutil = platform() === 'darwin' && (() => { try { execFileSync('which', ['textutil']); return true; } catch { return false; } })();
await test(`RTF opens in a real RTF reader${hasTextutil ? ' (macOS textutil)' : ' (skipped: textutil unavailable)'}`, async () => {
  if (!hasTextutil) return;
  const rtf = await run(() => window.StoryToRichText.renderRTF(window.StoryToRichText.convert(
    '<center><b>Title é</b></center>\nFirst line\nsecond line 😀 日本語\n\n<i>Next</i> paragraph — done.')));
  const f = join(work, 'check.rtf');
  writeFileSync(f, rtf);
  const txt = execFileSync('textutil', ['-convert', 'txt', '-stdout', f], { encoding: 'utf8' });
  assert.equal(txt.trim(), 'Title é\nFirst line second line 😀 日本語\nNext paragraph — done.');
  const html = execFileSync('textutil', ['-convert', 'html', '-stdout', f], { encoding: 'utf8' });
  assert.match(html, /text-align: center/);
  assert.match(html, /<b>Title é<\/b>/);
  assert.match(html, /<i>Next<\/i>/);
});

console.log('Interface');

const page2 = await openApp();
await test('privacy banner states the conversion promise without overclaiming', async () => {
  assert.equal((await page2.textContent('.privacy')).trim(),
    'Your writing stays in this tab. No uploads, accounts or AI processing. Copy or download your result before closing.');
  assert.ok(!/erase|no AI is used/i.test(appSource));
});
await test('starts empty with outputs disabled', async () => {
  assert.equal(await page2.inputValue('#source'), '');
  assert.equal(await page2.$eval('#preview', (e) => e.childNodes.length), 0);
  for (const id of ['copyRichBtn', 'copyPlainBtn', 'rtfBtn', 'htmlBtn', 'txtBtn']) assert.ok(await page2.isDisabled('#' + id), id);
});
await test('example fills empty input without asking', async () => {
  let asked = false;
  const onDialog = (d) => { asked = true; d.dismiss(); };
  page2.on('dialog', onDialog);
  await page2.click('#exampleBtn');
  page2.off('dialog', onDialog);
  assert.equal(asked, false);
  assert.ok((await page2.inputValue('#source')).includes('The Lantern Keeper'));
  assert.ok(await page2.$eval('#preview', (e) => e.querySelectorAll('p').length) >= 5);
  assert.equal(await page2.$eval('#preview p', (e) => e.className), 'al-center');
});
await test('example and clear ask before replacing text; cancelling keeps it', async () => {
  await page2.fill('#source', 'My own synthetic draft.');
  const messages = [];
  page2.on('dialog', (d) => { messages.push(d.message()); d.dismiss(); });
  await page2.click('#exampleBtn');
  await page2.click('#clearBtn');
  page2.removeAllListeners('dialog');
  assert.equal(messages.length, 2);
  assert.equal(await page2.inputValue('#source'), 'My own synthetic draft.');
  page2.once('dialog', (d) => d.accept());
  await page2.click('#clearBtn');
  assert.equal(await page2.inputValue('#source'), '');
  assert.equal(await page2.$eval('#preview', (e) => e.childNodes.length), 0);
});
await test('live preview updates while typing', async () => {
  await page2.focus('#source');
  await page2.keyboard.type('First line');
  await page2.keyboard.press('Enter');
  await page2.keyboard.type('second <b>bold</b>');
  await page2.keyboard.press('Enter');
  await page2.keyboard.press('Enter');
  await page2.keyboard.type('Next.');
  await page2.waitForTimeout(150);
  assert.equal(await page2.$eval('#preview', (e) => e.innerHTML), '<p>First line<br>second <strong>bold</strong></p><p>Next.</p>');
  assert.match(await page2.textContent('#previewCount'), /2 paragraphs · 5 words/);
});
await test('escaped-tag notice offers one-click formatting', async () => {
  await page2.fill('#source', '&lt;b&gt;Hi&lt;/b&gt; there');
  await page2.waitForTimeout(150);
  assert.ok(await page2.isVisible('#escapedNotice'));
  await page2.click('#escapedBtn');
  assert.equal(await page2.inputValue('#htmlMode'), 'escaped');
  assert.equal(await page2.$eval('#preview', (e) => e.innerHTML), '<p><strong>Hi</strong> there</p>');
  assert.ok(!(await page2.isVisible('#escapedNotice')));
  await page2.selectOption('#htmlMode', 'html');
});
await test('spacing choice changes the preview style', async () => {
  await page2.selectOption('#spacing', 'indented');
  assert.equal(await page2.$eval('#preview', (e) => e.className), 'preview sp-indented');
  await page2.selectOption('#spacing', 'spaced');
});
await test('select preview selects the formatted text', async () => {
  await page2.fill('#source', 'Alpha\n\nBeta');
  await page2.waitForTimeout(150);
  await page2.click('#selectBtn');
  assert.equal(await page2.evaluate(() => window.getSelection().toString().replace(/\s+/g, ' ').trim()), 'Alpha Beta');
  assert.match(await page2.textContent('#status'), /Preview selected/);
});

const CLIP_OK = `Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
  write: async (items) => { const c = {}; for (const it of items) for (const t of it.types) c[t] = await (await it.getType(t)).text(); window.__clip = c; },
  writeText: async (t) => { window.__clip = { 'text/plain': t }; } } });`;
await test('copy rich text writes text/html and text/plain via ClipboardItem', async () => {
  const p = await openApp(CLIP_OK);
  await p.fill('#source', '<center><b>Title</b></center>\nLine one\nLine two\n\nNext');
  await p.waitForTimeout(150);
  await p.click('#copyRichBtn');
  await p.waitForFunction(() => window.__clip);
  const clip = await p.evaluate(() => window.__clip);
  assert.ok(clip['text/html'].includes('<p style="margin:0 0 1em;text-align:center"><strong>Title</strong></p>'));
  assert.ok(clip['text/html'].includes('Line one<br>Line two'));
  assert.equal(clip['text/plain'], 'Title\n\nLine one\nLine two\n\nNext\n');
  assert.match(await p.textContent('#status'), /Copied with formatting/);
  await p.click('#copyPlainBtn');
  await p.waitForFunction(() => !window.__clip['text/html']);
  assert.match(await p.textContent('#status'), /Copied as plain text/);
  await p.close();
});
await test('when async clipboard is denied, the synchronous fallback copies both formats', async () => {
  const p = await openApp(`Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      write: async () => { throw new DOMException('no', 'NotAllowedError'); } } });
    document.addEventListener('copy', (e) => { window.__copied = { html: e.clipboardData.getData('text/html'), text: e.clipboardData.getData('text/plain') }; });`);
  await p.fill('#source', 'A <i>b</i>\nc');
  await p.waitForTimeout(150);
  await p.focus('#source');
  await p.evaluate(() => document.getElementById('source').setSelectionRange(1, 3));
  await p.click('#copyRichBtn');
  await p.waitForFunction(() => /Copied|nothing/.test(document.getElementById('status').textContent));
  const copied = await p.evaluate(() => window.__copied);
  assert.ok(copied && copied.html.includes('<em>b</em><br>c'), JSON.stringify(copied));
  assert.equal(copied.text, 'A b\nc\n');
  assert.match(await p.textContent('#status'), /Copied with formatting/);
  await p.close();
});
await test('denied clipboard is reported truthfully with the manual option', async () => {
  const p = await openApp(`Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      write: async () => { throw new DOMException('no', 'NotAllowedError'); } } });
    document.execCommand = () => false;`);
  await p.fill('#source', 'Text');
  await p.waitForTimeout(150);
  await p.click('#copyRichBtn');
  await p.waitForFunction(() => document.getElementById('status').textContent.length > 0);
  const msg = await p.textContent('#status');
  assert.match(msg, /denied clipboard access, so nothing was copied/);
  assert.match(msg, /Select preview/);
  assert.equal(await p.$eval('#status', (e) => e.className), 'status err');
  assert.ok(await p.$eval('#selectBtn', (e) => e.classList.contains('emph')));
  await p.close();
});
await test('unsupported clipboard is reported truthfully', async () => {
  const p = await openApp(`Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    document.execCommand = () => false;`);
  await p.fill('#source', 'Text');
  await p.waitForTimeout(150);
  await p.click('#copyRichBtn');
  await p.waitForFunction(() => document.getElementById('status').textContent.length > 0);
  assert.match(await p.textContent('#status'), /doesn’t allow copying from here, so nothing was copied/);
  await p.close();
});

async function downloadFrom(p, selector) {
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click(selector)]);
  const path = join(work, dl.suggestedFilename());
  await dl.saveAs(path);
  return { name: dl.suggestedFilename(), body: readFileSync(path, 'utf8'), path };
}
await test('downloads real .rtf, .html and .txt files named from the title', async () => {
  page2.once('dialog', (d) => d.accept());
  await page2.click('#exampleBtn');
  const rtf = await downloadFrom(page2, '#rtfBtn');
  assert.equal(rtf.name, 'the-lantern-keeper.rtf');
  assert.ok(rtf.body.startsWith('{\\rtf1') && balanced(rtf.body));
  assert.ok(rtf.body.includes('caf\\u233?') && rtf.body.includes('Th\\u233?o') && rtf.body.includes('\\qr'));
  if (hasTextutil) {
    const txt = execFileSync('textutil', ['-convert', 'txt', '-stdout', rtf.path], { encoding: 'utf8' });
    assert.ok(txt.includes('Théo') && txt.includes('— from the keeper’s logbook'), txt);
  }
  const html = await downloadFrom(page2, '#htmlBtn');
  assert.equal(html.name, 'the-lantern-keeper.html');
  assert.ok(html.body.startsWith('<!doctype html>') && html.body.includes('<title>The Lantern Keeper</title>'));
  assert.ok(html.body.includes('<blockquote') && html.body.includes('text-align:right'));
  const txt = await downloadFrom(page2, '#txtBtn');
  assert.equal(txt.name, 'the-lantern-keeper.txt');
  assert.ok(txt.body.startsWith('The Lantern Keeper\n\nMara climbed the lighthouse stairs at dusk, counting each step out loud.\nThe wind'));
  assert.match(await page2.textContent('#status'), /is ready/);
});
await test('edit then immediately export/copy uses the latest text, not a stale preview', async () => {
  await page2.fill('#source', 'Old words.');
  await page2.waitForTimeout(150);
  // Change the text and click in the same task, before the debounce fires.
  const [dl] = await Promise.all([page2.waitForEvent('download'), page2.evaluate(() => {
    const src = document.getElementById('source');
    src.value = 'Fresh <b>words</b>.';
    src.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('txtBtn').click();
  })]);
  const path = join(work, 'fresh.txt');
  await dl.saveAs(path);
  assert.equal(readFileSync(path, 'utf8'), 'Fresh words.\n');
  const p = await openApp(CLIP_OK);
  await p.evaluate(() => {
    const src = document.getElementById('source');
    src.value = 'Typed <i>just now</i>';
    src.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('copyRichBtn').click();
  });
  await p.waitForFunction(() => window.__clip);
  assert.ok((await p.evaluate(() => window.__clip['text/html'])).includes('Typed <em>just now</em>'));
  await p.close();
});
await test('five blank lines with "keep extra" show four spacers in the preview and .txt download', async () => {
  await page2.check('#keepExtra');
  await page2.fill('#source', 'Before.\n\n\n\n\n\nAfter.');
  await page2.waitForTimeout(150);
  assert.equal(await page2.$$eval('#preview p.spacer', (e) => e.length), 4);
  const [dl] = await Promise.all([page2.waitForEvent('download'), page2.click('#txtBtn')]);
  const path = join(work, 'spacers.txt');
  await dl.saveAs(path);
  assert.equal(readFileSync(path, 'utf8'), 'Before.\n\n\n\n\n\nAfter.\n');
  await page2.uncheck('#keepExtra');
  assert.equal(await page2.$$eval('#preview p.spacer', (e) => e.length), 0);
});
await test('word count separates paragraphs and line breaks', async () => {
  await page2.fill('#source', 'Alpha\nBeta\n\nGamma<br>Delta<h2>Epsilon</h2><ul><li>Zeta</li><li>Eta</li></ul>');
  await page2.waitForTimeout(150);
  assert.match(await page2.textContent('#previewCount'), /· 7 words$/);
});
await test('source box turns off browser spelling, autocorrect and writing suggestions', async () => {
  const attrs = await page2.$eval('#source', (e) => ({ spell: e.spellcheck, ac: e.getAttribute('autocomplete'),
    corr: e.getAttribute('autocorrect'), cap: e.getAttribute('autocapitalize'), ws: e.getAttribute('writingsuggestions') }));
  assert.deepEqual(attrs, { spell: false, ac: 'off', corr: 'off', cap: 'off', ws: 'false' });
});
await test('save-for-offline link points at this static file, even when renamed, never a serialized draft', async () => {
  const link = await page2.$eval('a.save', (a) => ({ href: a.href, dl: a.getAttribute('download'), text: a.textContent }));
  assert.deepEqual(link, { href: appUrl, dl: 'story-to-rich-text.html', text: 'Save this tool for offline use' });
  const renamed = join(work, 'my renamed copy.html');
  writeFileSync(renamed, appSource);
  const p = await context.newPage();
  await p.goto(pathToFileURL(renamed).href + '?draft=1#section');
  assert.equal(await p.$eval('a.save', (a) => a.href), pathToFileURL(renamed).href);
  await p.close();
  assert.ok(!/outerHTML|XMLSerializer|documentElement\.innerHTML/.test(appSource));
});
await test('form controls are labelled and the page has no horizontal scroll on a phone', async () => {
  const unlabeled = await page2.evaluate(() => [...document.querySelectorAll('select, textarea, input')]
    .filter((e) => !e.labels || !e.labels.length).map((e) => e.id));
  assert.deepEqual(unlabeled, []);
  const nameless = await page2.evaluate(() => [...document.querySelectorAll('button')].filter((b) => !b.textContent.trim()).length);
  assert.equal(nameless, 0);
  await page2.setViewportSize({ width: 375, height: 800 });
  assert.ok(await page2.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'horizontal overflow');
  await page2.setViewportSize({ width: 1280, height: 800 });
});

console.log('Privacy');

await test('no network, storage or cookie use by the app during all of the above', async () => {
  const calls = [];
  for (const p of context.pages()) calls.push(...await p.evaluate(() => window.__calls.slice()));
  assert.deepEqual(calls, []);
  const outside = requests.filter((u) => !u.startsWith(appUrl) && !u.startsWith(pathToFileURL(work).href) && !u.startsWith('blob:'));
  assert.deepEqual(outside, []);
});
await test('Content-Security-Policy hashes match and block outgoing requests', async () => {
  const meta = appSource.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/)[1];
  assert.equal(meta, expectedPolicy(appSource));
  assert.match(meta, /default-src 'none'/);
  assert.match(meta, /connect-src 'none'/);
  assert.ok(!/unsafe-inline|unsafe-eval/.test(meta));
  // Fresh online context without instrumentation: CSP alone must stop these.
  const ctx = await browser.newContext();
  const hits = [];
  await ctx.route(/^(https?|wss?):/, (r) => { hits.push(r.request().url()); r.abort(); });
  const p = await ctx.newPage();
  await p.goto(appUrl);
  const outcome = await p.evaluate(async () => {
    const violations = [];
    document.addEventListener('securitypolicyviolation', (e) => violations.push(e.effectiveDirective));
    const f = await fetch('https://example.com/collect').then(() => 'sent', () => 'blocked');
    const img = new Image(); img.src = 'https://example.com/pixel.png';
    try { new WebSocket('wss://example.com/ws'); } catch (e) {}
    navigator.sendBeacon && navigator.sendBeacon('https://example.com/beacon', 'x');
    await new Promise((r) => setTimeout(r, 300));
    return { f, violations };
  });
  await ctx.close();
  assert.equal(outcome.f, 'blocked');
  assert.ok(outcome.violations.includes('connect-src') && outcome.violations.includes('img-src'), JSON.stringify(outcome));
  assert.deepEqual(hits, []);
});
await test('source has no external resources, storage, network or analytics code', async () => {
  for (const bad of [/<script[^>]+src=/i, /<link\b/i, /@import/i, /\burl\(/, /\bfetch\(/, /XMLHttpRequest/, /localStorage/,
    /sessionStorage/, /indexedDB/i, /sendBeacon/, /WebSocket/, /EventSource/, /serviceWorker/, /document\.cookie/, /\.innerHTML\s*=(?!.*source)/]) {
    assert.ok(!bad.test(appSource), String(bad));
  }
  const urls = (appSource.match(/https?:\/\/[^\s"'`)<]*/g) || []).map((u) => u.replace(/[.,]+$/, ''));
  const allowed = ['http://www.w3.org/1999/xhtml', 'http://', 'https://'];
  assert.deepEqual(urls.filter((u) => !allowed.includes(u)), []);
  assert.equal((appSource.match(/\.innerHTML\s*=/g) || []).length, 1, 'only the inert template parse uses innerHTML');
  assert.match(appSource, /tpl\.innerHTML = source;/);
});
await test('no console errors or page errors', async () => {
  // Chrome logs a CSP notice when pasted HTML contains style="" attributes:
  // the policy refuses to apply them even in the inert parse. That is the
  // intended defence (alignment is read from the attribute text instead), so
  // only that notice is allowed.
  const unexpected = consoleErrors.filter((m) => !m.startsWith('Applying inline style violates the following Content Security Policy'));
  assert.deepEqual(unexpected, []);
});

await browser.close();
rmSync(work, { recursive: true, force: true });
const failed = results.filter((r) => !r[0]);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
