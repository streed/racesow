#!/usr/bin/env python3
"""
test_mapfix.py -- run with `python3 tools/mapfix/test_mapfix.py`. No deps.

The load-bearing test is test_matches_handmade_wjfix: the pool already contains
577 maps somebody fixed BY HAND, four of which still have their unfixed original
alongside. mapfix's walljump repair has to reproduce those four byte for byte.
That is a much stronger statement than any synthetic fixture -- it says the tool
agrees with a human who had the game in front of them.

The synthetic tests cover what the real pairs cannot: the entity-lump grow path
(no real map needs it), and the destination-marker case that an earlier cut of
this tool got wrong and would have used to delete 1,880 working entities.
"""
import io
import os
import struct
import sys
import tempfile
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from bsp import Bsp, SURF_NOWALLJUMP                      # noqa: E402
from entities import EntityLump                            # noqa: E402
import mapfix                                              # noqa: E402
from repairs import DEFAULT_REPAIRS                        # noqa: E402

MAPS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "server", "maps")
PASS, FAIL = [], []


def check(name, fn):
    try:
        fn()
        PASS.append(name)
        print(f"  ok    {name}")
    except AssertionError as e:
        FAIL.append((name, str(e)))
        print(f"  FAIL  {name}: {e}")
    except Exception as e:                                  # noqa: BLE001
        FAIL.append((name, repr(e)))
        print(f"  ERROR {name}: {e!r}")


# --------------------------------------------------------------------------
# a synthetic IBSP v46 with real lump 0 / 1 and stub everything else
# --------------------------------------------------------------------------

def make_bsp(entity_text, shaders, extra_tail=b"PAD!" * 8):
    """shaders: [(name, flags, contents)]"""
    nl = 17
    header = bytearray(b"IBSP" + struct.pack("<i", 46) + b"\x00" * (nl * 8))
    body = bytearray()

    def add(idx, blob):
        off = 8 + nl * 8 + len(body)
        struct.pack_into("<ii", header, 8 + idx * 8, off, len(blob))
        body.extend(blob)

    add(0, entity_text.encode("latin-1") + b"\x00")
    sh = bytearray()
    for name, flags, contents in shaders:
        sh.extend(name.encode("latin-1").ljust(64, b"\x00")[:64])
        sh.extend(struct.pack("<ii", flags, contents))
    add(1, bytes(sh))
    for i in range(2, nl):
        # Every other lump gets distinct bytes so a stray write is detectable.
        add(i, bytes([i]) * (8 if i != 7 else 40 * 3))       # lump 7 = 3 models
    return bytes(header) + bytes(body) + extra_tail


ENTS = (
    '{\n"classname" "worldspawn"\n}\n'
    '{\n"classname" "target_starttimer"\n"targetname" "s1"\n}\n'
    '{\n"classname" "target_stoptimer"\n"targetname" "f1"\n}\n'
    '{\n"classname" "trigger_multiple"\n"target" "s1"\n"model" "*1"\n}\n'
    '{\n"classname" "trigger_multiple"\n"target" "f1"\n"model" "*2"\n}\n'
)


def test_entity_roundtrip_is_byte_exact():
    data = make_bsp(ENTS, [("textures/x/y", 0, 1)])
    b = Bsp(data)
    lump = EntityLump(b.entity_text())
    assert lump.render() == b.entity_text(), "unmodified render must be identical"
    b.set_entity_text(lump.render())
    assert Bsp(b.bytes()).entity_text() == b.entity_text()


def test_entity_shrink_writes_in_place():
    data = make_bsp(ENTS, [("textures/x/y", 0, 1)])
    b = Bsp(data)
    off_before, len_before = b.lump_dir(0)
    lump = EntityLump(b.entity_text())
    lump.remove(lump.entities[-1])
    b.set_entity_text(lump.render())
    off_after, len_after = b.lump_dir(0)
    assert off_after == off_before, "a shrink must not relocate the lump"
    assert len_after < len_before
    assert len(b.bytes()) == len(data), "a shrink must not change the file size"
    assert "*2" not in Bsp(b.bytes()).entity_text()


