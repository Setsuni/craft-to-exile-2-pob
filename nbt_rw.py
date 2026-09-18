#!/usr/bin/env python3
"""
CTE2 PoB - NBT read/write that preserves types.

`nbt.py` reads into plain dicts, which is fine for inspection and useless for
writing: a Python int cannot say whether it was a TAG_BYTE, TAG_SHORT, TAG_INT
or TAG_LONG, a float cannot say FLOAT or DOUBLE, and an empty list has lost its
element type entirely. Serialising that back guesses, and a guess in a player's
save is a corrupted character.

So this keeps the tag type alongside every value:

    Tag(TAG_INT, 5)            a typed scalar
    Compound                   dict of name -> Tag, insertion-ordered
    List(elem_type, [Tag...])  keeps its element type even when empty

The contract this module has to meet is not "it parses" but "read then write
returns the original bytes". `selftest()` asserts exactly that over every save
it is pointed at, and nothing in this project writes a save until it passes.
"""
import gzip, os, struct, sys, zlib
from collections import OrderedDict

TAG_END, TAG_BYTE, TAG_SHORT, TAG_INT, TAG_LONG = 0, 1, 2, 3, 4
TAG_FLOAT, TAG_DOUBLE, TAG_BYTE_ARRAY, TAG_STRING = 5, 6, 7, 8
TAG_LIST, TAG_COMPOUND, TAG_INT_ARRAY, TAG_LONG_ARRAY = 9, 10, 11, 12

NAMES = {0: 'END', 1: 'BYTE', 2: 'SHORT', 3: 'INT', 4: 'LONG', 5: 'FLOAT',
         6: 'DOUBLE', 7: 'BYTE_ARRAY', 8: 'STRING', 9: 'LIST', 10: 'COMPOUND',
         11: 'INT_ARRAY', 12: 'LONG_ARRAY'}


class Tag(object):
    __slots__ = ('t', 'v')

    def __init__(self, t, v):
        self.t = t
        self.v = v

    def __repr__(self):
        return 'Tag(%s, %r)' % (NAMES.get(self.t, self.t), self.v)


class List(object):
    """A TAG_LIST remembers its element type even when empty."""
    __slots__ = ('elem', 'items')

    def __init__(self, elem, items):
        self.elem = elem
        self.items = items

    def __len__(self):
        return len(self.items)

    def __iter__(self):
        return iter(self.items)

    def __getitem__(self, i):
        return self.items[i]


def Compound():
    return OrderedDict()


# ---------------------------------------------------------------- reading
class _R(object):
    def __init__(self, b):
        self.b = b
        self.i = 0

    def raw(self, n):
        v = self.b[self.i:self.i + n]
        if len(v) != n:
            raise EOFError('truncated NBT')
        self.i += n
        return v

    def u1(self):
        return self.raw(1)[0]

    def unpack(self, fmt, n):
        return struct.unpack(fmt, self.raw(n))[0]

    def string(self):
        return self.raw(self.unpack('>H', 2)).decode('utf-8')

    def payload(self, t):
        if t == TAG_BYTE:
            return self.unpack('>b', 1)
        if t == TAG_SHORT:
            return self.unpack('>h', 2)
        if t == TAG_INT:
            return self.unpack('>i', 4)
        if t == TAG_LONG:
            return self.unpack('>q', 8)
        if t == TAG_FLOAT:
            return self.unpack('>f', 4)
        if t == TAG_DOUBLE:
            return self.unpack('>d', 8)
        if t == TAG_BYTE_ARRAY:
            return bytearray(self.raw(self.unpack('>i', 4)))
        if t == TAG_STRING:
            return self.string()
        if t == TAG_LIST:
            elem = self.u1()
            n = self.unpack('>i', 4)
            # A negative or zero count still carries an element type.
            return List(elem, [self.payload(elem) for _ in range(max(0, n))])
        if t == TAG_COMPOUND:
            out = Compound()
            while True:
                tt = self.u1()
                if tt == TAG_END:
                    return out
                name = self.string()          # name before payload, always
                out[name] = Tag(tt, self.payload(tt))
        if t == TAG_INT_ARRAY:
            n = self.unpack('>i', 4)
            return [self.unpack('>i', 4) for _ in range(n)]
        if t == TAG_LONG_ARRAY:
            n = self.unpack('>i', 4)
            return [self.unpack('>q', 8) for _ in range(n)]
        raise ValueError('unknown tag %d' % t)


