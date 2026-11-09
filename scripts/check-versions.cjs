#!/usr/bin/env node
// gmax ships every dependency at its latest release. This check refuses while
// any npm, Rust or Python dependency is behind, printing 1 line per lagging
// package, and refuses with 1 line when a registry cannot be read.
//
// npm: the version pnpm-lock.yaml resolves for each direct dependency, against
// the newest stable release past pnpm's minimumReleaseAge. onnxruntime-node is
// held to the exact version the latest @huggingface/transformers depends on.
// Rust: the Cargo.lock version of each Cargo.toml dependency, against crates.io's
// newest stable; lance, lance-io, lance-table and lance-index must also equal the
// Lance version the locked @lancedb/lancedb embeds, and every engine string must
// name it. Python: every package in each tracked uv.lock, against PyPI's newest
// release; a package locked at 2 or more versions is accepted only when each
// older entry is the newest release its Python floor can install.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const USER_AGENT = "grepmax-version-check (https://github.com/reowens/grepmax)";
// pnpm 11 and later hold releases younger than 1 day unless minimumReleaseAge says otherwise.
const PNPM_DEFAULT_RELEASE_AGE_MINUTES = 1440;
const CRATES_IO_INTERVAL_MS = 1000;
const LANCE_CRATES = ["lance", "lance-io", "lance-table", "lance-index"];
const NATIVE_DIR = "lance-maintenance/native";
// Files that name the Lance engine; every match must equal the Lance crate version.
const ENGINE_STRINGS = [
  ["scripts/prepare-bounded-runtime.cjs", /manifest\.engine !== "([^"]+)"/g],
  ["scripts/assemble-bounded-runtime.cjs", /engine(?:: | !== )"([^"]+)"/g],
  ["lance-maintenance/native/src/main.rs", /"engine":"([^"]+)"/g],
  ["lance-maintenance/native/src/engine.rs", /"engine":"([^"]+)"/g],
  ["lance-maintenance/pyproject.toml", /"pylance==([^"]+)"/g],
  ["lance-maintenance/maintain.py", /^ENGINE = "([^"]+)"/gm],
  ["lance-maintenance/prune.py", /"pylance"\) != "([^"]+)"|"engine": "([^"]+)"/g],
  ["lance-maintenance/fts.py", /"pylance"\) != "([^"]+)"|"engine": "([^"]+)"/g],
  ["scripts/compact-recovery.py", /'pylance'\) != '([^']+)'/g],
];

class CheckError extends Error {}

function couldNot(what, reason) {
  return new CheckError(`Could not check ${what}: ${reason}`);
}

// ---- version ordering ----

function parseSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  return match ? { release: match.slice(1, 4).map(Number), pre: match[4] } : null;
}

function compareTuples(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff) return Math.sign(diff);
  }
  return 0;
}

// Stable semver only; prereleases never count as latest.
function compareStableSemver(a, b) {
  return compareTuples(parseSemver(a).release, parseSemver(b).release);
}

// PEP 440 subset. Anything that does not parse is not a final release, so it
// can never be the latest and is skipped rather than ordered.
function parsePep440(version) {
  const match = /^v?(\d+(?:\.\d+)*)(?:[-_.]?(a|alpha|b|beta|c|rc|pre|preview)[-_.]?(\d*))?(?:(?:[-_.]?(?:post|rev|r)[-_.]?(\d*))|-(\d+))?(?:[-_.]?dev[-_.]?(\d*))?$/i.exec(version.trim());
  if (!match) return null;
  return { release: match[1].split(".").map(Number), pre: Boolean(match[2]), post: Number(match[4] ?? match[5] ?? -1), dev: match[6] !== undefined };
}

function comparePep440(a, b) {
  const left = parsePep440(a), right = parsePep440(b);
  return compareTuples(left.release, right.release) || Math.sign(left.post - right.post);
}

function isFinalPep440(version) {
  const parsed = parsePep440(version);
  return Boolean(parsed) && !parsed.pre && !parsed.dev;
}