def test_entity_grow_appends_and_repoints():
    data = make_bsp(ENTS, [("textures/x/y", 0, 1)])
    b = Bsp(data)
    off_before, _ = b.lump_dir(0)
    big = b.entity_text() + '{\n"classname" "info_player_deathmatch"\n' + '"pad" "%s"\n' % ("x" * 400) + "}\n"
    b.set_entity_text(big)
    off_after, len_after = b.lump_dir(0)
    assert off_after != off_before, "a grow must relocate the lump"
    assert off_after % 4 == 0, "relocated lump must stay 4-aligned"
    out = Bsp(b.bytes())
    assert out.entity_text() == big
    # every other lump must be untouched
    for i in range(1, out.nlumps):
        assert out.lump(i) == Bsp(data).lump(i), f"lump {i} moved"


def test_walljump_blanket_is_cleared_but_intent_is_kept():
    shaders = [("textures/a/wall", SURF_NOWALLJUMP, 1),
               ("noshader", SURF_NOWALLJUMP, 1),
               ("textures/common/noob", SURF_NOWALLJUMP | 0x20, 1)]
    data = make_bsp(ENTS, shaders)
    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, "synthetic.pk3")
        with zipfile.ZipFile(src, "w") as z:
            z.writestr("maps/synthetic.bsp", data)
            z.writestr("scripts/keepme.shader", b"untouched\n")
        out = os.path.join(td, "out", "synthetic.pk3")
        results, wrote = mapfix.fix_pk3(src, out, 0.9, set(DEFAULT_REPAIRS), False)
        assert wrote, "expected a write"
        with zipfile.ZipFile(out) as z:
            refs = Bsp(z.read("maps/synthetic.bsp")).shaderrefs()
            assert z.read("scripts/keepme.shader") == b"untouched\n", "sibling file changed"
        assert not refs[0][1] & SURF_NOWALLJUMP, "wall should have been cleared"
        assert not refs[1][1] & SURF_NOWALLJUMP, "noshader should have been cleared"
        assert refs[2][1] & SURF_NOWALLJUMP, "common/noob is deliberate and must survive"
        assert refs[2][1] & 0x20, "unrelated flag bits must survive"


def test_walljump_selective_is_left_alone():
    shaders = [("textures/a/wall", 0, 1)] * 9 + [("textures/common/noob", SURF_NOWALLJUMP, 1)]
    data = make_bsp(ENTS, shaders)
    b, _, findings, clearable = mapfix.analyse(data, 0.9)
    assert not clearable, "a 1-in-10 flag is mapper intent, not an artifact"
    assert any(f.code == "WALLJUMP_SELECTIVE" for f in findings)


def test_destination_marker_teleporter_is_not_removed():
    """The regression that matters: target_teleporter with no "target" is a
    DESTINATION, and 1,880 of the pool's 1,884 look exactly like this."""
    ents = ENTS + (
        '{\n"classname" "trigger_teleport"\n"target" "dest1"\n"model" "*1"\n}\n'
        '{\n"classname" "target_teleporter"\n"targetname" "dest1"\n"origin" "0 0 0"\n}\n'
    )
    data = make_bsp(ents, [("textures/x/y", 0, 1)])
    _, _, findings, _ = mapfix.analyse(data, 0.9)
    assert not any(f.code == "TELEPORT_NO_TARGET" for f in findings), \
        "destination marker must not be reported as a dead teleporter"
    assert not any(f.severity == "broken" for f in findings), \
        f"expected no broken findings, got {[str(f) for f in findings]}"


def test_dead_trigger_teleport_is_reported_and_dropped():
    ents = ENTS + '{\n"classname" "trigger_teleport"\n"model" "*1"\n}\n'
    data = make_bsp(ents, [("textures/x/y", 0, 1)])
    _, _, findings, _ = mapfix.analyse(data, 0.9)
    assert any(f.code == "TELEPORT_NO_TARGET" for f in findings)


def test_brush_entity_without_model_is_reported():
    ents = ENTS + '{\n"classname" "trigger_multiple"\n"target" "s1"\n}\n'
    data = make_bsp(ents, [("textures/x/y", 0, 1)])
    _, _, findings, _ = mapfix.analyse(data, 0.9)
    assert any(f.code == "BRUSH_NO_MODEL" for f in findings)


