"""Description -> course spec, with Claude writing the spec and the geometry
checking it.

The model never writes brushes or coordinates. It picks segments from a small
vocabulary (spec.py), which structured output guarantees is well-FORMED. What
structured output cannot guarantee is that the course is physically sound —
a gap too long to clear, a loop that crosses itself — so each draft goes
through spec.validate() and layout.build(), and any problems go back to the
model verbatim as a repair turn. That loop is the "autonomous" part: nothing
reaches q3map2 until the plan passes the same checks a hand-written spec does.
"""

import json

import layout
import physics
import spec as specmod

MODEL = "claude-opus-5"
MAX_ATTEMPTS = 4


def system_prompt():
    gaps = ", ".join(f"drop {d}: {int(physics.max_gap(d))}" for d in (0, 64, 128, 256))
    return f"""You design race courses for Warsow's race mode (racesow). Players run from a
start timer to a stop timer as fast as they can; strafe-jumping (bunnyhopping) lets
good players go far faster than the 320 units/s run speed, so wide, flowing corridors
with long straights and sweeping turns are what make a course fun.

You do not place geometry. You write a course SPEC: an ordered list of segments that
a generator lays end to end. The start room, start timer, finish timer and finish
room are added automatically — do not describe them.

Units: 1 unit ~ 1 inch; the player is 32 wide and 64 tall.

Top-level fields:
  name   "gen_" + lowercase letters/digits/underscores, 6-40 chars, from the theme
  title  a short human title
  width  corridor width, {specmod.WIDTH_MIN}-{specmod.WIDTH_MAX}. 384 is a good default; wider suits strafing.

Segment types (every segment carries every field; set unused ones to 0 / "none"):
  straight   length {specmod.STRAIGHT_MIN}-{specmod.STRAIGHT_MAX}
  turn       direction left|right, angle one of {list(specmod.TURN_ANGLES)},
             radius (centre line) >= width/2 + 64 and <= {specmod.TURN_RADIUS_MAX}
  ramp       length {specmod.RAMP_MIN}-{specmod.RAMP_MAX}, rise (negative = downhill),
             |rise| <= length * 0.577 (30 degrees)
  gap        a pit to jump across. length is lip to lip; drop is how much LOWER the
             landing is (negative = higher, at most {int(physics.max_rise())}).
             Max clearable length by drop: {gaps}.
             A gap needs >= {int(physics.MIN_RUNUP)} units of straight/turn floor right
             before it (ramps and gaps reset that) and must be followed by a
             straight or turn to land on. Falling in kills the player.
  checkpoint a timing split at that point; use 1-4 spread along longer courses.

The course must not cross itself: the generator rejects any overlap, so keep an
eye on where turns send it. Aim for a run of roughly 20-60 seconds at 320 ups
(the sum of lengths / 320). Follow the user's description as closely as these
rules allow; when it asks for something impossible, get as close as you can."""


def _request(client, messages):
    return client.beta.messages.create(
        model=MODEL,
        max_tokens=16000,
        thinking={"type": "adaptive"},
        system=system_prompt(),
        messages=messages,
        output_config={"format": {"type": "json_schema", "schema": specmod.SPEC_SCHEMA}},
        # Route a policy decline to another model inside the same call rather
        # than failing the player's request outright.
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
    )


def plan(description, client=None, log=print):
    """-> (normalized spec, attempts). Raises RuntimeError if no draft passes."""
    if client is None:
        import anthropic
        client = anthropic.Anthropic()

    messages = [{"role": "user", "content": f"Design a course for this description:\n\n{description}"}]
    problems = []
    for attempt in range(1, MAX_ATTEMPTS + 1):
        resp = _request(client, messages)
        if resp.stop_reason == "refusal":
            raise RuntimeError("the model declined this description")
        if resp.stop_reason == "max_tokens":
            raise RuntimeError("the model ran out of output tokens before finishing the spec")
        text = next(b.text for b in resp.content if b.type == "text")
        try:
            draft = specmod.normalize(json.loads(text))
            layout.build(draft)
            return draft, attempt
        except json.JSONDecodeError as e:
            problems = [f"output was not valid JSON: {e}"]
        except layout.LayoutError as e:
            problems = e.problems
        log(f"attempt {attempt}: {len(problems)} problem(s): " + "; ".join(problems))
        # Keep the model's own turn verbatim (thinking blocks included) and
        # answer it with the checker's findings.
        messages.append({"role": "assistant", "content": resp.content})
        messages.append({"role": "user", "content":
                         "The generator rejected that spec:\n- " + "\n- ".join(problems)
                         + "\n\nReturn a corrected spec that keeps the spirit of the description."})
    raise RuntimeError(f"no valid spec after {MAX_ATTEMPTS} attempts; last problems: "
                       + "; ".join(problems))
