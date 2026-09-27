#!/usr/bin/env python3
"""mapgen tests. No dependencies beyond the standard library.

    python3 tools/mapgen/test_mapgen.py

The compile tests need q3map2 ($Q3MAP2 or on PATH) and are skipped without it;
everything else — physics, spec ranges, layout rules, brush winding, the
describe repair loop — runs anywhere.
"""

import copy
import json
import os
import re
import sys
import tempfile
import types
import unittest
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import assets  # noqa: E402
import build  # noqa: E402
import describe  # noqa: E402
import layout  # noqa: E402
import mapfile  # noqa: E402
import physics  # noqa: E402
import screenshots  # noqa: E402
import spec as specmod  # noqa: E402

EXAMPLE = os.path.join(HERE, "examples", "gen_first_light.json")


def example():
    with open(EXAMPLE) as fh:
        return json.load(fh)


def course_of(*segments, width=384):
    return {"name": "gen_test", "title": "Test", "width": width, "segments": list(segments)}


class Physics(unittest.TestCase):
    def test_numbers_match_the_engine(self):
        # 280^2 / (2 * 850): a standing jump clears ~46 units.
        self.assertAlmostEqual(physics.jump_apex(), 46.1, places=1)
        # Flat gap at 320 ups: 0.8 * 320 * 0.659 s.
        self.assertAlmostEqual(physics.max_gap(0), 168.7, places=1)

    def test_dropping_lets_you_go_further(self):
        self.assertGreater(physics.max_gap(128), physics.max_gap(0))
        self.assertLess(physics.max_gap(-30), physics.max_gap(0))

    def test_cannot_land_above_the_apex(self):
        self.assertEqual(physics.max_gap(-50), 0.0)


class Spec(unittest.TestCase):
    def test_example_is_valid(self):
        self.assertEqual(specmod.validate(example()), [])

    def assertRejects(self, spec, fragment):
        errs = specmod.validate(spec)
        self.assertTrue(any(fragment in e for e in errs), f"{fragment!r} not in {errs}")

    def test_gap_too_long(self):
        self.assertRejects(course_of({"type": "straight", "length": 512},
                                     {"type": "gap", "length": 200, "drop": 0},
                                     {"type": "straight", "length": 512}),
                           "not clearable")

    def test_ramp_too_steep(self):
        self.assertRejects(course_of({"type": "ramp", "length": 256, "rise": 200}), "steeper")

    def test_name_needs_gen_prefix(self):
        s = course_of({"type": "straight", "length": 512})
        s["name"] = "icyloop"
        self.assertRejects(s, "gen_")

    def test_turn_radius_must_clear_inner_wall(self):
        self.assertRejects(course_of({"type": "turn", "direction": "left", "angle": 90,
                                      "radius": 100}), "radius")

    def test_normalize_drops_placeholder_fields(self):
        flat = course_of({"type": "straight", "length": 512, "direction": "none",
                          "angle": 0, "radius": 0, "rise": 0, "drop": 0})
        self.assertEqual(specmod.normalize(flat)["segments"],
                         [{"type": "straight", "length": 512}])


