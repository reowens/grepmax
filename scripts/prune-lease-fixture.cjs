const { StoreLease } = require("../src/lib/store/store-lease.ts");
(async () => {
  const [storeDir, mode] = process.argv.slice(2);
  const lease = await StoreLease[mode === "shared" ? "acquireShared" : "acquireExclusive"]({
    storeDir, timeoutMs: 5000, role: "task-owned-native-lease-fixture",
  });
  process.send({ owner: lease.owner, mode });
  setInterval(() => {}, 1000);
})().catch(error => { console.error(error); process.exit(1); });