// Does a requires-python specifier set admit Python `floor` (e.g. "3.10")?
function admitsPython(specifiers, floor) {
  if (!specifiers) return true;
  const python = floor.split(".").map(Number);
  return specifiers.split(",").map(part => part.trim()).filter(Boolean).every(clause => {
    const match = /^(~=|===|==|!=|<=|>=|<|>)\s*([0-9][0-9.]*)(\.\*)?$/.exec(clause);
    if (!match) throw new CheckError(`Could not read requires-python clause '${clause}'`);
    const [, operator, raw, wildcard] = match;
    const version = raw.split(".").map(Number);
    if (wildcard) {
      const prefix = python.slice(0, version.length);
      const equal = compareTuples(prefix, version) === 0;
      if (operator === "==") return equal;
      if (operator === "!=") return !equal;
      throw new CheckError(`Could not read requires-python clause '${clause}'`);
    }
    const order = compareTuples(python, version);
    switch (operator) {
      case "==": case "===": return order === 0;
      case "!=": return order !== 0;
      case "<": return order < 0;
      case "<=": return order <= 0;
      case ">": return order > 0;
      case ">=": return order >= 0;
      case "~=": return order >= 0 && compareTuples(python.slice(0, version.length - 1), version.slice(0, -1)) === 0;
    }
    return false;
  });
}

// ---- file readers ----

function unquote(text) {
  return text.trim().replace(/^(['"])(.*)\1$/, "$2");
}

// pnpm-workspace.yaml: minimumReleaseAge and minimumReleaseAgeExclude.
function readWorkspace(text) {
  let ageMinutes = PNPM_DEFAULT_RELEASE_AGE_MINUTES;
  const exclude = [];
  let inExclude = false;
  for (const line of text.split("\n")) {
    const content = line.replace(/\s+#.*$/, "").replace(/^#.*$/, "");
    if (!content.trim()) continue;
    const age = /^minimumReleaseAge:\s*(\S+)/.exec(content);
    if (age) {
      ageMinutes = Number(unquote(age[1]));
      if (!Number.isFinite(ageMinutes)) throw new CheckError(`Could not read pnpm-workspace.yaml minimumReleaseAge '${age[1]}'`);
    }
    if (/^\S/.test(content)) inExclude = /^minimumReleaseAgeExclude:\s*$/.test(content);
    else if (inExclude) {
      const item = /^\s+-\s+(.+)$/.exec(content);
      if (item) exclude.push(unquote(item[1]));
    }
  }
  return { ageMinutes, exclude: exclude.map(parseExclude) };
}

// pnpm accepts a name, a name glob, or name@exact versions joined by ||.
function parseExclude(entry) {
  const at = entry.lastIndexOf("@");
  const name = at > 0 ? entry.slice(0, at) : entry;
  const versions = at > 0 ? entry.slice(at + 1).split("||").map(part => part.trim()) : null;
  if (versions?.some(version => !parseSemver(version))) {
    throw new CheckError(`Could not read minimumReleaseAgeExclude entry '${entry}': only exact versions are understood`);
  }
  const pattern = new RegExp(`^${name.split("*").map(part => part.replace(/[.+?^${}()|[\]\\/]/g, "\\$&")).join(".*")}$`);
  return { pattern, versions };
}

function isExcluded(exclude, name, version) {
  return exclude.some(entry => entry.pattern.test(name) && (!entry.versions || entry.versions.includes(version)));
}

// importers['.'] of pnpm-lock.yaml: each direct dependency's resolved version.
function readPnpmLock(text) {
  const lines = text.split("\n");
  const start = lines.findIndex(line => line === "importers:");
  if (start < 0) throw new CheckError("Could not read pnpm-lock.yaml: no importers section");
  const entries = new Map();
  let inRoot = false, section = null, name = null;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    if (/^ {2}\S/.test(line)) { inRoot = line.trim() === ".:"; section = null; continue; }
    if (!inRoot) continue;
    const sectionMatch = /^ {4}(dependencies|devDependencies|optionalDependencies):$/.exec(line);
    if (sectionMatch) { section = sectionMatch[1]; continue; }
    const nameMatch = /^ {6}(\S.*):$/.exec(line);
    if (nameMatch && section) { name = unquote(nameMatch[1]); entries.set(name, { name, section }); continue; }
    const field = /^ {8}(specifier|version):\s*(.+)$/.exec(line);
    if (field && name) entries.get(name)[field[1]] = unquote(field[2]);
  }
  for (const entry of entries.values()) {
    const resolved = (entry.version ?? "").replace(/\(.*$/, "");
    const alias = /^(@?[^@]+)@(.+)$/.exec(resolved);
    entry.package = alias ? alias[1] : entry.name;
    entry.version = alias ? alias[2] : resolved;
  }
  return entries;
}

function tomlSections(text) {
  const sections = new Map();
  let current = "";
  for (const line of text.split("\n")) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) { current = header[1].trim(); if (!sections.has(current)) sections.set(current, []); continue; }
    if (!sections.has(current)) sections.set(current, []);
    sections.get(current).push(line);
  }
  return sections;
}

// Cargo.toml [dependencies] and [dev-dependencies]: name and requirement.
function readCargoManifest(text) {
  const dependencies = [];
  for (const [section, lines] of tomlSections(text)) {
    if (section !== "dependencies" && section !== "dev-dependencies") continue;
    for (const line of lines) {
      const match = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line.trim());
      if (!match) continue;
      const requirement = match[2].startsWith("{") ? /version\s*=\s*"([^"]+)"/.exec(match[2])?.[1] : unquote(match[2]);
      if (!requirement) throw new CheckError(`Could not read the version of ${match[1]} in Cargo.toml`);
      dependencies.push({ name: match[1], requirement });
    }
  }
  return dependencies;
}

