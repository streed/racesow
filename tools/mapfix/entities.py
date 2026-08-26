"""
entities.py -- parse and re-emit a BSP entity lump without reformatting it.

Why not just parse into dicts and print them back out: because then every
repaired map gets a whole-lump rewrite, and `mapfix diff` becomes useless for
review. Instead the lump is kept as an ordered list of segments -- literal text
between entities, and entity blocks -- so an untouched entity is re-emitted as
the exact bytes it came in as, and the diff shows only what actually changed.

Key order inside an entity is preserved for the same reason. Duplicate keys are
preserved too: the engine's ED_ParseEdict takes the LAST value for a repeated
key, and a few maps in the pool do repeat keys, so collapsing them into a dict
would silently change meaning.
"""
import re

KV_RE = re.compile(r'"([^"]*)"\s*"([^"]*)"')


class Entity:
    __slots__ = ("pairs", "raw", "index", "dirty")

    def __init__(self, raw, index):
        self.raw = raw
        self.index = index          # spawn order, which is how the engine numbers it
        self.pairs = KV_RE.findall(raw)
        self.dirty = False

    def get(self, key, default=None):
        """Last value wins, matching ED_ParseEdict. Keys are case-sensitive here
        because the engine's field lookup is."""
        val = default
        for k, v in self.pairs:
            if k == key:
                val = v
        return val

    @property
    def classname(self):
        return self.get("classname", "")

    def set(self, key, value):
        for i, (k, _) in enumerate(self.pairs):
            if k == key:
                self.pairs[i] = (k, value)
                self.dirty = True
                return
        self.pairs.append((key, value))
        self.dirty = True

    def render(self):
        if not self.dirty:
            return self.raw
        body = "".join(f'"{k}" "{v}"\n' for k, v in self.pairs)
        return "{\n" + body + "}"

    def __repr__(self):
        return f"<ent #{self.index} {self.classname}>"


class EntityLump:
    def __init__(self, text):
        self.segments = []          # list of ("lit", str) | ("ent", Entity)
        self.entities = []
        self._parse(text)

    def _parse(self, text):
        i, n, index = 0, len(text), 0
        while i < n:
            j = text.find("{", i)
            if j < 0:
                self.segments.append(("lit", text[i:]))
                return
            if j > i:
                self.segments.append(("lit", text[i:j]))
            # Walk to the matching brace, skipping quoted strings so that a
            # value containing a brace (rare, but legal) cannot end the block.
            k, depth, in_str = j, 0, False
            while k < n:
                c = text[k]
                if in_str:
                    if c == '"':
                        in_str = False
                elif c == '"':
                    in_str = True
                elif c == "{":
                    depth += 1
                elif c == "}":
                    depth -= 1
                    if depth == 0:
                        break
                k += 1
            if k >= n:
                # Unterminated block: hand the rest back verbatim rather than
                # inventing structure. The scan reports it; no repair touches it.
                self.segments.append(("lit", text[j:]))
                return
            ent = Entity(text[j:k + 1], index)
            index += 1
            self.entities.append(ent)
            self.segments.append(("ent", ent))
            i = k + 1

    def remove(self, ent):
        """Drop an entity and the whitespace that followed it."""
        for i, (kind, val) in enumerate(self.segments):
            if kind == "ent" and val is ent:
                del self.segments[i]
                if i < len(self.segments) and self.segments[i][0] == "lit" \
                        and not self.segments[i][1].strip():
                    del self.segments[i]
                break
        self.entities.remove(ent)

    def render(self):
        return "".join(v if kind == "lit" else v.render()
                       for kind, v in self.segments)

    def targetnames(self):
        """lower() keyed, because the engine's G_Find uses Q_stricmp."""
        out = {}
        for e in self.entities:
            tn = e.get("targetname")
            if tn:
                out.setdefault(tn.lower(), []).append(e)
        return out
