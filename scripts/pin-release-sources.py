#!/usr/bin/env python3
"""Update/check release workflow pins against a freshly frozen source manifest."""
import argparse
from pathlib import Path
import re
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--sources", type=Path, required=True, help="SOURCE_COMMITS manifest")
parser.add_argument("--check", action="store_true", help="Fail rather than update stale pins")
args = parser.parse_args()
names = {"core", "server", "computer", "dashboard", "ui-kit", "app-sdk", "integrations"}
sources = dict(line.split() for line in args.sources.read_text().splitlines() if line.strip())
if not names <= sources.keys() or any(not re.fullmatch(r"[a-f0-9]{40}", sources[n]) for n in names):
    parser.error("manifest must include a full commit SHA for every sibling component")

workflow = Path(__file__).resolve().parents[1] / ".github/workflows/release.yml"
before = workflow.read_text()
counts = dict.fromkeys(names, 0)
stale = []
pattern = re.compile(r"(^[ \t]+repository: apteva/([\w-]+)\n[ \t]+ref: )([a-f0-9]{40})$", re.M)

def replace(match):
    name = match[2]
    if name not in names:
        return match[0]
    counts[name] += 1
    if match[3] != sources[name]:
        stale.append(name)
    return match[1] + sources[name]

after = pattern.sub(replace, before)
if any(count != 2 for count in counts.values()):
    parser.error(f"expected archive and Docker checkout pins for each component: {counts}")
metadata_counts = {"dashboard": 0, "integrations": 0}
metadata_pattern = re.compile(r"(https://raw\.githubusercontent\.com/apteva/(dashboard|integrations)/)(?:main|[a-f0-9]{40})(/package\.json)")

def replace_metadata(match):
    name = match[2]
    metadata_counts[name] += 1
    value = match[1] + sources[name] + match[3]
    if match[0] != value:
        stale.append(name + " metadata")
    return value

after = metadata_pattern.sub(replace_metadata, after)
if any(count != 1 for count in metadata_counts.values()):
    parser.error(f"expected a frozen version metadata URL for each UI component: {metadata_counts}")
if args.check and stale:
    print("Stale release pins: " + ", ".join(sorted(set(stale))), file=sys.stderr)
    sys.exit(1)
if not args.check and after != before:
    workflow.write_text(after)
print("Release workflow pins match the frozen component manifest")
