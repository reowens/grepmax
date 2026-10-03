import * as path from "node:path";
import type * as SDK from "@lancedb/lancedb";

// Source tests use the pinned dev dependency. Compiled consumers use the
// unchanged official runtime copied at build time, with root native packages.
const base = path.resolve(__dirname, "../..");
const sdk: typeof SDK = require(
  path.basename(base) === "src"
    ? "@lancedb/lancedb"
    : path.join(base, "vendor", "lancedb", "index.js"),
);

export const connect = sdk.connect;
export const Index = sdk.Index;
export const Session = sdk.Session;
export type Connection = SDK.Connection;
export type Table = SDK.Table;
export type Session = SDK.Session;