def parse(raw):
    """Decompressed bytes -> (root_name, Compound)."""
    r = _R(raw)
    t = r.u1()
    if t != TAG_COMPOUND:
        raise ValueError('root is not a compound (tag %d)' % t)
    name = r.string()
    return name, r.payload(TAG_COMPOUND)


# ---------------------------------------------------------------- writing
def _w_string(out, s):
    b = s.encode('utf-8')
    out += struct.pack('>H', len(b))
    out += b


def _w_payload(out, t, v):
    if t == TAG_BYTE:
        out += struct.pack('>b', v)
    elif t == TAG_SHORT:
        out += struct.pack('>h', v)
    elif t == TAG_INT:
        out += struct.pack('>i', v)
    elif t == TAG_LONG:
        out += struct.pack('>q', v)
    elif t == TAG_FLOAT:
        out += struct.pack('>f', v)
    elif t == TAG_DOUBLE:
        out += struct.pack('>d', v)
    elif t == TAG_BYTE_ARRAY:
        out += struct.pack('>i', len(v))
        out += bytes(v)
    elif t == TAG_STRING:
        _w_string(out, v)
    elif t == TAG_LIST:
        out += struct.pack('>B', v.elem)
        out += struct.pack('>i', len(v.items))
        for item in v.items:
            _w_payload(out, v.elem, item)
    elif t == TAG_COMPOUND:
        for name, tag in v.items():
            out += struct.pack('>B', tag.t)
            _w_string(out, name)
            _w_payload(out, tag.t, tag.v)
        out += b'\x00'
    elif t == TAG_INT_ARRAY:
        out += struct.pack('>i', len(v))
        for x in v:
            out += struct.pack('>i', x)
    elif t == TAG_LONG_ARRAY:
        out += struct.pack('>i', len(v))
        for x in v:
            out += struct.pack('>q', x)
    else:
        raise ValueError('cannot write tag %d' % t)


def serialise(name, root):
    out = bytearray()
    out += struct.pack('>B', TAG_COMPOUND)
    _w_string(out, name)
    _w_payload(out, TAG_COMPOUND, root)
    return bytes(out)


# ---------------------------------------------------------------- files
def decompress(data):
    if data[:2] == b'\x1f\x8b':
        return gzip.decompress(data), 'gzip'
    if data[:1] == b'\x78':
        return zlib.decompress(data), 'zlib'
    return data, 'raw'


def load(path):
    """-> (root_name, Compound, how_it_was_compressed)"""
    blob, how = decompress(open(path, 'rb').read())
    name, root = parse(blob)
    return name, root, how


def save(path, name, root, how='gzip'):
    blob = serialise(name, root)
    if how == 'gzip':
        # mtime=0 so two writes of the same tree are byte-identical.
        blob = gzip.compress(blob, mtime=0)
    elif how == 'zlib':
        blob = zlib.compress(blob)
    with open(path, 'wb') as fh:
        fh.write(blob)


# ---------------------------------------------------------------- helpers
def get(root, path):
    """`get(root, 'ForgeCaps/mmorpg:player_data/lvl')` -> Tag or None."""
    cur = root
    for part in path.strip('/').split('/'):
        if not isinstance(cur, OrderedDict) or part not in cur:
            return None
        tag = cur[part]
        cur = tag.v
    return tag


def set_value(root, path, value):
    """Replace a scalar in place, keeping its tag type. Returns the old value."""
    tag = get(root, path)
    if tag is None:
        raise KeyError(path)
    old = tag.v
    tag.v = value
    return old


# ---------------------------------------------------------------- self-test
def selftest(paths):
    """Read then write must return the original bytes. Nothing writes a real
    save until this passes on every file we have."""
    ok = bad = 0
    for p in paths:
        try:
            blob, how = decompress(open(p, 'rb').read())
            name, root = parse(blob)
            again = serialise(name, root)
        except Exception as exc:
            print('  ERROR %-44s %s' % (os.path.basename(p), exc))
            bad += 1
            continue
        if again == blob:
            ok += 1
        else:
            bad += 1
            n = min(len(again), len(blob))
            at = next((i for i in range(n) if again[i] != blob[i]), n)
            print('  DIFF  %-44s %d -> %d bytes, first difference at %d'
                  % (os.path.basename(p), len(blob), len(again), at))
    print('round trip: %d byte-identical, %d failed' % (ok, bad))
    return bad == 0


if __name__ == '__main__':
    import glob
    args = sys.argv[1:] or ['naked214/*.dat', '2.0.4chardataexamples/*.dat']
    files = [f for pat in args for f in glob.glob(pat)]
    print('checking %d files' % len(files))
    sys.exit(0 if selftest(files) else 1)