def test_orphan_model_is_reattached_when_unambiguous():
    # lump 7 holds 3 models: *0 world, *1 and *2. ENTS claims *1 and *2, so
    # drop one claim and leave exactly one orphan for exactly one claimant.
    ents = (
        '{\n"classname" "worldspawn"\n}\n'
        '{\n"classname" "target_starttimer"\n"targetname" "s1"\n}\n'
        '{\n"classname" "target_stoptimer"\n"targetname" "f1"\n}\n'
        '{\n"classname" "trigger_multiple"\n"target" "s1"\n"model" "*1"\n}\n'
        '{\n"classname" "trigger_multiple"\n"target" "f1"\n}\n'
    )
    data = make_bsp(ents, [("textures/x/y", 0, 1)])
    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, "s.pk3")
        with zipfile.ZipFile(src, "w") as z:
            z.writestr("maps/s.bsp", data)
        out = os.path.join(td, "s2.pk3")
        results, wrote = mapfix.fix_pk3(src, out, 0.9, set(DEFAULT_REPAIRS), False)
        assert wrote
        with zipfile.ZipFile(out) as z:
            text = Bsp(z.read("maps/s.bsp")).entity_text()
        assert '"model" "*2"' in text, f"orphan model should have been reattached:\n{text}"


def test_no_timer_is_flagged():
    ents = '{\n"classname" "worldspawn"\n}\n'
    data = make_bsp(ents, [("textures/x/y", 0, 1)])
    _, _, findings, _ = mapfix.analyse(data, 0.9)
    codes = {f.code for f in findings}
    assert "NO_START_TIMER" in codes and "NO_STOP_TIMER" in codes


def test_matches_handmade_wjfix():
    """Reproduce four maps that a human fixed by hand, byte for byte."""
    pairs = [("bluetown", "bluetown-wjfix"), ("drm-annh", "drm-annh-wjfix"),
             ("nood-squarefeet", "nood-squarefeet-wjfix"), ("tatmt-long1", "tatmt-long1-wjfix")]
    available = [(a, b) for a, b in pairs
                 if os.path.exists(os.path.join(MAPS, a + ".pk3"))
                 and os.path.exists(os.path.join(MAPS, b + ".pk3"))]
    if not available:
        print("       (skipped: server/maps not populated)")
        return
    with tempfile.TemporaryDirectory() as td:
        for orig, fixed in available:
            src = os.path.join(MAPS, orig + ".pk3")
            out = os.path.join(td, orig + ".pk3")
            _, wrote = mapfix.fix_pk3(src, out, 0.9, set(DEFAULT_REPAIRS), False)
            assert wrote, f"{orig}: expected a repair"
            with zipfile.ZipFile(out) as zo, \
                 zipfile.ZipFile(os.path.join(MAPS, fixed + ".pk3")) as zh:
                ours = zo.read(f"maps/{orig}.bsp")
                theirs = zh.read(f"maps/{fixed}.bsp")
            assert ours == theirs, f"{orig}: differs from the hand-made {fixed}"


def test_suffix_names_the_repairs():
    from mapfix import suffix_for, suffixed_name
    from repairs import Change
    assert suffix_for([Change("walljump", "x")]) == "wjfix"
    assert suffix_for([Change("drop-dead-brush-ent", "x"),
                       Change("drop-dead-teleport", "x")]) == "trigfix-telefix"
    # order is fixed by SUFFIX_TOKENS, not by the order repairs happened to run
    assert suffix_for([Change("drop-dead-teleport", "x"),
                       Change("walljump", "x")]) == "wjfix-telefix"
    # the two trigger repairs collapse to one token rather than repeating it
    assert suffix_for([Change("reattach-orphan-model", "x"),
                       Change("drop-dead-brush-ent", "x")]) == "trigfix"
    # a declined note is not a repair and must not name the file
    assert suffix_for([Change("reattach-orphan-model", "declined: ambiguous")]) == ""
    assert suffixed_name("/a/b/foo.pk3", "wjfix") == "foo-wjfix.pk3"
    assert suffixed_name("/a/b/foo.pk3", "") == "foo.pk3"


