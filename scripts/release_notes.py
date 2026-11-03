#!/usr/bin/env python3
"""GitHub release text from docs/CHANGELOG.md.

The changelog entry for a version is what the in-app "What's new" dialog
shows; this turns the same entry into the GitHub release page, so the two
never drift apart. `[Read more](manual:<Chapter> > <Section>)` links (an
app-only scheme) become links to that section of docs/MANUAL.md on GitHub,
pinned to the release tag.

    python scripts/release_notes.py 1.1.0                # print the text
    python scripts/release_notes.py 1.1.0 --apply        # update the GitHub release
    python scripts/release_notes.py 1.1.0 --intro "One-line summary of the release."

Anchors are computed offline with GitHub's heading-slug rules (lowercase,
punctuation dropped, spaces → hyphens, repeated headings numbered -1, -2 …
in document order). Exits non-zero if a manual link doesn't match a
heading, so a broken link never reaches the release page.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHANGELOG = ROOT / "docs" / "CHANGELOG.md"
MANUAL = ROOT / "docs" / "MANUAL.md"
REPO = "EpilepsyCenter/tracer"


# ---------------------------------------------------------------------------
# Manual headings and GitHub anchors
# ---------------------------------------------------------------------------

def _plain(text: str) -> str:
    """Heading text as GitHub renders it: inline markdown removed."""
    text = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", text)   # links / images → label
    # Code spans keep their text verbatim (underscores included); outside
    # them, only emphasis markers go.
    parts = re.split(r"(`[^`]*`)", text)
    out = []
    for p in parts:
        if p.startswith("`") and p.endswith("`") and len(p) >= 2:
            out.append(p[1:-1])
        else:
            p = re.sub(r"(?<!\w)_+|_+(?!\w)", "", p)      # _emphasis_, not snake_case
            out.append(re.sub(r"[*~]", "", p))
    return "".join(out).strip()


def github_slug(text: str) -> str:
    """GitHub's heading slug (github-slugger): lowercase, drop everything
    that isn't a letter, digit, space, hyphen or underscore, spaces → '-'."""
    t = text.lower()
    t = "".join(ch for ch in t if ch.isalnum() or ch in " -_")
    return t.replace(" ", "-")


def manual_headings(md: str) -> list[tuple[int, str, str]]:
    """(level, text, anchor) for every ATX heading outside code fences,
    numbering repeats the way GitHub does."""
    out: list[tuple[int, str, str]] = []
    seen: dict[str, int] = {}
    fence = False
    for line in md.splitlines():
        if line.startswith("```"):
            fence = not fence
            continue
        if fence:
            continue
        m = re.match(r"^(#{1,6})\s+(.+?)\s*#*\s*$", line)
        if not m:
            continue
        text = _plain(m.group(2))
        base = github_slug(text)
        slug = base
        if slug in seen:
            while True:
                seen[base] += 1
                slug = f"{base}-{seen[base]}"
                if slug not in seen:
                    break
        seen[slug] = 0
        out.append((len(m.group(1)), text, slug))
    return out


def resolve(headings: list[tuple[int, str, str]], path: str) -> str | None:
    """Anchor for `Chapter > Section`: each part is searched after the
    previous one (same rule as the in-app manual links)."""
    norm = lambda s: re.sub(r"\s+", " ", s.lower()).strip()  # noqa: E731
    parts = [norm(p) for p in path.split(">") if p.strip()]
    start, found = 0, None
    for part in parts:
        hit = next((i for i in range(start, len(headings)) if norm(headings[i][1]) == part), None)
        if hit is None:
            return None
        found, start = headings[hit][2], hit + 1
    return found


# ---------------------------------------------------------------------------
# Changelog
# ---------------------------------------------------------------------------

def changelog_entries(md: str) -> list[tuple[str, str]]:
    """(version, body) newest first."""
    md = re.sub(r"<!--.*?-->", "", md, flags=re.S)
    marks = list(re.finditer(r"^##\s+v?(\d+\.\d+\.\d+)\s*$", md, flags=re.M))
    out = []
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(md)
        out.append((m.group(1), md[m.end():end].strip()))
    return out


def previous_tag(version: str) -> str | None:
    """The newest v-tag older than this version, for the compare link."""
    try:
        tags = subprocess.run(["git", "tag", "--list", "v*", "--sort=-v:refname"], cwd=ROOT,
                              capture_output=True, text=True, check=True).stdout.split()
    except Exception:
        return None
    key = lambda v: tuple(int(x) for x in v.lstrip("v").split("."))  # noqa: E731
    older = [t for t in tags if re.fullmatch(r"v\d+\.\d+\.\d+", t) and key(t) < key(version)]
    return older[0] if older else None


def release_notes(version: str, intro: str | None = None) -> tuple[str, list[str]]:
    """Release text for ``version`` and the list of unresolved manual links."""
    entries = dict(changelog_entries(CHANGELOG.read_text(encoding="utf-8")))
    if version not in entries:
        raise SystemExit(f"No '## {version}' entry in docs/CHANGELOG.md")
    headings = manual_headings(MANUAL.read_text(encoding="utf-8"))
    base = f"https://github.com/{REPO}/blob/v{version}/docs/MANUAL.md"
    bad: list[str] = []

    def link(m: re.Match) -> str:
        anchor = resolve(headings, m.group(2))
        if anchor is None:
            bad.append(m.group(2))
            return ""
        return f"[{m.group(1)}]({base}#{anchor})"

    body = re.sub(r"\[([^\]]+)\]\(manual:(.+?)\)[ \t]*$", link, entries[version], flags=re.M)
    parts = []
    if intro:
        parts.append(intro.strip())
    parts.append(
        "**Updating:** use **Check for Updates…** in TRACER (it also checks once a day), or "
        "download the installer for your system below. The first time "
        f"{version} starts, a *What's new* window shows these notes, with links into the manual."
    )
    parts.append(body)
    prev = previous_tag(version)
    if prev:
        parts.append(f"**Full changelog:** https://github.com/{REPO}/compare/{prev}...v{version}")
    return "\n\n".join(parts) + "\n", bad


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("version", help="e.g. 1.1.0 (must have a '## 1.1.0' changelog entry)")
    ap.add_argument("--intro", help="optional one-line summary shown first")
    ap.add_argument("--apply", action="store_true", help="update the GitHub release v<version> with gh")
    a = ap.parse_args()
    text, bad = release_notes(a.version.lstrip("v"), a.intro)
    if bad:
        print("Manual links that match no heading in docs/MANUAL.md:", file=sys.stderr)
        for b in bad:
            print(f"  - {b}", file=sys.stderr)
        return 1
    if not a.apply:
        sys.stdout.write(text)
        return 0
    subprocess.run(["gh", "release", "edit", f"v{a.version.lstrip('v')}", "--notes-file", "-"],
                   cwd=ROOT, input=text, text=True, check=True)
    print(f"Updated the v{a.version.lstrip('v')} release notes on GitHub.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
