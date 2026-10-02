#!/usr/bin/env python3
"""mapgen — describe a race map in words, get a compiled, checked .pk3.

    mapgen.py plan  "a fast icy loop with two big jumps" -o spec.json
    mapgen.py check spec.json [--svg plan.svg]
    mapgen.py build spec.json --out build/ [--q3map2 PATH] [--final]
    mapgen.py generate "..." --out build/           # plan + build
    mapgen.py deck --out build/                     # the random_map tile deck

`plan` needs Anthropic credentials (ANTHROPIC_API_KEY or `ant auth login`).
`deck` builds the meta map: one .pk3 holding every course piece as a dormant
inline model plus a manifest, which the gametype deals into a route at runtime
(tools/mapgen/tiles.py, server/racemod/.../hrace/metamap.as). It takes no spec
— the deck IS the catalogue in tiles.py.

`check` and `build` are offline and deterministic: the same spec always
yields the same .pk3, so a spec is what to store, review and diff.

Exit status: 0 ok, 1 the spec/plan/map was rejected, 2 usage or missing tool.
See README.md and docs/map-generation-design.md.
"""

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import build as buildmod  # noqa: E402
import layout  # noqa: E402
import spec as specmod  # noqa: E402


def _load(path):
    with open(path) as fh:
        return json.load(fh)


def _emit(args, obj, text):
    print(json.dumps(obj, indent=2) if args.json else text)


def cmd_plan(args):
    import describe
    calls = []
    try:
        spec, attempts = describe.plan(args.description, usage=calls,
                                       log=lambda m: print(m, file=sys.stderr))
    finally:
        u = describe.usage_summary(calls)
        est = "?" if u["est_usd"] is None else f"${u['est_usd']:.4f}"
        print(f"Claude usage: {u['calls']} call(s), {u['input_tokens']} in / "
              f"{u['output_tokens']} out tokens, ~{est}", file=sys.stderr)
    body = json.dumps(spec, indent=2) + "\n"
    if args.output:
        with open(args.output, "w") as fh:
            fh.write(body)
        print(f"wrote {args.output} ({len(spec['segments'])} segments, "
              f"{attempts} attempt(s))", file=sys.stderr)
    else:
        sys.stdout.write(body)
    return spec


def cmd_check(args):
    spec = _load(args.spec)
    try:
        course = layout.build(spec, rules=args.rules)
    except layout.LayoutError as e:
        _emit(args, {"ok": False, "problems": e.problems},
              "rejected:\n  " + "\n  ".join(e.problems))
        return 1
    if args.svg:
        with open(args.svg, "w") as fh:
            fh.write(layout.preview_svg(course))
    _emit(args, {"ok": True, "route_length": round(course.length),
                 "par_seconds": round(course.length / 320.0, 1),
                 "features": course.features, "overpasses": course.overpasses},
          f"ok: {round(course.length)} units, par ~{course.length / 320.0:.1f} s at 320 ups"
          + _extras(course.features, course.shortcuts, course.overpasses))
    return 0


def _extras(features, shortcuts, overpasses):
    """ "; 2 slalom(s), 1 beam(s), 1 shortcut(s), 1 overpass(es)", or ""."""
    counts = {}
    for f in features:
        counts[f["type"]] = counts.get(f["type"], 0) + 1
    parts = [f"{n} {t}(s)" for t, n in counts.items()]
    if shortcuts:
        parts.append(f"{len(shortcuts)} shortcut(s)")
    if overpasses:
        parts.append(f"{len(overpasses)} overpass(es)")
    return "; " + ", ".join(parts) if parts else ""


