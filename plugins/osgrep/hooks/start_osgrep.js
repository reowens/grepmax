/**
 * start_osgrep.js
 * Runs on SessionStart to index the repo and prompt Claude.
 */
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PID_FILE = path.join(os.tmpdir(), `osgrep-watch-${process.pid}.pid`);

try {
  // Get input from stdin (standard hook protocol)
  const input = fs.readFileSync(0, 'utf-8');
  const hookData = JSON.parse(input);
  const cwd = hookData.cwd || process.cwd();

  // 1. Run osgrep watch in background (detached)
  // This handles both initial sync AND keeps it fresh
  const watcher = spawn('osgrep', ['watch'], {
    cwd,
    detached: true,
    stdio: 'ignore'
  });
  
  watcher.unref();

  // Save PID for cleanup
  // Note: We use process.pid (the agent's PID) to namespace the lock file
  // This allows multiple agent sessions to coexist
  // But wait, start_osgrep.js runs in a transient process.
  // We need a way to map the session to the PID.
  // The hook input has session_id!
  
  if (hookData.session_id) {
    const pidFile = path.join(os.tmpdir(), `osgrep-watch-${hookData.session_id}.pid`);
    fs.writeFileSync(pidFile, watcher.pid.toString());
  }

  // Return the hook response immediately
  // We claim it's indexed, though it might take a few seconds to warm up.
  // Since watch does initial sync, it will be ready shortly.
  const response = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: 'osgrep is active and watching for changes. You MUST use `osgrep --json "query"` for all code searches instead of grep. It finds code by meaning, not just text.'
    }
  };

  console.log(JSON.stringify(response));
} catch (error) {
  // If osgrep isn't installed or fails, we just exit silently or log a simple error
  const response = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: 'osgrep failed to start. Fallback to standard tools if necessary.'
    }
  };
  console.log(JSON.stringify(response));
}