def test_rename_bsp_carries_the_levelshot():
    """The hand-made -wjfix maps renamed the .bsp alone, orphaning the
    levelshot. Renaming the companions too is the one place mapfix improves on
    them, so it needs a test."""
    from mapfix import companion_renames
    names = ["maps/foo.bsp", "maps/foo.aas", "levelshots/foo.jpg",
             "scripts/foo.defi", "scripts/shared.shader", "textures/foo/wall.jpg",
             "maps/other.bsp"]
    r = companion_renames(names, "maps/foo.bsp", "wjfix")
    assert r == {"maps/foo.bsp": "maps/foo-wjfix.bsp",
                 "maps/foo.aas": "maps/foo-wjfix.aas",
                 "levelshots/foo.jpg": "levelshots/foo-wjfix.jpg",
                 "scripts/foo.defi": "scripts/foo-wjfix.defi"}, r


def test_rename_bsp_roundtrips_every_member():
    data = make_bsp(ENTS, [("textures/a/wall", SURF_NOWALLJUMP, 1)] * 3)
    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, "m.pk3")
        with zipfile.ZipFile(src, "w") as z:
            z.writestr("maps/m.bsp", data)
            z.writestr("levelshots/m.jpg", b"SHOT")
            z.writestr("textures/m/wall.jpg", b"TEX")
        _, patched = mapfix.plan_repairs(src, 0.9, set(DEFAULT_REPAIRS))
        assert patched, "expected a walljump repair"
        with zipfile.ZipFile(src) as z:
            renames = mapfix.companion_renames(z.namelist(), "maps/m.bsp", "wjfix")
        out = os.path.join(td, "m-wjfix.pk3")
        mapfix.write_repaired(src, out, patched, renames)     # verifies internally
        with zipfile.ZipFile(out) as z:
            assert sorted(z.namelist()) == ["levelshots/m-wjfix.jpg", "maps/m-wjfix.bsp",
                                            "textures/m/wall.jpg"], z.namelist()
            assert z.read("levelshots/m-wjfix.jpg") == b"SHOT"
            assert z.read("textures/m/wall.jpg") == b"TEX"
            refs = Bsp(z.read("maps/m-wjfix.bsp")).shaderrefs()
        assert not any(f & SURF_NOWALLJUMP for _, f, _ in refs)


def test_default_renames_the_bsp_and_keep_flag_does_not():
    """Renaming the .bsp is the DEFAULT, so it needs a test at the CLI level --
    it decides whether a repaired map inherits its leaderboard or starts a new
    one, which is not something to leave to a flag default nobody checks."""
    data = make_bsp(ENTS, [("textures/a/wall", SURF_NOWALLJUMP, 1)] * 3)
    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, "m.pk3")
        with zipfile.ZipFile(src, "w") as z:
            z.writestr("maps/m.bsp", data)
            z.writestr("levelshots/m.jpg", b"SHOT")
        for flags, want_bsp, want_shot in (
                ([], "maps/m-wjfix.bsp", "levelshots/m-wjfix.jpg"),
                (["--keep-bsp-name"], "maps/m.bsp", "levelshots/m.jpg")):
            out = os.path.join(td, "out" + "".join(flags))
            argv = sys.argv
            sys.argv = ["mapfix", "fix", src, "--out", out] + flags
            try:
                mapfix.main()
            finally:
                sys.argv = argv
            produced = os.path.join(out, "m-wjfix.pk3")
            assert os.path.exists(produced), f"{flags}: expected m-wjfix.pk3 in {out}"
            with zipfile.ZipFile(produced) as z:
                names = set(z.namelist())
            assert want_bsp in names, f"{flags}: expected {want_bsp}, got {sorted(names)}"
            assert want_shot in names, f"{flags}: expected {want_shot}, got {sorted(names)}"


def test_unsupported_bsp_is_refused_not_guessed():
    data = bytearray(make_bsp(ENTS, [("textures/x/y", 0, 1)]))
    data[:4] = b"RBSP"
    try:
        Bsp(bytes(data))
    except Exception as e:                                   # noqa: BLE001
        assert "unsupported" in str(e), f"wrong error: {e}"
        return
    raise AssertionError("RBSP should have been refused")


if __name__ == "__main__":
    print("mapfix tests")
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            check(name, fn)
    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    sys.exit(1 if FAIL else 0)
