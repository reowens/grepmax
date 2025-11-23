/**
 * stop_osgrep.js
 * Runs on SessionEnd to clean up the background watcher.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

try {
  const input = fs.readFileSync(0, 'utf-8');
  const hookData = JSON.parse(input);
  
  if (hookData.session_id) {
    const pidFile = path.join(os.tmpdir(), `osgrep-watch-${hookData.session_id}.pid`);
    
    if (fs.existsSync(pidFile)) {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf-8'), 10);
      try {
        process.kill(pid, 'SIGTERM');
      } catch (e) {
        // Process might already be gone
      }
      fs.unlinkSync(pidFile);
    }
  }
} catch (e) {
  // Ignore cleanup errors
}

const response = {
  hookSpecificOutput: {
    hookEventName: 'SessionEnd',
    additionalContext: 'osgrep session ended.'
  }
};

console.log(JSON.stringify(response));
