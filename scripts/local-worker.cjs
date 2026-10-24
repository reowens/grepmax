#!/usr/bin/env node
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

function localWorkerCommand(args, { root = path.resolve(__dirname, '..'), platformRoot } = {}) {
  if (!['describe', 'run', 'prepare'].includes(args[0])) throw new Error('Use describe, prepare --worker <name>, or run --task <task> --worker <name>');
  if (args.includes('--source-root')) throw new Error('Gmax source root is fixed by this repository entry');
  platformRoot ??= [path.resolve(root, '../platform'), path.resolve(root, '../../platform')]
    .find(candidate => fs.existsSync(path.join(candidate, 'scripts/gmax-worker.mjs')));
  if (!platformRoot) throw new Error('The adjacent local platform worker integration is unavailable');
  const runner = path.join(platformRoot, 'scripts/gmax-worker.mjs');
  if (!fs.existsSync(runner)) throw new Error('The local platform worker integration is unavailable');
  return [process.execPath, runner, ...args, '--source-root', root];
}

module.exports = { localWorkerCommand };
if (require.main === module) {
  try {
    const [command, ...args] = localWorkerCommand(process.argv.slice(2));
    const result = spawnSync(command, args, { stdio: 'inherit', shell: false });
    process.exitCode = result.status ?? 75;
  } catch (error) { console.error(error.message); process.exitCode = 75; }
}
