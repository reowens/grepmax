#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { runMacSmoke } = require('./runner.cjs');

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('Usage: node scripts/colbert-eval/mac-smoke.cjs --ready|--execute|--compare-onnx|--compare-paired --root /absolute/experiment-root\n--ready imports the runtime without constructing a model.\n--execute compares original17M FP32 CPU/MPS.\n--compare-onnx compares deployed ONNX-int8 CPU with original-FP32 MPS.\n--compare-paired fully warms both sessions, separates input kinds, and reverses provider order.\n');
    return;
  }
  if (args.length !== 3 || !['--ready', '--execute', '--compare-onnx', '--compare-paired'].includes(args[0]) || args[1] !== '--root') throw new Error('Expected --ready|--execute|--compare-onnx|--compare-paired --root /absolute/experiment-root');
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const result = await runMacSmoke(path.resolve(args[2]), { execute: args[0] !== '--ready', compareOnnx: args[0] === '--compare-onnx' || args[0] === '--compare-paired', paired: args[0] === '--compare-paired', signal: controller.signal });
    process.stdout.write(JSON.stringify({ ok: result.ok, code: result.code, response: result.response,
      manifestPath: result.manifestPath, evaluationRoot: result.evaluationRoot }) + '\n');
    if (!result.ok) process.exitCode = 1;
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
main(process.argv.slice(2)).catch(error => { process.stderr.write(String(error.message) + '\n'); process.exitCode = 1; });
