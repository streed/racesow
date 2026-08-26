#!/usr/bin/env python3
"""
mapfix -- find and repair imported race maps that the Warsow/Warfork engine
quietly refuses to run properly.

THE PROBLEM. Almost every map in the pool was built for Quake 3 / defrag and
imported as-is. Most of it just works, because the racemod supplies the missing
entity spawn functions. What does not work fails SILENTLY: the engine frees a
brush entity that has no brush, walks a player through a teleport whose
destination does not resolve, or refuses a walljump because a compile artifact
set SURF_NOWALLJUMP on every surface in the map. Nothing is printed, nothing
crashes, and the map simply plays wrong until somebody notices and says so in
chat.

WHAT IT DOES.

    mapfix.py scan server/maps/'*.pk3'
    mapfix.py fix  server/maps/kairos-jackson.pk3 --out /tmp/fixed

`scan` reports; `fix` writes repaired .pk3 files. A fix only ever rewrites the
entity lump and the surface-flags word of the shaderref lump -- every other byte
of every BSP, and every other file in the .pk3, is copied through unchanged and
then verified byte-for-byte before the output is written.

The walljump repair is the one with the most leverage: it is exactly the edit
behind the 577 hand-made "-wjfix" maps already in the pool, so it can be applied
to the ones nobody got round to.

Exit status: 0 clean, 1 something at "broken" severity was found (scan) or a
repair failed verification (fix), 2 usage/IO error.
"""
import argparse
import glob as globmod
import json
import os
import shutil
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from bsp import Bsp, BspError, LUMP_ENTITIES, LUMP_SHADERREFS   # noqa: E402
from checks import BROKEN, WARN, INFO, entity_findings, walljump_findings  # noqa: E402
from entities import EntityLump                                  # noqa: E402
from repairs import (ALL_REPAIRS, DEFAULT_REPAIRS, apply_entity_repairs,   # noqa: E402
                     apply_walljump)

SEVERITY_ORDER = {BROKEN: 0, WARN: 1, INFO: 2}

# The suffix a repaired map carries, so that what was done to it is visible in
# the filename. This follows the pool's own convention -- 577 maps are already
# named "-wjfix" for exactly the walljump repair below -- and extends it to the
# other repair families. Tokens are emitted in this order so the same set of
# repairs always produces the same name.
SUFFIX_TOKENS = (
    ("walljump", "wjfix"),
    ("reattach-orphan-model", "trigfix"),
    ("drop-dead-brush-ent", "trigfix"),
    ("drop-dead-teleport", "telefix"),
    ("retarget-teleport", "telefix"),
    ("translate-classname", "entfix"),
)

# Files named after the map, which follow it when the .bsp is renamed. Renaming
# these is a small improvement on the hand-made "-wjfix" maps, which renamed the
# .bsp alone and so left the fixed map with no levelshot.
RENAME_COMPANION_DIRS = ("maps/", "levelshots/", "scripts/")


def suffix_for(changes):
    """-> "wjfix-telefix" for the repairs actually applied, or "" for none."""
    applied = {c.repair for c in changes if not c.detail.startswith("declined")}
    out = []
    for repair, token in SUFFIX_TOKENS:
        if repair in applied and token not in out:
            out.append(token)
    return "-".join(out)


def suffixed_name(path, suffix):
    base, ext = os.path.splitext(os.path.basename(path))
    return f"{base}-{suffix}{ext}" if suffix else os.path.basename(path)


def companion_renames(names, bsp_member, suffix):
    """Map every archive member named after this .bsp to its suffixed name."""
    base = os.path.splitext(os.path.basename(bsp_member))[0]
    out = {}
    for n in names:
        d, f = os.path.dirname(n) + "/", os.path.basename(n)
        stem, ext = os.path.splitext(f)
        if stem == base and d in RENAME_COMPANION_DIRS:
            out[n] = f"{d}{base}-{suffix}{ext}"
    return out


def _clone_info(info, filename):
    """A ZipInfo for a renamed member, keeping method, timestamp and mode."""
    new = zipfile.ZipInfo(filename, date_time=info.date_time)
    new.compress_type = info.compress_type
    new.external_attr = info.external_attr
    new.internal_attr = info.internal_attr
    new.create_system = info.create_system
    return new


# --------------------------------------------------------------------------
# pk3 walking
# --------------------------------------------------------------------------

