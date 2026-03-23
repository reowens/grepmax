import { describe, expect, it } from "vitest";
import { extractSymbolsFromSkeleton } from "../src/lib/skeleton/symbol-extractor";

describe("extractSymbolsFromSkeleton", () => {
  it("extracts function with line number", () => {
    const skeleton = `  42│export function handleAuth(req: Request) {`;
    const symbols = extractSymbolsFromSkeleton(skeleton);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe("handleAuth");
    expect(symbols[0].line).toBe(42);
    expect(symbols[0].type).toBe("function");
    expect(symbols[0].exported).toBe(true);
  });

  it("extracts async function", () => {
    const skeleton = `  10│async function fetchData() {`;
    const symbols = extractSymbolsFromSkeleton(skeleton);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe("fetchData");
    expect(symbols[0].type).toBe("function");
    expect(symbols[0].exported).toBe(false);
  });

  it("extracts class", () => {
    const skeleton = `  22│export class VectorDB {`;
    const symbols = extractSymbolsFromSkeleton(skeleton);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe("VectorDB");
    expect(symbols[0].type).toBe("class");
    expect(symbols[0].exported).toBe(true);
  });

  it("extracts interface and type", () => {
    const skeleton = `   5│export interface SearchFilter {
  15│export type ChunkType = {`;
    const symbols = extractSymbolsFromSkeleton(skeleton);
    expect(symbols).toHaveLength(2);
    expect(symbols[0].name).toBe("SearchFilter");
    expect(symbols[0].type).toBe("interface");
    expect(symbols[1].name).toBe("ChunkType");
    expect(symbols[1].type).toBe("type");
  });

  it("skips comment lines", () => {
    const skeleton = `// This is a comment
  42│function foo() {`;
    const symbols = extractSymbolsFromSkeleton(skeleton);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe("foo");
  });

  it("skips lines without line number prefix", () => {
    const skeleton = `export function notPrefixed() {
  42│function prefixed() {`;
    const symbols = extractSymbolsFromSkeleton(skeleton);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe("prefixed");
  });

  it("returns empty array for empty skeleton", () => {
    expect(extractSymbolsFromSkeleton("")).toEqual([]);
  });

  it("strips trailing brace and comment from signature", () => {
    const skeleton = `  10│function foo() {  // :10 → bar, baz | C:5`;
    const symbols = extractSymbolsFromSkeleton(skeleton);
    expect(symbols[0].signature).toBe("function foo()");
  });

  it("extracts Python def", () => {
    const skeleton = `  30│def process_file(path):`;
    const symbols = extractSymbolsFromSkeleton(skeleton);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe("process_file");
    expect(symbols[0].type).toBe("def");
  });

  it("extracts multiple symbols from full skeleton", () => {
    const skeleton = `// src/lib/index/syncer.ts (skeleton, ~450 tokens)
   1│import * as fs from "node:fs";
  42│export async function generateSummaries(
 116│async function flushBatch(
 164│export async function initialSync(
 300│  const processFileWithRetry = async (`;
    const symbols = extractSymbolsFromSkeleton(skeleton);
    expect(symbols.length).toBeGreaterThanOrEqual(3);
    expect(symbols.map((s) => s.name)).toContain("generateSummaries");
    expect(symbols.map((s) => s.name)).toContain("flushBatch");
    expect(symbols.map((s) => s.name)).toContain("initialSync");
  });
});