// Cargo.lock: packages and the root package's dependency list.
function readCargoLock(text, rootName) {
  const packages = text.split(/^\[\[package\]\]$/m).slice(1).map(block => ({
    name: /^name = "([^"]+)"/m.exec(block)?.[1],
    version: /^version = "([^"]+)"/m.exec(block)?.[1],
    dependencies: [...(/^dependencies = \[([\s\S]*?)^\]/m.exec(block)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(match => match[1]),
  }));
  const root = packages.find(entry => entry.name === rootName);
  if (!root) throw new CheckError(`Could not read Cargo.lock: no ${rootName} package`);
  return name => {
    const listed = root.dependencies.find(entry => entry === name || entry.startsWith(`${name} `));
    if (!listed) return null;
    const version = listed.split(" ")[1];
    if (version) return version;
    const matches = packages.filter(entry => entry.name === name);
    return matches.length === 1 ? matches[0].version : null;
  };
}

// uv.lock: requires-python and every package with its source and markers.
function readUvLock(text, lockPath) {
  const floor = /^requires-python = "(?:>=|==)\s*(\d+(?:\.\d+)*)(?:\.\*)?\s*[",]/m.exec(text)?.[1];
  if (!floor) throw new CheckError(`Could not read the Python floor in ${lockPath}`);
  const packages = text.split(/^\[\[package\]\]$/m).slice(1).map(block => {
    const head = block.split(/^(?:dependencies|sdist|wheels|\[package\.)/m)[0];
    return {
      name: /^name = "([^"]+)"/m.exec(head)?.[1],
      version: /^version = "([^"]+)"/m.exec(head)?.[1],
      source: /^source = \{ (\w[\w-]*) = "([^"]*)"/m.exec(head)?.slice(1, 3) ?? [],
      markers: [...(/^resolution-markers = \[([\s\S]*?)^\]/m.exec(head)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(match => match[1]),
    };
  });
  return { floor, packages };
}

// The lowest Python a set of resolution markers admits, or null when any
// marker names something other than python_full_version.
function markerFloor(markers, projectFloor) {
  let lowest = null;
  for (const marker of markers) {
    let markerLowest = projectFloor;
    for (const clause of marker.split(/\s+and\s+/)) {
      const match = /^python_full_version\s*(>=|==|<|<=|>|!=)\s*'([0-9.]+)(\.\*)?'$/.exec(clause.trim());
      if (!match) return null;
      if (match[1] === ">=" || match[1] === "==") {
        if (compareTuples(match[2].split(".").map(Number), markerLowest.split(".").map(Number)) > 0) markerLowest = match[2];
      }
    }
    if (!lowest || compareTuples(markerLowest.split(".").map(Number), lowest.split(".").map(Number)) < 0) lowest = markerLowest;
  }
  return lowest ?? projectFloor;
}

