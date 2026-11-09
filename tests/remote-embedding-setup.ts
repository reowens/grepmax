import { vi } from "vitest";

const { forbidden } = vi.hoisted(() => ({
  forbidden: () => {
    throw new Error(
      "Fake-only remote embedding validation forbids execution/native models",
    );
  },
}));
vi.mock("node:child_process", () => ({
  spawn: forbidden,
  spawnSync: forbidden,
  exec: forbidden,
  execSync: forbidden,
  execFile: forbidden,
  execFileSync: forbidden,
  fork: forbidden,
}));
vi.mock("onnxruntime-node", () => ({
  InferenceSession: { create: forbidden },
  Tensor: forbidden,
}));
vi.mock("@huggingface/transformers", () => ({
  AutoTokenizer: { from_pretrained: forbidden },
  env: { allowRemoteModels: false },
}));
