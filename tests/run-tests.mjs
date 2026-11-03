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
import { expectedPolicy, COUNTER_IMAGE } from '../tools/update-csp.mjs';

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

async function reveal(p, selector) {
  const id = ['#htmlMode', '#lineBreaks', '#keepExtra', '#spacing', '#autoBtn'].includes(selector) ? 'adjust' : 'moreSave';
  if (!(await p.$eval('#' + id, (e) => e.open))) await p.locator('#' + id + ' > summary').click();
}


// Run the converter in the page and return compact HTML (default margins removed).
async function h(input, opts = {}, spacing = 'spaced') {
  return page.evaluate(([input, opts, spacing]) => {
    const S = window.TextUnwrapped;
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
    const S = window.TextUnwrapped;
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
  const plain = await run((t) => window.TextUnwrapped.renderPlain(window.TextUnwrapped.convert(t)), text);
  assert.equal(plain, text + '\n');
});
await test('paragraph styles: indented and compact exports', async () => {
  const out = await page.evaluate(() => window.TextUnwrapped.renderHTML(window.TextUnwrapped.convert('A\n\nB\n\nC'), { spacing: 'indented' }));
  assert.equal(out.replace(/\n/g, ''), '<p style="margin:0">A</p><p style="margin:0;text-indent:1.5em">B</p><p style="margin:0;text-indent:1.5em">C</p>');
  const compact = await page.evaluate(() => window.TextUnwrapped.renderHTML(window.TextUnwrapped.convert('A\n\nB'), { spacing: 'compact' }));
  assert.equal(compact.replace(/\n/g, ''), '<p style="margin:0">A</p><p style="margin:0">B</p>');
});
await test('plain text export: paragraphs, breaks, lists and links', async () => {
  const plain = await run(() => {
    const S = window.TextUnwrapped;
    return S.renderPlain(S.convert('<h2>T</h2>One\ntwo\n\n<ul><li>a</li><li>b</li></ul><ol start="2"><li>c</li></ol><a href="https://example.com/x">site</a>'));
  });
  assert.equal(plain, 'T\n\nOne\ntwo\n\n• a\n• b\n\n2. c\n\nsite (https://example.com/x)\n');
});


console.log('Automatic detection');
const automatically = (input, preferences = {}) => run(([input, preferences]) => {
  const S = window.TextUnwrapped;
  const options = S.resolveOptions(input, preferences);
  const blocks = S.convert(input, options);
  return { options, html: S.renderHTML(blocks, options), text: S.renderPlain(blocks) };
}, [input, preferences]);
const prose = 'The old station stood at the edge of the village beside the road that followed the river through the valley and past the orchard where the early light settled on the leaves while a patient gardener carried a basket between the trees and watched the morning train disappear around the bend before turning back toward the little house with the open door and the warm kitchen waiting inside.';
const wrap = (text, width = 74) => {
  const lines = []; let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + word.length + 1 > width) { lines.push(line); line = word; }
    else line += (line ? ' ' : '') + word;
  }
  lines.push(line); return lines.join('\n');
};
await test('auto preserves paragraphs without p tags and recognizes centered bold headings', async () => {
  const r = await automatically('First line\nsecond line\n\n<center><b>Later</b></center>\n\n<i>A fresh paragraph.</i>');
  assert.equal(r.options.htmlMode, 'html');
  assert.equal(r.options.lineBreaks, 'keep');
  assert.match(r.html, /First line<br>second line/);
  assert.match(r.html, /text-align:center.*<strong>Later<\/strong>/);
  assert.equal(r.text, 'First line\nsecond line\n\nLater\n\nA fresh paragraph.\n');
});
await test('auto handles escaped and mixed tags safely, including numeric entities', async () => {
  for (const encoded of ['&lt;i&gt;quiet&lt;/i&gt;', '&#60;i&#62;quiet&#60;/i&#62;']) {
    const r = await automatically('<b>Morning</b> and ' + encoded);
    assert.equal(r.options.htmlMode, 'escaped');
    assert.match(r.html, /<strong>Morning<\/strong> and <em>quiet<\/em>/);
  }
  const unsafe = await automatically('&lt;script&gt;alert(1)&lt;/script&gt;&lt;b&gt;Safe&lt;/b&gt;');
  assert.ok(!unsafe.html.includes('alert'));
  assert.match(unsafe.html, /<strong>Safe<\/strong>/);
});
await test('auto preserves ordinary angle-bracket prose and decodes normal entities once', async () => {
  assert.equal((await automatically('A note for <reader>: 2 < 3 & 5 > 4.')).text, 'A note for <reader>: 2 < 3 & 5 > 4.\n');
  assert.equal((await automatically('Caf&eacute; &amp; tea — 😀')).text, 'Café & tea — 😀\n');
  const r = await automatically('&amp;lt;i&amp;gt;an example&amp;lt;/i&amp;gt;');
  assert.ok(!r.html.includes('<em>'));
  const code = await automatically('<code>&lt;b&gt;example&lt;/b&gt;</code>');
  assert.ok(!code.html.includes('<strong>'));
});
await test('auto joins strongly evidenced wrapped prose without changing any words', async () => {
  const r = await automatically(wrap(prose));
  assert.equal(r.options.lineBreaks, 'join');
  assert.equal(r.text, prose + '\n');
  assert.ok(!r.html.includes('<br>'));
});
await test('auto keeps poems, dialogue, lists, and mixed or uncertain line breaks', async () => {
  const inputs = ['a quiet shore\na rising tide\na distant light\na place to hide',
    '“Are you ready?”\n“Yes, I am.”\n“Then let’s go.”\n“All right.”',
    '• One thing\n• Another thing\n• One more thing',
    'One fairly long line of prose that does not form a predictable pattern\na much shorter line\nSomething Else',
    wrap(prose) + '\n\na quiet shore\na rising tide'];
  for (const input of inputs) {
    const r = await automatically(input);
    assert.equal(r.options.lineBreaks, 'keep', input);
    assert.equal(r.text, input + '\n');
  }
  const list = await automatically('<ul><li>one\ntwo</li></ul>\n' + wrap(prose));
  assert.equal(list.options.lineBreaks, 'keep');
});
await test('auto keeps section gaps but ignores indentation between existing HTML blocks', async () => {
  const input = 'Before\n\n\n\nAfter';
  assert.equal((await automatically(input)).text, input + '\n');
  assert.equal((await automatically('<p>Before</p>\n\n\n\n<p>After</p>')).text, 'Before\n\nAfter\n');
});
await test('explicit choices override detection while paragraph appearance remains a preference', async () => {
  const r = await automatically('&lt;b&gt;Word&lt;/b&gt;\nnext', { htmlMode: 'text', lineBreaks: 'join', keepExtra: 'remove', spacing: 'indented' });
  assert.equal(r.options.automatic, false);
  assert.equal(r.options.spacing, 'indented');
  assert.ok(!r.html.includes('<strong>'));
  assert.equal((await automatically(wrap(prose), { lineBreaks: 'keep' })).options.lineBreaks, 'keep');
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
  assert.equal(info.title, 'Text, Unwrapped');
  assert.equal(info.base, appUrl);
  assert.ok(!requests.some((u) => u.includes('evil.example')), 'request to evil.example');
});
await test('exported HTML is sanitized and carries its own restrictive CSP', async () => {
  const html = await run(() => window.TextUnwrapped.renderStandaloneHTML(
    window.TextUnwrapped.convert(document.getElementById('source').value)));
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'/);
  assert.equal((html.match(/<script/g) || []).length, 0);
  for (const bad of ['evil.example', 'onerror', 'onclick', 'javascript:']) assert.ok(!html.includes(bad), bad);
  const rtf = await run(() => window.TextUnwrapped.renderRTF(
    window.TextUnwrapped.convert(document.getElementById('source').value)));
  assert.ok(!rtf.includes('evil.example') && !rtf.includes('pwned'));
});
await test('RTF escapes control characters so input cannot inject RTF', async () => {
  const rtf = await run(() => window.TextUnwrapped.renderRTF(window.TextUnwrapped.convert('a {\\b injected} \\par b')));
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
  const rtf = await run(() => window.TextUnwrapped.renderRTF(window.TextUnwrapped.convert(
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
  const rtf = await run(() => window.TextUnwrapped.renderRTF(window.TextUnwrapped.convert(
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
    'Your writing stays on your device. No uploads or AI processing.');
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
  assert.ok((await page2.inputValue('#source')).includes('Weekend notes'));
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
await test('escaped formatting is detected without opening settings or changing the source', async () => {
  const input = '&lt;b&gt;Hi&lt;/b&gt; there';
  await page2.fill('#source', input);
  await page2.waitForTimeout(150);
  assert.equal(await page2.inputValue('#htmlMode'), 'auto');
  assert.equal(await page2.inputValue('#source'), input);
  assert.equal(await page2.$eval('#preview', (e) => e.innerHTML), '<p><strong>Hi</strong> there</p>');
  assert.match(await page2.textContent('#autoSummary'), /Formatting restored/);
});
await test('spacing choice changes the preview style', async () => {
  await reveal(page2, '#spacing');
  await page2.selectOption('#spacing', 'indented');
  assert.equal(await page2.$eval('#preview', (e) => e.className), 'preview sp-indented');
  await page2.selectOption('#spacing', 'spaced');
});
await test('select preview selects the formatted text', async () => {
  await page2.fill('#source', 'Alpha\n\nBeta');
  await page2.waitForTimeout(150);
  await reveal(page2, '#selectBtn');
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
  await reveal(p, '#copyPlainBtn');
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
  if (['#htmlBtn', '#txtBtn', '#saveTool'].includes(selector)) await reveal(p, selector);
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click(selector)]);
  const path = join(work, dl.suggestedFilename());
  await dl.saveAs(path);
  return { name: dl.suggestedFilename(), body: readFileSync(path, 'utf8'), path };
}
await test('downloads real .rtf, .html and .txt files named from the title', async () => {
  page2.once('dialog', (d) => d.accept());
  await page2.click('#exampleBtn');
  const rtf = await downloadFrom(page2, '#rtfBtn');
  assert.equal(rtf.name, 'weekend-notes.rtf');
  assert.ok(rtf.body.startsWith('{\\rtf1') && balanced(rtf.body));
  assert.ok(rtf.body.includes('caf\\u233?') && rtf.body.includes('Th\\u233?o') && rtf.body.includes('\\qr'));
  if (hasTextutil) {
    const txt = execFileSync('textutil', ['-convert', 'txt', '-stdout', rtf.path], { encoding: 'utf8' });
    assert.ok(txt.includes('Théo') && txt.includes('— a note to yourself'), txt);
  }
  const html = await downloadFrom(page2, '#htmlBtn');
  assert.equal(html.name, 'weekend-notes.html');
  assert.ok(html.body.startsWith('<!doctype html>') && html.body.includes('<title>Weekend notes</title>'));
  assert.ok(html.body.includes('<blockquote') && html.body.includes('text-align:right'));
  const txt = await downloadFrom(page2, '#txtBtn');
  assert.equal(txt.name, 'weekend-notes.txt');
  assert.ok(txt.body.startsWith('Weekend notes\n\nHello there,\nA little breathing room makes the day feel brighter.\n\nA few good things'));
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
  await reveal(page2, '#keepExtra');
  await page2.selectOption('#keepExtra', 'keep');
  await page2.fill('#source', 'Before.\n\n\n\n\n\nAfter.');
  await page2.waitForTimeout(150);
  assert.equal(await page2.$$eval('#preview p.spacer', (e) => e.length), 4);
  await reveal(page2, '#txtBtn');
  const [dl] = await Promise.all([page2.waitForEvent('download'), page2.click('#txtBtn')]);
  const path = join(work, 'spacers.txt');
  await dl.saveAs(path);
  assert.equal(readFileSync(path, 'utf8'), 'Before.\n\n\n\n\n\nAfter.\n');
  await reveal(page2, '#keepExtra');
  await page2.selectOption('#keepExtra', 'remove');
  assert.equal(await page2.$$eval('#preview p.spacer', (e) => e.length), 0);
  await page2.selectOption('#keepExtra', 'auto');
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
await test('offline tool stays blank after editing, including renamed local copies', async () => {
  const link = await page2.$eval('a.save', (a) => ({ href: a.href, dl: a.getAttribute('download'), text: a.textContent }));
  assert.deepEqual(link, { href: appUrl, dl: 'text-unwrapped.html', text: 'Save this tool for offline use' });
  const renamed = join(work, 'my renamed copy.html');
  writeFileSync(renamed, appSource);
  const p = await context.newPage();
  await p.goto(pathToFileURL(renamed).href + '?draft=1#section');
  assert.equal(await p.$eval('a.save', (a) => a.href), pathToFileURL(renamed).href);
  await p.close();
  await page2.fill('#source', 'UNPUBLISHED_TEXT_93742');
  await downloadFrom(page2, '#txtBtn');
  const tool = await downloadFrom(page2, '#saveTool');
  assert.equal(tool.name, 'text-unwrapped.html');
  assert.ok(!tool.body.includes('UNPUBLISHED_TEXT_93742'));
  assert.ok(!tool.body.includes('unpublished-text-93742'));
  assert.match(tool.body, /<textarea\b[^>]*>\s*<\/textarea>/);
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


await test('default UI hides technical choices and optional save formats', async () => {
  const p = await openApp();
  assert.equal(await p.$eval('#adjust', e => e.open), false);
  assert.equal(await p.$eval('#moreSave', e => e.open), false);
  assert.equal(await p.isVisible('#htmlMode'), false);
  assert.equal(await p.isVisible('#copyPlainBtn'), false);
  assert.equal(await p.inputValue('#htmlMode'), 'auto');
  assert.equal(await p.inputValue('#lineBreaks'), 'auto');
  assert.equal(await p.inputValue('#keepExtra'), 'auto');
  assert.equal(await p.textContent('#copyRichBtn'), 'Copy formatted text');
  assert.equal(await p.textContent('#rtfBtn'), 'Download document');
  await p.close();
});
await test('settings open with the keyboard, manual choices persist, and automatic reset works', async () => {
  const p = await openApp();
  await p.locator('#adjust > summary').focus();
  await p.keyboard.press('Enter');
  assert.equal(await p.$eval('#adjust', e => e.open), true);
  await p.selectOption('#htmlMode', 'text');
  await p.selectOption('#lineBreaks', 'join');
  await p.selectOption('#keepExtra', 'remove');
  await p.selectOption('#spacing', 'indented');
  const input = '<b>Literal</b>\nnext\n\n\nEnd';
  await p.fill('#source', input);
  await p.waitForTimeout(150);
  assert.equal(await p.inputValue('#source'), input);
  assert.equal(await p.inputValue('#htmlMode'), 'text');
  assert.ok(!(await p.$eval('#preview', e => e.innerHTML)).includes('<strong>'));
  await reveal(p, '#autoBtn');
  await p.click('#autoBtn');
  assert.equal(await p.inputValue('#htmlMode'), 'auto');
  assert.equal(await p.inputValue('#lineBreaks'), 'auto');
  assert.equal(await p.inputValue('#keepExtra'), 'auto');
  assert.equal(await p.inputValue('#spacing'), 'spaced');
  assert.equal(await p.$eval('#adjust', e => e.open), false);
  assert.equal(await p.inputValue('#source'), input);
  assert.match(await p.$eval('#preview', e => e.innerHTML), /<strong>Literal<\/strong><br>next/);
  await p.close();
});
await test('copy and document actions remain in the viewport at desktop and phone sizes', async () => {
  const p = await openApp();
  await p.fill('#source', Array(150).fill('A long text paragraph with <b>some formatting</b>.').join('\n\n'));
  await p.waitForTimeout(200);
  for (const [width, height] of [[1280,800],[1024,768],[900,600],[375,667],[390,844],[320,568],[667,375]]) {
    await p.setViewportSize({ width, height });
    if (width < 900) await p.click('#showPreviewBtn');
    const metrics = await p.evaluate(() => {
      const bounds = el => { const r = el.getBoundingClientRect(); return { top:r.top, bottom:r.bottom, left:r.left, right:r.right }; };
      return { height:innerHeight, width:innerWidth, page:document.documentElement.scrollHeight,
        scrollWidth:document.documentElement.scrollWidth,
        actions:[document.getElementById('copyRichBtn'),document.getElementById('rtfBtn'),document.querySelector('#moreSave > summary')].map(bounds),
        previewHeight:document.getElementById('preview').clientHeight,
        previewScroll:document.getElementById('preview').scrollHeight };
    });
    assert.ok(metrics.page <= height + 1, JSON.stringify({width,height,metrics}));
    assert.ok(metrics.scrollWidth <= width, 'horizontal overflow at ' + width);
    for (const rect of metrics.actions) assert.ok(rect.top >= 0 && rect.bottom <= height + 1 && rect.left >= 0 && rect.right <= width + 1, JSON.stringify({width,height,rect}));
    assert.ok(metrics.previewHeight >= 45, JSON.stringify({width,height,metrics}));
    assert.ok(metrics.previewScroll > metrics.previewHeight, 'long preview scrolls inside its pane');
  }
  await p.close();
});
await test('phone view switch keeps the original text and manual selection reveals the preview', async () => {
  const p = await openApp();
  await p.setViewportSize({width:375,height:667});
  await p.fill('#source', 'First\n\nSecond');
  await p.waitForTimeout(150);
  assert.equal(await p.isVisible('#source'), true);
  await p.click('#showPreviewBtn');
  assert.equal(await p.isVisible('#source'), false);
  assert.equal(await p.isVisible('#preview'), true);
  await p.click('#showSourceBtn');
  assert.equal(await p.inputValue('#source'), 'First\n\nSecond');
  await reveal(p, '#selectBtn');
  await p.click('#selectBtn');
  assert.equal(await p.isVisible('#preview'), true);
  assert.equal(await p.evaluate(() => getSelection().toString().replace(/\s+/g,' ').trim()), 'First Second');
  await p.close();
});
console.log('Site visits counter');

// The published page and the counter are mocked: tests never contact either.
const PROD_ORIGIN = 'https://brianmarkowitz.github.io';
const PROD_URL = PROD_ORIGIN + '/story-to-rich-text/';
const COUNTER_SRC = COUNTER_IMAGE + '?label=Site%20visits&color=226247&labelColor=173a2d';
const COUNTER_STATS = 'https://hits.sh/brianmarkowitz.github.io/story-to-rich-text/visits-20261103-r1/';
const badgeSVG = (count, width) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="Site visits: ${count}"><rect width="${width}" height="20" rx="3" fill="#173a2d"/><text x="6" y="14" fill="#fff" font-size="11" font-family="Verdana">Site visits ${count}</text></svg>`;

// A fresh online context where every request is recorded and answered locally.
async function prodContext({ counter = 'ok', count = '1', width = 96, init } = {}) {
  const ctx = await browser.newContext({ acceptDownloads: true });
  const seen = [];
  const errors = [];
  ctx.on('request', (r) => seen.push(r));
  await ctx.addInitScript(INSTRUMENT);
  if (init) await ctx.addInitScript(init);
  await ctx.route(/^(https?|wss?):/, async (route) => {
    const url = route.request().url();
    const u = new URL(url);
    if (u.hostname === 'hits.sh') {
      if (counter === 'fail') return route.abort('failed');
      return route.fulfill({ status: 200, headers: { 'content-type': 'image/svg+xml', 'cache-control': 'no-cache, no-store' }, body: badgeSVG(count, width) });
    }
    if (u.protocol === 'https:' && /\.github\.io$/.test(u.hostname)) {
      return route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: appSource });
    }
    return route.abort();
  });
  const open = async (url) => {
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(String(e)));
    await p.goto(url);
    return p;
  };
  const web = () => seen.filter((r) => /^https?:/.test(r.url()));
  const counterHits = () => web().filter((r) => new URL(r.url()).hostname === 'hits.sh');
  return { ctx, open, web, counterHits, errors };
}

await test('published page loads exactly one fixed counter image, with no referrer, cookies or writing', async () => {
  const env = await prodContext({ init: CLIP_OK });
  const p = await env.open(PROD_URL + '?draft=SECRET_QUERY_5531#SECRET_HASH');
  await p.waitForFunction(() => { const i = document.querySelector('#visits img'); return i && i.complete && i.naturalWidth > 0; });
  assert.equal(await p.isVisible('#visits'), true);
  assert.equal(await p.$eval('#visits img', (i) => i.alt), 'Site visits counter');
  assert.match(await p.getAttribute('#visits', 'title'), /repeat visits.*Nov 3, 2026.*not a count of unique people/);
  assert.deepEqual(await p.$eval('#visits', (a) => ({ rel: a.rel, ref: a.referrerPolicy, href: a.href })),
    { rel: 'noopener noreferrer', ref: 'no-referrer', href: COUNTER_STATS });
  // Use the tool fully: type, load the example, change and reset settings, copy and download.
  const sentinel = 'PRIVATE_WRITING_SENTINEL_7781';
  await p.fill('#source', `<b>${sentinel}</b>\n\nMore text.`);
  await p.waitForTimeout(150);
  p.once('dialog', (d) => d.accept());
  await p.click('#exampleBtn');
  await reveal(p, '#lineBreaks');
  await p.selectOption('#lineBreaks', 'join');
  await p.click('#autoBtn');
  await p.fill('#source', `<b>${sentinel}</b>`);
  await p.click('#copyRichBtn');
  await p.waitForFunction(() => window.__clip);
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#rtfBtn')]);
  const rtfBody = readFileSync(await dl.path(), 'utf8');
  assert.ok(rtfBody.includes(sentinel) && !rtfBody.includes('hits.sh'), 'export carries the text, never the counter');
  const [hdl] = await Promise.all([p.waitForEvent('download'), (async () => { await reveal(p, '#htmlBtn'); await p.click('#htmlBtn'); })()]);
  assert.ok(!readFileSync(await hdl.path(), 'utf8').includes('hits.sh'), 'HTML export has no counter');
  await p.waitForTimeout(300);
  const hits = env.counterHits();
  assert.equal(hits.length, 1, hits.map((r) => r.url()).join('\n'));
  assert.equal(hits[0].url(), COUNTER_SRC);
  assert.equal(hits[0].method(), 'GET');
  const headers = await hits[0].allHeaders();
  assert.equal(headers.referer, undefined, 'no Referer');
  assert.equal(headers.cookie, undefined, 'no cookies');
  // Only the page itself and the badge touched the network, and nothing carried the writing.
  assert.deepEqual(env.web().map((r) => r.url()), [PROD_URL + '?draft=SECRET_QUERY_5531', COUNTER_SRC]);
  for (const r of env.web().slice(1)) {
    for (const bad of [sentinel, 'SECRET_QUERY', 'SECRET_HASH', 'weekend', 'Weekend']) assert.ok(!r.url().includes(bad) && !(r.postData() || '').includes(bad), bad);
  }
  assert.deepEqual(await p.evaluate(() => window.__calls.slice()), [], 'no storage or other network APIs');
  assert.deepEqual(env.errors, []);
  await p.close();
  // The index.html address also counts, once per page load.
  const q = await env.open(PROD_ORIGIN + '/story-to-rich-text/index.html');
  await q.waitForSelector('#visits img');
  await q.waitForTimeout(200);
  assert.equal(env.counterHits().length, 2);
  assert.equal(env.counterHits()[1].url(), COUNTER_SRC);
  await env.ctx.close();
});

await test('offline copy saved from the published page never carries a loaded counter', async () => {
  const env = await prodContext();
  const p = await env.open(PROD_URL);
  await p.waitForSelector('#visits img');
  await p.fill('#source', 'Draft that must stay out.');
  await reveal(p, '#selectBtn');
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#saveTool')]);
  const body = readFileSync(await dl.path(), 'utf8');
  assert.equal(dl.suggestedFilename(), 'text-unwrapped.html');
  assert.ok(!body.includes('<img') && !body.includes('Draft that must stay out'), 'blank copy has no live badge or draft');
  assert.match(body, /<a class="visits" id="visits" hidden=""/);
  assert.equal(env.counterHits().length, 1);
  await env.ctx.close();
});

await test('blocked counter shows a visible fallback and formatting still works', async () => {
  const env = await prodContext({ counter: 'fail' });
  const p = await env.open(PROD_URL);
  await p.waitForSelector('#visits .visits-off');
  assert.equal(await p.textContent('#visits'), 'Site visits unavailable');
  assert.equal(await p.getAttribute('#visits', 'href'), null, 'no statistics link while unavailable');
  await p.fill('#source', 'Still <b>works</b>.');
  await p.waitForTimeout(150);
  assert.equal(await p.$eval('#preview', (e) => e.innerHTML), '<p>Still <strong>works</strong>.</p>');
  await p.waitForTimeout(500);
  assert.equal(env.counterHits().length, 1, 'no retries');
  assert.deepEqual(env.errors, []);
  await env.ctx.close();
});

await test('no counter request on other paths, other origins or local copies', async () => {
  const env = await prodContext();
  for (const url of [PROD_ORIGIN + '/', PROD_ORIGIN + '/story-to-rich-text/other.html', PROD_ORIGIN + '/story-to-rich-text-copy/',
    'https://someone-else.github.io/story-to-rich-text/']) {
    const p = await env.open(url);
    await p.waitForTimeout(150);
    assert.equal(await p.isVisible('#visits'), false, url);
    assert.equal(await p.$('#visits img'), null, url);
    await p.close();
  }
  const local = await env.open(appUrl);
  await local.waitForTimeout(150);
  assert.equal(await local.isVisible('#visits'), false);
  await local.close();
  assert.equal(env.counterHits().length, 0);
  await env.ctx.close();
});

await test('a very large count stays fully readable in the header without overflow or hiding the actions', async () => {
  const env = await prodContext({ count: '1,234,567,890', width: 190 });
  const p = await env.open(PROD_URL);
  await p.waitForFunction(() => { const i = document.querySelector('#visits img'); return i && i.complete && i.naturalWidth > 0; });
  await p.fill('#source', Array(120).fill('A long text paragraph with <b>some formatting</b>.').join('\n\n'));
  await p.waitForTimeout(200);
  for (const [width, height] of [[1280,800],[1024,768],[900,600],[375,667],[390,844],[320,568],[667,375]]) {
    await p.setViewportSize({ width, height });
    if (width < 900) await p.click('#showPreviewBtn');
    const m = await p.evaluate(() => {
      const r = (el) => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, w: b.width, h: b.height }; };
      const img = document.querySelector('#visits img');
      const h1 = document.querySelector('.brand h1');
      return { page: document.documentElement.scrollHeight, sw: document.documentElement.scrollWidth,
        badge: r(document.getElementById('visits')), img: r(img), natural: [img.naturalWidth, img.naturalHeight],
        brand: r(document.querySelector('.brand')), mark: r(document.querySelector('.mark')), h1: r(h1),
        h1Line: parseFloat(getComputedStyle(h1).lineHeight), preview: document.getElementById('preview').clientHeight,
        actions: [r(document.getElementById('copyRichBtn')), r(document.getElementById('rtfBtn')), r(document.querySelector('#moreSave > summary'))] };
    });
    const ctx = JSON.stringify({ width, height, m });
    assert.ok(m.sw <= width, 'horizontal overflow ' + ctx);
    assert.ok(m.page <= height + 1, 'page scroll ' + ctx);
    assert.ok(m.badge.left >= 0 && m.badge.right <= width - 8 && m.badge.right <= m.brand.right + 0.5 && m.badge.top >= 0, 'badge visible inside the gutter ' + ctx);
    // The count is drawn at its native size: full width and 20px tall, never squeezed.
    assert.deepEqual(m.natural, [190, 20], ctx);
    assert.ok(Math.abs(m.img.w - 190) < 0.5 && Math.abs(m.img.h - 20) < 0.5, 'badge image at native readable size ' + ctx);
    assert.ok(m.img.left >= m.badge.left - 0.5 && m.img.right <= m.badge.right + 0.5, 'badge image not clipped by its pill ' + ctx);
    // The logo and heading keep their size; the badge wraps rather than overlapping them.
    assert.ok(Math.abs(m.mark.w - 32) < 0.5 && Math.abs(m.mark.h - 32) < 0.5, 'logo size kept ' + ctx);
    assert.ok(m.h1.h <= m.h1Line * 1.1, 'heading stays on one line ' + ctx);
    assert.ok(m.badge.top >= m.h1.bottom - 0.5 || m.badge.left >= m.h1.right, 'badge does not overlap the heading ' + ctx);
    assert.ok(m.preview >= 45, 'preview pane still usable ' + ctx);
    for (const a of m.actions) assert.ok(a.top >= 0 && a.bottom <= height + 1 && a.left >= 0 && a.right <= width + 1, 'actions visible ' + ctx);
  }
  await env.ctx.close();
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
  assert.ok(meta.includes(`img-src ${COUNTER_IMAGE};`), 'images limited to the exact counter badge path');
  const rest = meta.replace(`img-src ${COUNTER_IMAGE};`, '');
  assert.ok(!/hits\.sh|https?:|\*|'self'|data:|blob:/.test(rest), 'no other remote, wildcard or local sources: ' + rest);
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
  const urls = (appSource.match(/https?:\/\/[^\s"'`)<]*/g) || []).map((u) => u.replace(/[.,;]+$/, ''));
  const allowed = ['http://www.w3.org/1999/xhtml', 'http://', 'https://', COUNTER_IMAGE, COUNTER_SRC, COUNTER_STATS, PROD_ORIGIN];
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