// ---- registries ----

async function fetchJsonFromNetwork(url) {
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function gitHeadFromNetwork(remote) {
  const result = spawnSync("git", ["ls-remote", remote, "HEAD"], { encoding: "utf8", timeout: 60_000 });
  const sha = /^([0-9a-f]{40})\tHEAD$/m.exec(result.stdout ?? "")?.[1];
  if (result.status !== 0 || !sha) throw new Error((result.stderr || result.error?.message || `git exit ${result.status}`).trim().split("\n").pop());
  return sha;
}

async function lookup(what, fetchJson, url) {
  try {
    return await fetchJson(url);
  } catch (error) {
    throw couldNot(what, error.message || String(error));
  }
}

// Newest stable npm version, up to dist-tags.latest, published at least the
// release age before `now` unless minimumReleaseAgeExclude lets it through.
function npmLatest(name, packument, { now, ageMinutes, exclude }) {
  const tagged = packument?.["dist-tags"]?.latest;
  if (!tagged || !parseSemver(tagged) || !packument.versions || !packument.time) throw couldNot(`npm ${name}`, "the registry entry has no latest release");
  const cutoff = now - ageMinutes * 60_000;
  const eligible = Object.keys(packument.versions).filter(version => {
    const parsed = parseSemver(version);
    if (!parsed || parsed.pre || compareStableSemver(version, tagged) > 0) return false;
    if (isExcluded(exclude, name, version)) return true;
    const published = Date.parse(packument.time[version]);
    return Number.isFinite(published) && published <= cutoff;
  });
  if (!eligible.length) throw couldNot(`npm ${name}`, `no stable release is older than ${ageMinutes} minutes`);
  return eligible.sort(compareStableSemver).pop();
}

// PyPI final releases with at least 1 unyanked file, newest first.
function pypiReleases(name, document) {
  if (!document?.releases) throw couldNot(`PyPI ${name}`, "the registry entry has no releases");
  const releases = [];
  for (const [version, files] of Object.entries(document.releases)) {
    const live = files.filter(file => !file.yanked);
    if (!live.length || !isFinalPep440(version)) continue;
    releases.push({ version, requiresPython: live.find(file => file.requires_python)?.requires_python ?? null });
  }
  if (!releases.length) throw couldNot(`PyPI ${name}`, "no final release is published");
  return releases.sort((a, b) => comparePep440(b.version, a.version));
}

// ---- the checks ----

async function checkNpm(root, { fetchJson, now }) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const workspace = readWorkspace(fs.readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8"));
  const lock = readPnpmLock(fs.readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8"));
  const names = ["dependencies", "devDependencies", "optionalDependencies"].flatMap(section => Object.keys(manifest[section] ?? {}));
  const lines = [];
  const missing = names.filter(name => !lock.get(name)?.version);
  for (const name of missing) lines.push(`npm ${name} is in package.json but has no version in pnpm-lock.yaml`);
  const entries = names.filter(name => !missing.includes(name)).map(name => lock.get(name));
  const packuments = new Map();
  const packument = async name => {
    if (!packuments.has(name)) packuments.set(name, lookup(`npm ${name}`, fetchJson, `https://registry.npmjs.org/${name.replace("/", "%2F")}`));
    return packuments.get(name);
  };
  const policy = { now, ageMinutes: workspace.ageMinutes, exclude: workspace.exclude };
  const results = await Promise.all(entries.map(async entry => {
    if (entry.package === "onnxruntime-node") {
      const transformers = await packument("@huggingface/transformers");
      const version = npmLatest("@huggingface/transformers", transformers, policy);
      const held = transformers.versions[version]?.dependencies?.["onnxruntime-node"];
      if (!held || !parseSemver(held)) throw couldNot("npm onnxruntime-node", `@huggingface/transformers ${version} depends on '${held ?? "nothing"}', not an exact version`);
      return held === entry.version ? null : `npm onnxruntime-node ${entry.version}, held to ${held} by @huggingface/transformers ${version}`;
    }
    const latest = npmLatest(entry.package, await packument(entry.package), policy);
    if (latest === entry.version) return null;
    const label = entry.package === entry.name ? entry.name : `${entry.name} (${entry.package})`;
    return `npm ${label} ${entry.version}, latest ${latest}`;
  }));
  lines.push(...results.filter(Boolean));
  return { checked: names.length, lines, lancedb: lock.get("@lancedb/lancedb")?.version };
}

async function checkRust(root, { fetchJson, delay, lancedbVersion }) {
  const native = path.join(root, NATIVE_DIR);
  const dependencies = readCargoManifest(fs.readFileSync(path.join(native, "Cargo.toml"), "utf8"));
  const rootName = /^name = "([^"]+)"/m.exec(fs.readFileSync(path.join(native, "Cargo.toml"), "utf8"))[1];
  const locked = readCargoLock(fs.readFileSync(path.join(native, "Cargo.lock"), "utf8"), rootName);
  const lines = [];
  let first = true;
  const crates = async url => {
    if (!first) await delay(CRATES_IO_INTERVAL_MS);
    first = false;
    return lookup(url.what, fetchJson, url.href);
  };
  if (!lancedbVersion) throw couldNot("the Lance version LanceDB embeds", "pnpm-lock.yaml does not lock @lancedb/lancedb");
  const lancedb = await crates({ what: `crates.io lancedb ${lancedbVersion}`, href: `https://crates.io/api/v1/crates/lancedb/${lancedbVersion}/dependencies` });
  const lanceRequirement = lancedb?.dependencies?.find(dependency => dependency.crate_id === "lance" && dependency.kind === "normal")?.req;
  const embedded = /^=\s*(\d+\.\d+\.\d+)$/.exec(lanceRequirement ?? "")?.[1];
  if (!embedded) throw couldNot(`the Lance version LanceDB ${lancedbVersion} embeds`, `its lance requirement is '${lanceRequirement ?? "absent"}', not an exact version`);
  for (const { name, requirement } of dependencies) {
    const current = locked(name);
    if (!current) { lines.push(`cargo ${name} ${requirement} has no version in Cargo.lock`); continue; }
    const document = await crates({ what: `crates.io ${name}`, href: `https://crates.io/api/v1/crates/${name}` });
    const latest = document?.crate?.max_stable_version;
    if (!latest) throw couldNot(`crates.io ${name}`, "the registry reports no stable release");
    if (current !== latest) lines.push(`cargo ${name} ${current}, latest ${latest}`);
    if (LANCE_CRATES.includes(name) && current !== embedded) lines.push(`cargo ${name} ${current}, LanceDB ${lancedbVersion} embeds Lance ${embedded}`);
  }
  const lanceVersion = locked("lance");
  for (const [file, pattern] of ENGINE_STRINGS) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    const named = [...text.matchAll(pattern)].map(match => match.slice(1).find(Boolean));
    if (!named.length) lines.push(`engine ${file} no longer names the Lance engine in the form this check reads`);
    for (const version of new Set(named)) {
      if (version !== lanceVersion) lines.push(`engine ${file} names ${version}, Lance crate ${lanceVersion}`);
    }
  }
  return { checked: dependencies.length, lines };
}

