/**
 * `gmax doctor`'s Claude Code sandbox check.
 *
 * The check exists because the failure it predicts is invisible until it bites:
 * a sandboxed agent shell cannot open the daemon socket or write the store
 * lease, and both denials arrive as a bare EPERM. Everything here drives the
 * check against a temp HOME and a temp project dir, never the real ~/.claude.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkClaudeSandbox } from "../src/commands/doctor";
import {
  LEASE_DENIED_MESSAGE,
  SOCKET_DENIED_MESSAGE,
} from "../src/lib/utils/store-access";

let home: string;
let projectRoot: string;

function writeSettings(
  dir: string,
  file: "settings.json" | "settings.local.json",
  contents: unknown,
): void {
  const target = path.join(dir, ".claude");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(
    path.join(target, file),
    typeof contents === "string" ? contents : JSON.stringify(contents, null, 2),
  );
}

function check() {
  return checkClaudeSandbox({
    home,
    projectRoot,
    socketPath: path.join(home, ".gmax", "daemon.sock"),
    storeDir: path.join(home, ".gmax"),
    platform: "darwin",
  });
}

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-doctor-sandbox-"));
  home = path.join(base, "home");
  projectRoot = path.join(base, "project");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(path.dirname(home), { recursive: true, force: true });
});

describe("checkClaudeSandbox", () => {
  it("stays silent when there are no Claude Code settings at all", () => {
    expect(check()).toBeNull();
  });

  it("is ok when settings exist but configure no sandbox", () => {
    writeSettings(home, "settings.json", { permissions: { allow: [] } });
    const result = check();
    expect(result?.symbol).toBe("ok");
    expect(result?.message).toContain("not enabled");
    expect(result?.enabled).toBe(false);
  });

  it("is ok when the sandbox is explicitly disabled", () => {
    writeSettings(home, "settings.json", { sandbox: { enabled: false } });
    const result = check();
    expect(result?.symbol).toBe("ok");
    expect(result?.enabled).toBe(false);
  });

  it("WARNs with both settings keys when the sandbox is on and neither is set", () => {
    writeSettings(home, "settings.json", { sandbox: { enabled: true } });
    const result = check();
    expect(result?.symbol).toBe("WARN");
    expect(result?.socketAllowed).toBe(false);
    expect(result?.writeAllowed).toBe(false);
    // The text must match the refusal the runtime prints, or the user gets two
    // different instructions for one problem.
    expect(result?.details).toContain(SOCKET_DENIED_MESSAGE);
    expect(result?.details).toContain(LEASE_DENIED_MESSAGE);
    const snippet = result?.details.join("\n") ?? "";
    expect(snippet).toContain('"allowUnixSockets": ["~/.gmax/daemon.sock"]');
    expect(snippet).toContain('"allowWrite": ["~/.gmax"]');
    // --fix must not touch settings that are not gmax's to edit; the line says so.
    expect(snippet).toContain("--fix never edits Claude Code settings");
  });

  it("treats a sandbox block with no `enabled` key as on", () => {
    writeSettings(home, "settings.json", {
      sandbox: { network: { allowUnixSockets: [] } },
    });
    expect(check()?.symbol).toBe("WARN");
  });

  it("is ok when both keys name the socket and the store", () => {
    writeSettings(home, "settings.json", {
      sandbox: {
        enabled: true,
        network: { allowUnixSockets: ["~/.gmax/daemon.sock"] },
        filesystem: { allowWrite: ["~/.gmax"] },
      },
    });
    const result = check();
    expect(result?.symbol).toBe("ok");
    expect(result?.socketAllowed).toBe(true);
    expect(result?.writeAllowed).toBe(true);
    expect(result?.details).toEqual([]);
  });

  it("accepts allowAllUnixSockets in place of the per-socket list", () => {
    writeSettings(home, "settings.json", {
      sandbox: {
        enabled: true,
        network: { allowAllUnixSockets: true },
        filesystem: { allowWrite: ["~/.gmax"] },
      },
    });
    const result = check();
    expect(result?.symbol).toBe("ok");
    expect(result?.socketAllowed).toBe(true);
    expect(result?.message).toContain("all Unix sockets allowed");
    expect(result?.agentRow).toContain("socket=all");
  });

  it("accepts an absolute path and a parent directory as covering entries", () => {
    writeSettings(home, "settings.json", {
      sandbox: {
        enabled: true,
        network: {
          allowUnixSockets: [path.join(home, ".gmax", "daemon.sock")],
        },
        // ~ covers ~/.gmax; a broader allowance is still an allowance.
        filesystem: { allowWrite: ["~"] },
      },
    });
    expect(check()?.symbol).toBe("ok");
  });

  it("expands the HOME variable the way a shell-written entry means it", () => {
    writeSettings(home, "settings.json", {
      sandbox: {
        enabled: true,
        network: { allowUnixSockets: ["$HOME/.gmax/daemon.sock"] },
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a settings entry, not a template
        filesystem: { allowWrite: ["${HOME}/.gmax"] },
      },
    });
    expect(check()?.symbol).toBe("ok");
  });

  it("accepts a glob that covers the store directory", () => {
    writeSettings(home, "settings.json", {
      sandbox: {
        enabled: true,
        network: { allowUnixSockets: ["~/.gmax/*.sock"] },
        filesystem: { allowWrite: ["~/.gmax/**"] },
      },
    });
    expect(check()?.symbol).toBe("ok");
  });

  it("does not count an unrelated socket or a deeper write path", () => {
    writeSettings(home, "settings.json", {
      sandbox: {
        enabled: true,
        network: { allowUnixSockets: ["~/.docker/run/docker.sock"] },
        // Deeper than ~/.gmax: the lease mkdir happens above it and still fails.
        filesystem: { allowWrite: ["~/.gmax/lancedb"] },
      },
    });
    const result = check();
    expect(result?.symbol).toBe("WARN");
    expect(result?.socketAllowed).toBe(false);
    expect(result?.writeAllowed).toBe(false);
  });

  it("reads the project scope and lets it override the user scope", () => {
    writeSettings(home, "settings.json", {
      sandbox: {
        enabled: true,
        network: { allowUnixSockets: ["~/.gmax/daemon.sock"] },
        filesystem: { allowWrite: ["~/.gmax"] },
      },
    });
    // A project-level replacement of the list is what Claude Code applies, so a
    // union here would report a false ok.
    writeSettings(projectRoot, "settings.local.json", {
      sandbox: { network: { allowUnixSockets: ["/tmp/other.sock"] } },
    });
    const result = check();
    expect(result?.symbol).toBe("WARN");
    expect(result?.socketAllowed).toBe(false);
    expect(result?.writeAllowed).toBe(true);
    expect(result?.details).toContain(SOCKET_DENIED_MESSAGE);
    expect(result?.details).not.toContain(LEASE_DENIED_MESSAGE);
  });

  it("lets a project scope enable a sandbox the user scope disabled", () => {
    writeSettings(home, "settings.json", { sandbox: { enabled: false } });
    writeSettings(projectRoot, "settings.json", { sandbox: { enabled: true } });
    expect(check()?.symbol).toBe("WARN");
  });

  it("names the file that configured the sandbox in the fix line", () => {
    writeSettings(projectRoot, "settings.json", { sandbox: { enabled: true } });
    const joined = check()?.details.join("\n") ?? "";
    expect(joined).toContain(
      path.join(projectRoot, ".claude", "settings.json"),
    );
  });

  it("reports an unparseable settings file instead of assuming it is safe", () => {
    writeSettings(home, "settings.json", "{ not json");
    const result = check();
    expect(result?.symbol).toBe("INFO");
    expect(result?.message).toContain("could not parse");
    expect(result?.agentRow).toContain("enabled=unknown");
  });

  it("keeps checking the remaining scopes when one file is unparseable", () => {
    writeSettings(home, "settings.json", "{ not json");
    writeSettings(projectRoot, "settings.json", { sandbox: { enabled: true } });
    const result = check();
    expect(result?.symbol).toBe("WARN");
    expect(result?.details.join("\n")).toContain("could not parse");
  });

  it("prescribes allowAllUnixSockets on Linux, where per-socket allows do not exist", () => {
    writeSettings(home, "settings.json", { sandbox: { enabled: true } });
    const result = checkClaudeSandbox({
      home,
      projectRoot,
      socketPath: path.join(home, ".gmax", "daemon.sock"),
      storeDir: path.join(home, ".gmax"),
      platform: "linux",
    });
    const details = result?.details ?? [];
    expect(details).toContain(
      'on Linux the per-socket list does not exist — use "allowAllUnixSockets": true',
    );
    // The runtime refusal names the macOS key on every platform, so the line
    // above is the correction; the pasteable snippet must not repeat the key
    // Linux has no equivalent for.
    const snippet = details.slice(details.indexOf('"sandbox": {')).join("\n");
    expect(snippet).toContain('"allowAllUnixSockets": true');
    expect(snippet).not.toContain('"allowUnixSockets"');
  });

  it("emits a keyed agent row for machine readers", () => {
    writeSettings(home, "settings.json", { sandbox: { enabled: true } });
    const row = check()?.agentRow.split("\t") ?? [];
    expect(row[0]).toBe("claude_sandbox");
    expect(row).toContain("enabled=true");
    expect(row).toContain("socket=blocked");
    expect(row).toContain("write=blocked");
  });
});