def expand_paths(paths):
    """Accept .pk3 files, directories and shell-style globs, in any mix."""
    out = []
    for p in paths:
        if os.path.isdir(p):
            out.extend(sorted(globmod.glob(os.path.join(p, "*.pk3"))))
        elif any(c in p for c in "*?["):
            out.extend(sorted(globmod.glob(p)))
        else:
            out.append(p)
    seen, uniq = set(), []
    for p in out:
        rp = os.path.abspath(p)
        if rp not in seen:
            seen.add(rp)
            uniq.append(p)
    return uniq


def bsp_members(zf):
    return [n for n in zf.namelist() if n.lower().endswith(".bsp")]


# --------------------------------------------------------------------------
# analysis
# --------------------------------------------------------------------------

class MapResult:
    def __init__(self, pk3, member):
        self.pk3 = pk3
        self.member = member
        self.findings = []
        self.changes = []
        self.error = None
        self.output = None      # basename actually written, once one is

    @property
    def worst(self):
        if not self.findings:
            return None
        return min((f.severity for f in self.findings), key=lambda s: SEVERITY_ORDER[s])


def analyse(data, threshold):
    """-> (bsp, lump, findings, walljump_clearable)"""
    bsp = Bsp(data)
    lump = EntityLump(bsp.entity_text())
    wj_findings, clearable = walljump_findings(bsp, threshold)
    findings = wj_findings + entity_findings(lump, bsp)
    return bsp, lump, findings, clearable


def scan_pk3(path, threshold):
    results = []
    with zipfile.ZipFile(path) as zf:
        for member in bsp_members(zf):
            r = MapResult(path, member)
            try:
                _, _, r.findings, _ = analyse(zf.read(member), threshold)
            except (BspError, zipfile.BadZipFile, OSError) as e:
                r.error = str(e)
            results.append(r)
    return results


# --------------------------------------------------------------------------
# repair + verification
# --------------------------------------------------------------------------

def verify_patch(original: bytes, patched: bytes, expected_text: str,
                 expected_flag_changes: set):
    """Prove the patched BSP differs from the original ONLY where intended.

    This is the whole safety story for writing binary map files, so it checks
    the result rather than trusting the writers: every lump other than 0 and 1
    must be byte-identical, lump 1 may differ only in the flags word of the
    shaderrefs we meant to touch, and lump 0 must decode to exactly the entity
    text we built. Raises AssertionError on any mismatch.
    """
    a, b = Bsp(original), Bsp(patched)
    assert a.magic == b.magic and a.version == b.version, "BSP identity changed"
    assert a.nlumps == b.nlumps, "lump count changed"
    for i in range(a.nlumps):
        if i in (LUMP_ENTITIES, LUMP_SHADERREFS):
            continue
        assert a.lump(i) == b.lump(i), f"lump {i} changed but should not have"

    ra, rb = a.shaderrefs(), b.shaderrefs()
    assert len(ra) == len(rb), "shaderref count changed"
    for i, (x, y) in enumerate(zip(ra, rb)):
        assert x[0] == y[0], f"shaderref {i} name changed"
        assert x[2] == y[2], f"shaderref {i} contents changed"
        if x[1] != y[1]:
            assert i in expected_flag_changes, f"unexpected flag change on shaderref {i}"

    assert b.entity_text() == expected_text, "entity lump is not what we built"


def plan_repairs(path, threshold, enabled):
    """Analyse and repair every BSP in one .pk3, in memory.

    Returns (results, {member: patched_bytes}). Nothing is written here, so the
    caller can name the output after the repairs that were actually applied.
    """
    results, patched_members = [], {}
    with zipfile.ZipFile(path) as zf:
        infos = zf.infolist()
        raw = {i.filename: zf.read(i.filename) for i in infos if not i.is_dir()}
        for member in bsp_members(zf):
            r = MapResult(path, member)
            results.append(r)
            try:
                bsp, lump, findings, clearable = analyse(raw[member], threshold)
                r.findings = findings
                before = bsp.entity_text()
                changes = apply_walljump(bsp, clearable, enabled)
                changes += apply_entity_repairs(lump, bsp, enabled)
                # A "declined" note is a report, not an edit.
                edited = [c for c in changes if not c.detail.startswith("declined")]
                r.changes = changes
                if not edited:
                    continue
                text = lump.render()
                if text != before:
                    bsp.set_entity_text(text)
                patched = bsp.bytes()
                verify_patch(raw[member], patched, bsp.entity_text(), set(clearable))
                # The repair has to actually resolve what it claimed to.
                _, _, after, _ = analyse(patched, threshold)
                fixed_codes = {c.repair for c in edited}
                still = [f for f in after
                         if f.severity == BROKEN and f.fix in fixed_codes]
                assert not still, f"repair did not resolve: {[str(f) for f in still]}"
                patched_members[member] = patched
            except (BspError, AssertionError, ValueError) as e:
                r.error = str(e)
                r.changes = []

    return results, patched_members