async function checkPython(root, { fetchJson, gitHead, uvLocks }) {
  const lines = [];
  let checked = 0;
  const documents = new Map();
  const releases = name => {
    if (!documents.has(name)) documents.set(name, lookup(`PyPI ${name}`, fetchJson, `https://pypi.org/pypi/${name}/json`).then(document => pypiReleases(name, document)));
    return documents.get(name);
  };
  for (const lockPath of uvLocks) {
    const { floor, packages } = readUvLock(fs.readFileSync(path.join(root, lockPath), "utf8"), lockPath);
    const groups = new Map();
    for (const entry of packages) {
      const [kind, location] = entry.source;
      if (kind === "virtual" || kind === "editable") continue;
      checked++;
      if (kind === "git") {
        const [remote, commit] = [location.split("?")[0], location.split("#")[1]];
        let head;
        try { head = gitHead(remote); } catch (error) { throw couldNot(`${lockPath} ${entry.name} at ${remote}`, error.message); }
        if (head !== commit) lines.push(`pypi ${lockPath} ${entry.name} git ${commit.slice(0, 12)}, upstream HEAD ${head.slice(0, 12)}`);
        continue;
      }
      if (kind !== "registry") { lines.push(`pypi ${lockPath} ${entry.name} comes from a ${kind || "unknown"} source this check cannot read`); continue; }
      if (!groups.has(entry.name)) groups.set(entry.name, []);
      groups.get(entry.name).push(entry);
    }
    await Promise.all([...groups.values()].map(entries => releases(entries[0].name)));
    for (const [name, entries] of groups) {
      const published = await releases(name);
      const latest = published[0].version;
      entries.sort((a, b) => comparePep440(a.version, b.version));
      for (const [index, entry] of entries.entries()) {
        const top = index === entries.length - 1;
        if (top) {
          if (comparePep440(entry.version, latest) !== 0) lines.push(`pypi ${lockPath} ${name} ${entry.version}, latest ${latest}`);
          continue;
        }
        const entryFloor = markerFloor(entry.markers, floor);
        if (!entryFloor) { lines.push(`pypi ${lockPath} ${name} ${entry.version} is split on a marker other than the Python version`); continue; }
        const newest = published.find(release => admitsPython(release.requiresPython, entryFloor));
        if (!newest || comparePep440(entry.version, newest.version) !== 0) {
          lines.push(`pypi ${lockPath} ${name} ${entry.version} for Python ${entryFloor}, latest for that Python ${newest?.version ?? "none"}`);
        }
      }
    }
  }
  return { checked, lines };
}