def _build(args, spec):
    try:
        pk3, report = buildmod.build(spec, args.out, q3map2=args.q3map2,
                                     fast=not args.final, keep_work=args.keep_work,
                                     rules=getattr(args, "rules", "strict"))
    except layout.LayoutError as e:
        _emit(args, {"ok": False, "problems": e.problems},
              "rejected:\n  " + "\n  ".join(e.problems))
        return 1
    except buildmod.BuildError as e:
        _emit(args, {"ok": False, "problems": [str(e)]}, f"build failed: {e}")
        return 2 if "not found" in str(e) else 1
    report["ok"] = True
    _emit(args, report, f"ok: {pk3}  (par ~{report['par_seconds']} s, "
                        f"{report['checkpoints']} checkpoint(s))"
                        + _extras(report["features"], report["shortcuts"], report["overpasses"]))
    return 0


def cmd_build(args):
    return _build(args, _load(args.spec))


def cmd_generate(args):
    args.output = os.path.join(args.out, "spec.json")
    os.makedirs(args.out, exist_ok=True)
    spec = cmd_plan(args)
    os.replace(args.output, os.path.join(args.out, spec["name"] + ".json"))
    return _build(args, spec)


def cmd_deck(args):
    """Compile the meta map's tile deck."""
    pk3, deck, problems, _ = buildmod.build_deck(
        args.name, args.title, args.out, q3map2=args.q3map2,
        fast=not args.final, keep_work=args.keep_work)
    if problems:
        _emit(args, {"ok": False, "problems": problems},
              "deck rejected:\n" + "\n".join("  - " + p for p in problems))
        return 1
    kinds = {}
    for t in deck.tiles:
        kinds[t.kind] = kinds.get(t.kind, 0) + 1
    _emit(args, {"ok": True, "pk3": pk3, "tiles": len(deck.tiles), "kinds": kinds},
          f"{pk3}\n  {len(deck.tiles)} pieces: "
          + ", ".join(f"{n} {k}" for k, n in sorted(kinds.items(), key=lambda x: -x[1])))
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--json", action="store_true", help="machine-readable output")
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("plan", help="description -> spec (calls Claude)")
    sp.add_argument("description")
    sp.add_argument("-o", "--output")

    # Which rule tier to hold the spec to. "strict" is the generator's own and
    # the default everywhere; "open" is the map editor's, where the pieces-fit-
    # together rules become notes on the report rather than refusals (a person
    # laid the course out and an admin approves it). See spec.py.
    def rules_opt(sp):
        sp.add_argument("--rules", choices=sorted(specmod.TIERS), default="strict",
                        help="rule tier: strict (the generator) or open (the map editor)")

    sc = sub.add_parser("check", help="validate a spec and lay it out; no compile")
    sc.add_argument("spec")
    sc.add_argument("--svg", help="write a top-down plan preview")
    rules_opt(sc)

    def build_opts(sp):
        sp.add_argument("--out", required=True, help="output directory")
        sp.add_argument("--q3map2", help="q3map2 binary (default: $Q3MAP2, then PATH)")
        sp.add_argument("--final", action="store_true",
                        help="slow, full-quality vis and light instead of -fast")
        sp.add_argument("--keep-work", action="store_true",
                        help="keep the q3map2 work directory (it is printed on error)")

    sb = sub.add_parser("build", help="spec -> compiled, checked .pk3")
    sb.add_argument("spec")
    build_opts(sb)
    rules_opt(sb)

    sg = sub.add_parser("generate", help="description -> .pk3 (plan + build)")
    sg.add_argument("description")
    build_opts(sg)

    sd = sub.add_parser("deck", help="the meta map's tile deck -> .pk3 (no spec)")
    sd.add_argument("--name", default="random_map",
                    help="bsp name; must match META_MAP_NAME in hrace/metamap.as")
    sd.add_argument("--title", default="Random Map")
    build_opts(sd)

    args = p.parse_args(argv)
    run = {"plan": lambda a: (cmd_plan(a), 0)[1], "check": cmd_check,
           "build": cmd_build, "generate": cmd_generate,
           "deck": cmd_deck}[args.cmd]
    try:
        return run(args)
    except ImportError as e:
        print(f"missing dependency: {e} (pip install anthropic)", file=sys.stderr)
        return 2
    except RuntimeError as e:   # describe.plan could not produce a valid spec
        print(f"plan failed: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