def write_repaired(src, out_path, patched_members, renames):
    """Write the repaired .pk3 and prove every member survived intact.

    `renames` maps archive member -> new member name; everything else keeps its
    name, its compression method, its timestamp and its mode bits.
    """
    tmp = out_path + ".tmp"
    os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)
    try:
        with zipfile.ZipFile(src) as zin, zipfile.ZipFile(tmp, "w") as zout:
            for info in zin.infolist():
                data = b"" if info.is_dir() else patched_members.get(info.filename,
                                                                    zin.read(info.filename))
                new_name = renames.get(info.filename)
                zout.writestr(_clone_info(info, new_name) if new_name else info, data)
        # Read the output back: same members (modulo renames), and every byte of
        # every member either patched-as-intended or identical to the input.
        with zipfile.ZipFile(src) as zin, zipfile.ZipFile(tmp) as zchk:
            expect = [renames.get(i.filename, i.filename) for i in zin.infolist()]
            assert expect == [i.filename for i in zchk.infolist()], "member list changed"
            for info in zin.infolist():
                if info.is_dir():
                    continue
                name = renames.get(info.filename, info.filename)
                want = patched_members.get(info.filename, zin.read(info.filename))
                assert zchk.read(name) == want, f"member {name} did not round-trip"
        os.replace(tmp, out_path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    return out_path


def fix_pk3(path, out_path, threshold, enabled, dry_run):
    """Back-compatible one-shot: repair and write to an exact path, no renaming."""
    results, patched = plan_repairs(path, threshold, enabled)
    if not patched or dry_run:
        return results, False
    write_repaired(path, out_path, patched, {})
    return results, True


# --------------------------------------------------------------------------
# output
# --------------------------------------------------------------------------

def print_result(r, show, verbose):
    shown = [f for f in r.findings if SEVERITY_ORDER[f.severity] <= SEVERITY_ORDER[show]]
    if r.error:
        print(f"\n### {os.path.basename(r.pk3)} :: {r.member}")
        print(f"  !! {r.error}")
        return
    if not shown and not r.changes:
        if verbose:
            print(f"\n### {os.path.basename(r.pk3)} :: {r.member}\n  clean")
        return
    print(f"\n### {os.path.basename(r.pk3)} :: {r.member}")
    for f in sorted(shown, key=lambda f: SEVERITY_ORDER[f.severity]):
        print(f"  {f.severity:6s} {f}")
    for c in r.changes:
        print(f"  FIX    {c}")
    if r.output:
        print(f"  ->     {r.output}")


def main():
    ap = argparse.ArgumentParser(
        prog="mapfix",
        description="Find and repair imported race maps the engine silently mis-runs.")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p):
        p.add_argument("paths", nargs="+", help=".pk3 files, directories or globs")
        p.add_argument("--walljump-threshold", type=float, default=0.9, metavar="F",
                       help="fraction of shaderrefs carrying SURF_NOWALLJUMP above which "
                            "the flag is treated as a compile artifact rather than mapper "
                            "intent (default 0.9)")
        p.add_argument("--json", action="store_true", help="machine-readable output")

    s = sub.add_parser("scan", help="report problems, change nothing")
    common(s)
    s.add_argument("--show", choices=[BROKEN, WARN, INFO], default=WARN,
                   help="lowest severity to print (default warn)")
    s.add_argument("-v", "--verbose", action="store_true", help="also list clean maps")

    f = sub.add_parser("fix", help="write repaired .pk3 files")
    common(f)
    f.add_argument("--out", metavar="DIR", help="write repaired .pk3s here (named with the repair suffix)")
    f.add_argument("--in-place", action="store_true",
                   help="overwrite the input, keeping a .bak alongside")
    f.add_argument("--dry-run", action="store_true", help="report the repairs, write nothing")
    f.add_argument("--no-suffix", action="store_true",
                   help="keep the original filename instead of tagging it with the repairs "
                        "that were applied (wjfix / trigfix / telefix / entfix)")
    f.add_argument("--keep-bsp-name", action="store_true",
                   help="rename only the .pk3, leaving the .bsp inside it untouched, so the "
                        "repaired map keeps its existing leaderboard. The default renames "
                        "the .bsp too (the pool convention: bluetown-wjfix.pk3 holds "
                        "maps/bluetown-wjfix.bsp), which makes the fixed map a NEW map to "
                        "the engine and the site -- it can sit alongside the original, and "
                        "it starts an EMPTY board. With this flag the fixed .pk3 is meant "
                        "to REPLACE the original rather than sit next to it.")
    f.add_argument("--enable", default="", metavar="R,R",
                   help=f"repairs to add. available: {', '.join(ALL_REPAIRS)}")
    f.add_argument("--disable", default="", metavar="R,R", help="repairs to skip")
    a = ap.parse_args()

    if a.cmd == "fix":
        if not a.out and not a.in_place and not a.dry_run:
            ap.error("fix needs --out DIR, --in-place, or --dry-run")
        enabled = set(DEFAULT_REPAIRS)
        enabled |= {x for x in a.enable.split(",") if x}
        enabled -= {x for x in a.disable.split(",") if x}
        unknown = enabled - set(ALL_REPAIRS)
        if unknown:
            ap.error(f"unknown repair(s): {', '.join(sorted(unknown))}")

    paths = expand_paths(a.paths)
    if not paths:
        print("no .pk3 files matched", file=sys.stderr)
        return 2

    all_results, wrote = [], 0
    for path in paths:
        try:
            if a.cmd == "scan":
                results = scan_pk3(path, a.walljump_threshold)
            else:
                results, patched = plan_repairs(path, a.walljump_threshold, enabled)
                changes = [c for r in results for c in r.changes]
                suffix = "" if (a.no_suffix or a.in_place) else suffix_for(changes)
                renames = {}
                if suffix and not a.keep_bsp_name:
                    with zipfile.ZipFile(path) as zf:
                        names = zf.namelist()
                    for member in patched:
                        renames.update(companion_renames(names, member, suffix))
                if a.in_place:
                    out = path
                elif a.out:
                    out = os.path.join(a.out, suffixed_name(path, suffix))
                else:
                    out = os.path.join(os.path.dirname(path) or ".",
                                       suffixed_name(path, suffix))
                if patched and not a.dry_run:
                    if a.in_place:
                        bak = path + ".bak"
                        if not os.path.exists(bak):
                            shutil.copy2(path, bak)
                    write_repaired(path, out, patched, renames)
                    wrote += 1
                    for r in results:
                        r.output = os.path.basename(out)
                elif patched and a.dry_run:
                    for r in results:
                        r.output = os.path.basename(out) + " (dry-run)"
        except (zipfile.BadZipFile, OSError) as e:
            r = MapResult(path, "<archive>")
            r.error = str(e)
            results = [r]
        all_results.extend(results)
        if not a.json:
            for r in results:
                print_result(r, getattr(a, "show", WARN), getattr(a, "verbose", False))

    if a.json:
        print(json.dumps([{
            "pk3": r.pk3, "bsp": r.member, "error": r.error,
            "output": r.output,
            "findings": [f.as_dict() for f in r.findings],
            "changes": [{"repair": c.repair, "detail": c.detail} for c in r.changes],
        } for r in all_results], indent=2))
    else:
        broken = sum(1 for r in all_results for f in r.findings if f.severity == BROKEN)
        maps_broken = sum(1 for r in all_results
                          if any(f.severity == BROKEN for f in r.findings))
        errs = sum(1 for r in all_results if r.error)
        print(f"\n==== {len(all_results)} bsp(s) in {len(paths)} pk3(s): "
              f"{broken} broken finding(s) across {maps_broken} map(s), {errs} error(s)"
              + (f", {wrote} pk3(s) written" if a.cmd == "fix" else ""))

    if any(r.error for r in all_results):
        return 1
    if a.cmd == "scan" and any(f.severity == BROKEN for r in all_results for f in r.findings):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