class Layout(unittest.TestCase):
    def assertLayoutRejects(self, spec, fragment):
        with self.assertRaises(layout.LayoutError) as cm:
            layout.build(spec)
        self.assertTrue(any(fragment in p for p in cm.exception.problems),
                        f"{fragment!r} not in {cm.exception.problems}")

    def test_example_lays_out(self):
        c = layout.build(example())
        self.assertGreater(c.length, 5000)
        classes = [e["classname"] for e, _ in c.entities]
        for cls in ("info_player_deathmatch", "target_starttimer", "target_stoptimer",
                    "target_checkpoint", "trigger_hurt"):
            self.assertIn(cls, classes)

    def test_gap_needs_runup(self):
        self.assertLayoutRejects(course_of({"type": "ramp", "length": 512, "rise": -128},
                                           {"type": "gap", "length": 96, "drop": 0},
                                           {"type": "straight", "length": 512}),
                                 "run-up")

    def test_gap_must_land_on_floor(self):
        self.assertLayoutRejects(course_of({"type": "straight", "length": 512},
                                           {"type": "gap", "length": 96, "drop": 0},
                                           {"type": "ramp", "length": 512, "rise": 64}),
                                 "must land")

    def test_self_intersection(self):
        loop = [{"type": "straight", "length": 1024}]
        for _ in range(4):
            loop += [{"type": "turn", "direction": "left", "angle": 90, "radius": 320},
                     {"type": "straight", "length": 1024}]
        self.assertLayoutRejects(course_of(*loop), "runs into itself")

    def test_passing_over_is_not_crossing(self):
        # Spiral up: the second lap is a full wall height above the first.
        lap = [{"type": "ramp", "length": 1024, "rise": 512},
               {"type": "turn", "direction": "left", "angle": 180, "radius": 512},
               {"type": "ramp", "length": 1024, "rise": 512},
               {"type": "turn", "direction": "left", "angle": 180, "radius": 512}]
        layout.build(course_of({"type": "straight", "length": 512}, *lap, *lap))

    def test_preview_is_svg(self):
        svg = layout.preview_svg(layout.build(example()))
        self.assertTrue(svg.startswith("<svg") and svg.rstrip().endswith("</svg>"))


PLANE_RE = re.compile(r"\( ([^)]*) \) \( ([^)]*) \) \( ([^)]*) \)")


def _v(s):
    return tuple(float(x) for x in s.split())


class MapFile(unittest.TestCase):
    def test_every_face_points_out_of_its_brush(self):
        """q3map2 computes normal = cross(p2 - p0, p1 - p0). If any face of any
        brush points inward the brush is inside-out and silently vanishes, so
        check every one against its brush's centroid."""
        text = mapfile.write(layout.build(example()))
        brushes, cur = [], None
        for line in text.splitlines():
            if line == "{" and cur is None and brushes is not None:
                cur = []
            m = PLANE_RE.match(line)
            if m:
                cur.append(tuple(_v(g) for g in m.groups()))
            elif line == "}" and cur:
                brushes.append(cur)
                cur = None
            elif line == "}":
                cur = None
        self.assertGreater(len(brushes), 50)
        for faces in brushes:
            pts = [p for f in faces for p in f]
            c = tuple(sum(p[i] for p in pts) / len(pts) for i in range(3))
            for p0, p1, p2 in faces:
                n = mapfile._cross(mapfile._sub(p2, p0), mapfile._sub(p1, p0))
                self.assertLess(mapfile._dot(n, mapfile._sub(c, p0)), 0,
                                f"inward face {p0} {p1} {p2}")


class FakeClient:
    """Stands in for anthropic.Anthropic: returns canned drafts in order and
    records what it was sent."""

    def __init__(self, drafts):
        self.drafts = list(drafts)
        self.calls = []
        self.beta = types.SimpleNamespace(messages=types.SimpleNamespace(create=self._create))

    def _create(self, **kw):
        self.calls.append(copy.deepcopy(kw["messages"]))
        block = types.SimpleNamespace(type="text", text=json.dumps(self.drafts.pop(0)))
        return types.SimpleNamespace(stop_reason="end_turn", content=[block])


def flat(spec):
    out = dict(spec)
    out["segments"] = [dict({"length": 0, "direction": "none", "angle": 0, "radius": 0,
                             "rise": 0, "drop": 0}, **s) for s in spec["segments"]]
    return out


class Assets(unittest.TestCase):
    def test_every_asset_generates(self):
        files = assets.files()
        for kind in assets.TEXTURES:
            data = files[f"textures/{assets.VERSION}/{kind}.tga"]
            # 18-byte header + 256 x 256 x 3
            self.assertEqual(len(data), 18 + assets.SIZE * assets.SIZE * 3, kind)

    def test_every_texture_layout_uses_exists(self):
        for name in layout.TEX.values():
            kind = name.split("/", 1)[1]
            self.assertTrue(kind in assets.TEXTURES or kind in ("sky", "trigger"), name)

    def test_walls_are_darker_than_floors(self):
        def luma(c):
            px = c.px
            return sum(0.299 * r + 0.587 * g + 0.114 * b for r, g, b in px) / len(px)
        self.assertLess(luma(assets.wall()), 0.6 * luma(assets.floor()))


