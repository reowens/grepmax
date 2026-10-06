"""Audit registry packages in uv.lock through OSV without installing or loading models."""

import argparse
import json
from pathlib import Path
import sys
import time
import tomllib
import urllib.error
import urllib.request


OSV_URL = "https://api.osv.dev/v1/querybatch"
DEFAULT_LOCK = Path(__file__).resolve().parents[1] / "mlx-embed-server" / "uv.lock"


def locked_packages(lock):
    packages = []
    excluded = []
    for package in lock["package"]:
        if "registry" in package.get("source", {}):
            packages.append({"name": package["name"], "version": package["version"]})
        else:
            excluded.append(package["name"])
    if not packages:
        raise ValueError("Lockfile has no registry packages to audit")
    return packages, excluded


def query_osv(packages):
    payload = {
        "queries": [
            {"package": {"name": p["name"], "ecosystem": "PyPI"}, "version": p["version"]}
            for p in packages
        ]
    }
    request = urllib.request.Request(
        OSV_URL,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "grepmax-python-audit"},
    )
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        except (urllib.error.URLError, TimeoutError):
            if attempt == 2:
                raise
            time.sleep(attempt + 1)


def audit_results(packages, response):
    if not isinstance(response, dict):
        raise ValueError("OSV returned an invalid audit response")
    results = response.get("results")
    if not isinstance(results, list) or len(results) != len(packages):
        raise ValueError("OSV returned an incomplete audit response")
    findings = []
    for package, result in zip(packages, results):
        if not isinstance(result, dict):
            raise ValueError("OSV returned an invalid package result")
        vulnerabilities = result.get("vulns", [])
        if not isinstance(vulnerabilities, list) or any(
            not isinstance(v, dict) or not v.get("id") for v in vulnerabilities
        ):
            raise ValueError("OSV returned invalid advisory records")
        if vulnerabilities:
            findings.append({**package, "advisories": sorted({v["id"] for v in vulnerabilities})})
    return findings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lockfile", type=Path, default=DEFAULT_LOCK)
    parser.add_argument("--json", type=Path, dest="report_path")
    args = parser.parse_args()
    try:
        with args.lockfile.open("rb") as handle:
            packages, excluded = locked_packages(tomllib.load(handle))
        response = query_osv(packages)
        findings = audit_results(packages, response)
        report = {"queried": len(packages), "excluded_non_registry": excluded, "findings": findings}
        if args.report_path:
            args.report_path.write_text(json.dumps(report, indent=2) + "\n")
        for finding in findings:
            print(f"{finding['name']}@{finding['version']}: {', '.join(finding['advisories'])}")
        print(f"Python audit: {len(packages)} registry packages, {len(findings)} affected packages")
        if excluded:
            print(f"Outside the registry audit: {', '.join(excluded)} (local project / pinned Git source)")
        return 1 if findings else 0
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"Python audit could not complete: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
