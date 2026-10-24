'use strict';
const fs = require('node:fs');
const path = require('node:path');

// The experiment may add/release its own reservations. Foreign reservations
// are read-only here: a mismatch refuses admission, never deletes a record.
function installIndexAdmission(budget, sharedRoot, safetyReason) {
  const directory = path.join(sharedRoot, 'resource-budget');
  if (!path.isAbsolute(sharedRoot) || !fs.statSync(directory).isDirectory()) throw new Error('Existing host resource ledger required');
  const privateQuarantine = budget.deps.quarantine;
  const hostQuarantine = () => {
    const safety = safetyReason(sharedRoot);
    if (safety !== null) return 'host safety stop: ' + safety;
    try { fs.lstatSync(path.join(sharedRoot, 'autostart-disabled')); return 'host startup is quarantined'; }
    catch (error) { if (error.code !== 'ENOENT') return 'host quarantine status unavailable'; }
    return privateQuarantine();
  };
  if (hostQuarantine() !== null) throw new Error(hostQuarantine());
  budget.deps.root = directory;
  budget.deps.quarantine = hostQuarantine;
  budget.records = snapshot => {
    const records = [];
    for (const record of budget.readRecords()) {
      const live = snapshot.processes.find(p => p.pid === record.pid);
      if (!live) {
        try { budget.deps.signal(record.groupPid ? -record.groupPid : record.pid); }
        catch (error) { if (error.code === 'ESRCH') continue; throw error; }
        throw new Error('Reservation owner missing from host snapshot; refusing without changing its record');
      }
      if (record.unverified || live.start !== record.start) throw new Error('Reservation identity differs; refusing without changing its record');
      records.push(record);
    }
    return records;
  };
  // Actual host pressure, client registration and reservation checks remain on.
  // This runs before any model is constructed.
  budget.check();
}
module.exports = { installIndexAdmission };
