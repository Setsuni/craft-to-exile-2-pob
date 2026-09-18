#!/usr/bin/env python3
"""Minimal NBT reader (stdlib only) - enough to read Minecraft playerdata."""
import gzip, json, struct, zlib

TAG_END, TAG_BYTE, TAG_SHORT, TAG_INT, TAG_LONG = 0, 1, 2, 3, 4
TAG_FLOAT, TAG_DOUBLE, TAG_BYTE_ARRAY, TAG_STRING = 5, 6, 7, 8
TAG_LIST, TAG_COMPOUND, TAG_INT_ARRAY, TAG_LONG_ARRAY = 9, 10, 11, 12


class Reader:
    def __init__(self, buf):
        self.b = buf
        self.i = 0

    def raw(self, n):
        v = self.b[self.i:self.i + n]
        if len(v) != n:
            raise EOFError('truncated NBT')
        self.i += n
        return v

    def u1(self):
        return self.raw(1)[0]

    def i1(self):
        return struct.unpack('>b', self.raw(1))[0]

    def i2(self):
        return struct.unpack('>h', self.raw(2))[0]

    def u2(self):
        return struct.unpack('>H', self.raw(2))[0]

    def i4(self):
        return struct.unpack('>i', self.raw(4))[0]

    def i8(self):
        return struct.unpack('>q', self.raw(8))[0]

    def f4(self):
        return struct.unpack('>f', self.raw(4))[0]

    def f8(self):
        return struct.unpack('>d', self.raw(8))[0]

    def string(self):
        return self.raw(self.u2()).decode('utf-8', 'replace')

    def payload(self, t):
        if t == TAG_BYTE:
            return self.i1()
        if t == TAG_SHORT:
            return self.i2()
        if t == TAG_INT:
            return self.i4()
        if t == TAG_LONG:
            return self.i8()
        if t == TAG_FLOAT:
            return self.f4()
        if t == TAG_DOUBLE:
            return self.f8()
        if t == TAG_BYTE_ARRAY:
            return list(self.raw(self.i4()))
        if t == TAG_STRING:
            return self.string()
        if t == TAG_LIST:
            it = self.u1()
            n = self.i4()
            return [self.payload(it) for _ in range(n)] if n > 0 else []
        if t == TAG_COMPOUND:
            out = {}
            while True:
                tt = self.u1()
                if tt == TAG_END:
                    return out
                # Name must be read before payload; assigning in one statement
                # would evaluate the right-hand side first and desync the stream.
                name = self.string()
                out[name] = self.payload(tt)
        if t == TAG_INT_ARRAY:
            return [self.i4() for _ in range(self.i4())]
        if t == TAG_LONG_ARRAY:
            return [self.i8() for _ in range(self.i4())]
        raise ValueError('unknown tag %d' % t)


def decompress(data):
    if data[:2] == b'\x1f\x8b':
        return gzip.decompress(data)
    if data[:1] == b'\x78':
        return zlib.decompress(data)
    return data


def load(path):
    raw = decompress(open(path, 'rb').read())
    r = Reader(raw)
    t = r.u1()
    if t != TAG_COMPOUND:
        raise ValueError('root is not a compound (tag %d)' % t)
    r.string()  # root name, conventionally empty
    return r.payload(TAG_COMPOUND)


def walk(obj, path=''):
    """Yield (path, value) for every leaf."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield from walk(v, path + '/' + k)
    elif isinstance(obj, list) and obj and isinstance(obj[0], (dict, list)):
        for idx, v in enumerate(obj):
            yield from walk(v, '%s[%d]' % (path, idx))
    else:
        yield path, obj


if __name__ == '__main__':
    import sys
    print(json.dumps(load(sys.argv[1]), indent=1, default=str)[:4000])
