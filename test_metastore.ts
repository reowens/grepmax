import { MetaStore } from "./src/utils";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

async function testMetaStore() {
    const metaStore = new MetaStore();
    const metaFile = path.join(os.homedir(), ".osgrep", "meta.json");
    const tmpFile = `${metaFile}.tmp`;

    console.log("Testing MetaStore Atomic Writes...");

    // 1. Test Save
    metaStore.set("test-file", "test-hash");
    await metaStore.save();

    if (fs.existsSync(metaFile)) {
        console.log("✓ meta.json created");
    } else {
        console.error("✗ meta.json not created");
        process.exit(1);
    }

    // 2. Test Recovery
    // Corrupt meta.json
    fs.writeFileSync(metaFile, "corrupt json {");
    // Write valid tmp file
    fs.writeFileSync(tmpFile, JSON.stringify({ "recovered-file": "recovered-hash" }));

    const newStore = new MetaStore();
    await newStore.load();

    if (newStore.get("recovered-file") === "recovered-hash") {
        console.log("✓ Recovered from .tmp file");
    } else {
        console.error("✗ Failed to recover from .tmp file");
        console.log("Data:", (newStore as any).data);
        process.exit(1);
    }

    // 3. Verify meta.json is restored
    const content = fs.readFileSync(metaFile, "utf-8");
    if (content.includes("recovered-hash")) {
        console.log("✓ meta.json restored from .tmp");
    } else {
        console.error("✗ meta.json not restored");
        process.exit(1);
    }

    console.log("All tests passed!");
}

testMetaStore().catch(console.error);
