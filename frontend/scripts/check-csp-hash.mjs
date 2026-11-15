// Prueft nach dem Build, dass jedes Inline-<script> in dist/.../index.html
// mit seinem sha256-Hash in public/_headers (CSP script-src) steht.
// Sonst blockiert der Browser das Skript (z. B. Dark-Mode-Skript).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const html = readFileSync('dist/frontend/browser/index.html', 'utf8');
const headers = readFileSync('public/_headers', 'utf8');

const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
let failed = false;
for (const body of inline) {
  if (!body.trim()) continue;
  const hash = `sha256-${createHash('sha256').update(body).digest('base64')}`;
  if (!headers.includes(`'${hash}'`)) {
    console.error(`CSP: Hash fehlt in public/_headers: '${hash}'\n  Skript beginnt mit: ${body.trim().slice(0, 60)}...`);
    failed = true;
  }
}
if (failed) process.exit(1);
console.log(`CSP-Hashes ok (${inline.filter((b) => b.trim()).length} Inline-Skript(e)).`);