function trackedUvLocks(root) {
  const result = spawnSync("git", ["-C", root, "ls-files", "--", "uv.lock", "**/uv.lock"], { encoding: "utf8" });
  if (result.status !== 0) throw new CheckError(`Could not list the tracked uv.lock files: ${(result.stderr || `git exit ${result.status}`).trim()}`);
  return result.stdout.split("\n").filter(Boolean).sort();
}

async function checkVersions({
  root = path.resolve(__dirname, ".."),
  fetchJson = fetchJsonFromNetwork,
  gitHead = gitHeadFromNetwork,
  now = Date.now(),
  delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
  uvLocks = trackedUvLocks(root),
} = {}) {
  const npm = await checkNpm(root, { fetchJson, now });
  const [rust, python] = await Promise.all([
    checkRust(root, { fetchJson, delay, lancedbVersion: npm.lancedb }),
    checkPython(root, { fetchJson, gitHead, uvLocks }),
  ]);
  return { lines: [...npm.lines, ...rust.lines, ...python.lines], counts: { npm: npm.checked, rust: rust.checked, python: python.checked } };
}

async function main(argv, { print = console.log, printError = console.error, ...options } = {}) {
  if (argv.length) { printError("Usage: node scripts/check-versions.cjs"); return 2; }
  try {
    const { lines, counts } = await checkVersions(options);
    for (const line of lines) print(line);
    if (lines.length) return 1;
    print(`Every dependency is at its latest release: ${counts.npm} npm, ${counts.rust} Rust, ${counts.python} Python`);
    return 0;
  } catch (error) {
    printError(error instanceof CheckError ? error.message : `Could not check dependency versions: ${error.message}`);
    return 1;
  }
}

module.exports = { checkVersions, main, readWorkspace, readPnpmLock, readCargoManifest, readCargoLock, readUvLock, markerFloor,
  admitsPython, npmLatest, pypiReleases, parsePep440, CheckError, PNPM_DEFAULT_RELEASE_AGE_MINUTES };
if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
