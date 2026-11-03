// Recomputes the Content-Security-Policy in docs/index.html so it permits only
// the page's own inline <script> and <style> (by SHA-256 hash) and nothing else.
// Usage: node tools/update-csp.mjs          (rewrite the file)
//        node tools/update-csp.mjs --check  (exit 1 if the policy is stale)
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('../docs/index.html', import.meta.url));

export function expectedPolicy(html) {
  // The page has one <style> in <head> and one <script> in <body>. The script
  // itself contains a <style> for exported files, so only <head> is searched
  // for the style.
  const hash = (text) => 'sha256-' + createHash('sha256').update(text, 'utf8').digest('base64');
  const head = html.slice(0, html.indexOf('</head>'));
  const styles = [...head.matchAll(/<style>([\s\S]*?)<\/style>/g)];
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (styles.length !== 1 || scripts.length !== 1 || /<script[\s>]/.test(head)) {
    throw new Error(`expected one <style> in <head> and one <script>, found ${styles.length} and ${scripts.length}`);
  }
  const script = hash(scripts[0][1]);
  const style = hash(styles[0][1]);
  return [
    "default-src 'none'",
    `script-src '${script}'`,
    `style-src '${style}'`,
    "connect-src 'none'",
    "img-src 'none'",
    "font-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "form-action 'none'",
    "base-uri 'none'"
  ].join('; ');
}

const META = /(<meta http-equiv="Content-Security-Policy" content=")([^"]*)(">)/;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const html = readFileSync(file, 'utf8');
  const m = html.match(META);
  if (!m) throw new Error('CSP meta tag not found');
  const want = expectedPolicy(html);
  if (process.argv.includes('--check')) {
    if (m[2] !== want) { console.error('CSP is stale. Run: node tools/update-csp.mjs'); process.exit(1); }
    console.log('CSP hashes match.');
  } else {
    writeFileSync(file, html.replace(META, `$1${want}$3`));
    console.log('CSP updated.');
  }
}
