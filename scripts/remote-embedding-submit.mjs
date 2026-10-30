// Fixed trusted bridge. Runs only inside the local operational guard.
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
const [input, output] = process.argv.slice(2);
const controller = new AbortController();
process.stdin.setEncoding('utf8');
process.stdin.on('data', data => { if (data.includes('cancel')) controller.abort(new Error('P3 caller cancelled')); });
process.on('SIGTERM', () => controller.abort(new Error('P3 guard stopping')));
try {
  if (!input || !output || statSync(input).size > 2*1024*1024) throw new Error('Invalid bounded sender input');
  const { request, config } = JSON.parse(readFileSync(input, 'utf8'));
  const root = resolve(config.runtimeCheckout);
  const platform = [resolve(root, '../platform'), resolve(root, '../../platform')].find(p => existsSync(join(p, 'scripts/gmax-worker.mjs')));
  if (!platform) throw new Error('Adjacent fixed Worker bridge absent');
  const { dispatchGmaxJob } = await import(pathToFileURL(join(platform, 'scripts/gmax-worker.mjs')).href);
  const reply = await dispatchGmaxJob({ task:'embed-batch', worker:config.worker, sourceRoot:root, ref:config.runtimeCommit, timeoutS:180, embedding:request }, { signal:controller.signal });
  const bytes = JSON.stringify(reply);
  if (Buffer.byteLength(bytes) > 13*1024*1024) throw new Error('Sender result exceeds bound');
  writeFileSync(output, bytes, { flag:'wx', mode:0o600 });
} catch (error) {
  // No terminal cleanup can be inferred from sender failure.
  writeFileSync(output, JSON.stringify({ terminal:false, cleanupConfirmed:false, reason:error instanceof Error ? error.message : 'sender failed' }), { flag:'wx', mode:0o600 });
} finally { process.stdin.destroy(); }
