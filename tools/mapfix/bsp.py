"""
bsp.py -- minimal read/write access to the two BSP lumps mapfix repairs.

Scope is deliberately narrow. mapfix only ever rewrites lump 0 (entities) and
the surface-flags word of lump 1 (shaderrefs); everything else is copied
through byte-for-byte and verified afterwards. So this module parses just
enough to find those two lumps plus the read-only lumps the checks need
(models, brushes) and nothing more.

Formats: IBSP v46 (Quake 3, which is what nearly every imported defrag map is),
IBSP v47 (RTCW, which the engine loads with the same layout) and FBSP v1
(qfusion/Warsow's own). They share the header layout and the
dmodel_t / dbrush_t / dshaderref_t strides mapfix touches; only the vertex,
face and brushside strides differ, and mapfix reads none of those. RBSP is
rejected rather than guessed at.
"""
import struct

LUMP_ENTITIES = 0
LUMP_SHADERREFS = 1
LUMP_MODELS = 7
LUMP_BRUSHES = 8

SHADERREF_STRIDE = 72   # char name[64]; int flags; int contents;
MODEL_STRIDE = 40       # float mins[3], maxs[3]; int face, n_faces, brush, n_brushes;
BRUSH_STRIDE = 12       # int firstside, numsides, shadernum;

# q_collision.h
SURF_NOWALLJUMP = 0x80000

# qcommon/bsp.c q3BSPFormats: the engine accepts IBSP 46 (Quake 3) and IBSP 47
# (RTCW) as the plain Q3 layout, and FBSP 1 as its own Raven-derived one. Q3's
# directory is 17 entries; the Raven formats add LUMP_LIGHTARRAY for 18
# (qfiles.h:210, "HEADER_LUMPS 18 // 16 for IDBSP"). RBSP is a format the engine
# also loads, but mapfix has no sample of one to test against, so it is refused
# rather than assumed to match FBSP.
HEADER_LUMPS = {(b"IBSP", 46): 17, (b"IBSP", 47): 17, (b"FBSP", 1): 18}
SUPPORTED = frozenset(HEADER_LUMPS)


class BspError(Exception):
    pass


class Bsp:
    """A BSP held as bytes, with in-place edits to lumps 0 and 1."""

    def __init__(self, data: bytes):
        if len(data) < 8 + 17 * 8:
            raise BspError("too short to hold a BSP header")
        self.data = bytearray(data)
        self.magic = bytes(self.data[:4])
        self.version = struct.unpack_from("<i", self.data, 4)[0]
        if (self.magic, self.version) not in SUPPORTED:
            raise BspError(f"unsupported BSP {self.magic!r} v{self.version}")
        # Lump count is a property of the format, not something to probe for:
        # Q3's IBSP has 17, the Raven-derived FBSP adds LUMP_LIGHTARRAY for 18.
        # Probing "read until an entry looks invalid" happily reads one slot too
        # far, because the bytes after the last real entry are usually a valid
        # -looking (offset, length) pair pointing into real lump data.
        self.nlumps = HEADER_LUMPS[(self.magic, self.version)]
        if 8 + self.nlumps * 8 > len(self.data):
            raise BspError("file is shorter than its own lump directory")
        for i in range(self.nlumps):
            off, ln = struct.unpack_from("<ii", self.data, 8 + i * 8)
            if off < 0 or ln < 0 or off + ln > len(self.data):
                raise BspError(f"lump {i} directory entry ({off}, {ln}) is out of range")

    # -- raw lump access ---------------------------------------------------

    def lump_dir(self, i):
        return struct.unpack_from("<ii", self.data, 8 + i * 8)

    def lump(self, i):
        off, ln = self.lump_dir(i)
        return bytes(self.data[off:off + ln])

    # -- entities ----------------------------------------------------------

    def entity_text(self) -> str:
        """The lump-0 string, trailing NUL stripped. latin-1: the lump is bytes,
        and mappers do put high-bit characters in message keys."""
        return self.lump(LUMP_ENTITIES).decode("latin-1").rstrip("\x00")

    def set_entity_text(self, text: str) -> None:
        """Replace lump 0.

        Writes in place when the new string fits the old span (the common case,
        since every repair only ever removes or shortens), otherwise appends a
        fresh copy at a 4-aligned EOF and repoints the lump. Appending leaves
        the old bytes as dead space, which is harmless -- lump offsets are
        absolute and nothing indexes into the entity lump by position. It is
        the safe move: no other lump has to shift.
        """
        blob = text.encode("latin-1") + b"\x00"
        off, ln = self.lump_dir(LUMP_ENTITIES)
        if len(blob) <= ln:
            self.data[off:off + len(blob)] = blob
            # Zero the tail so no fragment of the old entity list survives.
            self.data[off + len(blob):off + ln] = b"\x00" * (ln - len(blob))
            struct.pack_into("<ii", self.data, 8 + LUMP_ENTITIES * 8, off, len(blob))
        else:
            while len(self.data) % 4:
                self.data.append(0)
            new_off = len(self.data)
            self.data.extend(blob)
            struct.pack_into("<ii", self.data, 8 + LUMP_ENTITIES * 8, new_off, len(blob))

    # -- shaderrefs --------------------------------------------------------

    def shaderrefs(self):
        """[(name, flags, contents)] from lump 1."""
        blob = self.lump(LUMP_SHADERREFS)
        out = []
        for i in range(len(blob) // SHADERREF_STRIDE):
            b = blob[i * SHADERREF_STRIDE:(i + 1) * SHADERREF_STRIDE]
            name = b[:64].split(b"\x00")[0].decode("latin-1")
            flags, contents = struct.unpack("<ii", b[64:72])
            out.append((name, flags, contents))
        return out

    def set_shaderref_flags(self, index: int, flags: int) -> None:
        off, ln = self.lump_dir(LUMP_SHADERREFS)
        pos = off + index * SHADERREF_STRIDE + 64
        if pos + 4 > off + ln:
            raise BspError(f"shaderref {index} outside lump 1")
        struct.pack_into("<i", self.data, pos, flags)

    # -- read-only lumps the checks need -----------------------------------

    def model_count(self) -> int:
        return len(self.lump(LUMP_MODELS)) // MODEL_STRIDE

    def models(self):
        """[(first_face, n_faces, first_brush, n_brushes)] -- bounds are skipped."""
        blob = self.lump(LUMP_MODELS)
        return [struct.unpack("<4i", blob[i * MODEL_STRIDE + 24:(i + 1) * MODEL_STRIDE])
                for i in range(len(blob) // MODEL_STRIDE)]

    def bytes(self) -> bytes:
        return bytes(self.data)
