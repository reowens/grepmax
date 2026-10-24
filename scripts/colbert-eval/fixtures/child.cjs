'use strict';
// Owned, model-free subprocesses only. Never imports Gmax, a model, or a store.
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const mode = process.argv[2] || 'echo';
if (mode === 'grandchild') {
  process.on('SIGTERM', () => {}); // Exercise the bounded SIGKILL escalation.
  fs.writeFileSync(require('node:path').join(process.env.HOME, 'descendant.pid'), String(process.pid), { mode: 0o600 });
  setInterval(() => {}, 1000);
} else {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    if (mode === 'echo') process.stdout.write(JSON.stringify({ ok: true, input: JSON.parse(input) }) + '\n');
    else if (mode === 'environment') {
      const marker = require('node:path').join(process.env.HOME, 'fixture-private-marker');
      fs.writeFileSync(marker, 'owned fixture only', { mode: 0o600 });
      process.stdout.write(JSON.stringify({ ok: true, env: process.env, cwd: process.cwd(), marker }) + '\n');
    } else if (mode === 'hang') setInterval(() => {}, 1000);
    else if (mode === 'descendants') {
      spawn(process.execPath, [__filename, 'grandchild'], { stdio: 'inherit' });
      setInterval(() => {}, 1000);
    } else if (mode === 'orphan') {
      const descendant = spawn(process.execPath, [__filename, 'grandchild'], { stdio: 'inherit' });
      descendant.unref();
      process.stdout.write('{"ok":true}\n');
      setTimeout(() => process.exit(0), 75);
    } else if (mode === 'malformed-descendant') {
      spawn(process.execPath, [__filename, 'grandchild'], { stdio: 'inherit' });
      setTimeout(() => process.stdout.write('not-json\n'), 100);
      setInterval(() => {}, 1000);
    } else if (mode === 'stdout') process.stdout.write('x'.repeat(65536));
    else if (mode === 'stderr') { process.stderr.write('x'.repeat(65536)); setInterval(() => {}, 1000); }
    else if (mode === 'two-frames') process.stdout.write('{"ok":true}\n{"ok":true}\n');
    else if (mode === 'unterminated') process.stdout.write('{"ok":true}');
    else if (mode === 'invalid-utf8') process.stdout.write(Buffer.from([0xff, 0x0a]));
    else if (mode === 'array') process.stdout.write('[]\n');
    else if (mode === 'exit') process.exit(7);
    else throw new Error('Unknown owned fixture mode');
  });
}