class Screenshots(unittest.TestCase):
    def test_views_cover_every_landmark(self):
        views = screenshots.auto_views(layout.build(example()))
        self.assertEqual([v[0] for v in views],
                         ["start", "gap1", "checkpoint1", "gap2", "finish"])
        for _, pos, yaw in views:
            self.assertEqual(len(pos), 3)
            self.assertTrue(0 <= yaw < 360)


class Describe(unittest.TestCase):
    def test_repair_loop_feeds_problems_back(self):
        bad = flat(course_of({"type": "straight", "length": 512},
                             {"type": "gap", "length": 400, "drop": 0},
                             {"type": "straight", "length": 512}))
        client = FakeClient([bad, flat(example())])
        spec, attempts = describe.plan("anything", client=client, log=lambda m: None)
        self.assertEqual(attempts, 2)
        self.assertEqual(spec["name"], "gen_first_light")
        repair = client.calls[1][-1]["content"]
        self.assertIn("not clearable", repair)

    def test_gives_up(self):
        bad = flat(course_of({"type": "ramp", "length": 256, "rise": 250}))
        client = FakeClient([bad] * describe.MAX_ATTEMPTS)
        with self.assertRaises(RuntimeError):
            describe.plan("anything", client=client, log=lambda m: None)

    def test_schema_is_what_the_prompt_describes(self):
        self.assertEqual(set(specmod.SEGMENT_SCHEMA["properties"]["type"]["enum"]),
                         set(specmod.SEGMENT_TYPES))
        for t in specmod.SEGMENT_TYPES:
            self.assertIn(t, describe.system_prompt())


@unittest.skipUnless(build.find_q3map2(), "q3map2 not available (set Q3MAP2)")
class Compile(unittest.TestCase):
    def test_example_compiles_and_passes_checks(self):
        with tempfile.TemporaryDirectory() as out:
            pk3, report = build.build(example(), out)
            with zipfile.ZipFile(pk3) as zf:
                names = zf.namelist()
                bsp = zf.read("maps/gen_first_light.bsp")
            self.assertIn("scripts/mapgen_v1.shader", names)
            self.assertIn("textures/mapgen_v1/floor.tga", names)
            self.assertEqual(bsp[:4], b"FBSP")
            self.assertEqual(build.check_bsp(bsp), [])
            self.assertGreater(report["par_seconds"], 10)

    def test_same_spec_same_bytes(self):
        with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
            pa, _ = build.build(example(), a)
            pb, _ = build.build(example(), b)
            with open(pa, "rb") as fa, open(pb, "rb") as fb:
                self.assertEqual(fa.read(), fb.read())

    def test_screenshot_views_move_the_spawn(self):
        from entities import EntityLump
        from bsp import Bsp as _Bsp
        views = [["a", [100, 200, 300], 45]]
        with tempfile.TemporaryDirectory() as out, tempfile.TemporaryDirectory() as base:
            pk3, _ = build.build(example(), out)
            (name,) = screenshots.stage_views(pk3, views, base)
            with zipfile.ZipFile(os.path.join(base, name + ".pk3")) as zf:
                data = zf.read(f"maps/{name}.bsp")
                self.assertIn(f"textures/{assets.VERSION}/floor.tga", zf.namelist())
        spawn = next(e for e in EntityLump(_Bsp(data).entity_text()).entities
                     if e.classname == "info_player_deathmatch")
        self.assertEqual(spawn.get("origin"), "100 200 300")
        self.assertEqual(spawn.get("angles"), "0 45 0")
        self.assertIsNone(spawn.get("angle"))

    def test_check_catches_a_missing_stop_timer(self):
        with tempfile.TemporaryDirectory() as out:
            pk3, _ = build.build(example(), out)
            with zipfile.ZipFile(pk3) as zf:
                data = zf.read("maps/gen_first_light.bsp")
        from bsp import Bsp
        b = Bsp(data)
        b.set_entity_text(b.entity_text().replace("target_stoptimer", "info_null"))
        problems = build.check_bsp(b.bytes())
        self.assertTrue(any("target_stoptimer" in p for p in problems), problems)


if __name__ == "__main__":
    unittest.main(verbosity=2)
