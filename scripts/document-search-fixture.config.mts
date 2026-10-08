// Explicit isolated suite: no grammar download/global setup or live host sampling.
import { defineConfig } from "vitest/config";
export default defineConfig({test:{environment:"node",setupFiles:["./tests/setup.ts"],globalSetup:[],maxWorkers:1,fileParallelism:false}});
