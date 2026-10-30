// Private fixed-task entry. It has no daemon, store, filesystem-input or shell API.
import { describeRemoteEmbeddingWorker } from "./lib/workers/remote-embedding-executor";

const capability = describeRemoteEmbeddingWorker();
if (process.argv.length === 3 && process.argv[2] === "describe") {
  process.stdout.write(JSON.stringify(capability) + "\n");
} else {
  // No model/native import or input-file read until a trusted adapter exists.
  process.stderr.write(JSON.stringify({ ...capability, state: "refused" }) + "\n");
  process.exitCode = 75;
}
