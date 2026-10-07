const { ResourceBudget } = require("../../src/lib/utils/resource-budget.ts");
let reservation;
process.on("message", (message) => {
  if (message.cmd === "go") {
    const budget = new ResourceBudget({
      root: message.root,
      platform: "darwin",
      pid: process.pid,
      now: Date.now,
      quarantine: () => null,
      latch: () => {},
      sample: () => ({
        at: Date.now(),
        completedAt: Date.now(),
        platform: "darwin",
        aggregateFootprintMb: 200,
        physicalFreeMb: 4096,
        swapUsedMb: 0,
        memoryPressure: "normal",
        kernelPressure: "ok",
        kernelBytes: 1048576,
        incompleteReasons: [],
        processes: message.pids.map((pid) => ({
          pid,
          parentPid: process.ppid,
          groupPid: pid,
          start: "fixture",
          role: "client",
          footprintMb: 100,
        })),
      }),
    });
    try {
      reservation = budget.reserve(1200, "fixture-native-store");
      process.send({ admitted: true });
    } catch (error) {
      process.send({ admitted: false, reason: error.message });
    }
  } else if (message.cmd === "close") {
    reservation?.release();
    process.disconnect();
  }
});
process.send({ ready: true });
