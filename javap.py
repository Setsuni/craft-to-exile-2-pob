#!/usr/bin/env python3
"""
Small class-file disassembler that resolves constant-pool references.

The earlier version only printed pushed constants, which hides the call
sequence - and for Mine & Slash the interesting logic *is* the call sequence
(lerp -> scale -> clamp). This one prints invokes and field access too.
"""
import struct, sys


class CP:
    def __init__(self, r):
        self.e = {}
        n = r.u2()
        i = 1
        while i < n:
            t = r.u1()
            if t == 1:
                self.e[i] = ('Utf8', r.take(r.u2()).decode('utf-8', 'replace'))
            elif t == 3:
                self.e[i] = ('Int', struct.unpack('>i', r.take(4))[0])
            elif t == 4:
                self.e[i] = ('Float', struct.unpack('>f', r.take(4))[0])
            elif t == 5:
                self.e[i] = ('Long', struct.unpack('>q', r.take(8))[0]); i += 1
            elif t == 6:
                self.e[i] = ('Double', struct.unpack('>d', r.take(8))[0]); i += 1
            elif t in (7, 8, 16, 19, 20):
                self.e[i] = ({7: 'Class', 8: 'String'}.get(t, 'Ref1'), r.u2())
            elif t == 15:
                self.e[i] = ('MH', (r.u1(), r.u2()))
            elif t in (9, 10, 11, 12, 17, 18):
                self.e[i] = ({9: 'Field', 10: 'Method', 11: 'IMethod',
                              12: 'NameType'}.get(t, 'Dyn'), (r.u2(), r.u2()))
            else:
                raise Exception('cp tag %d' % t)
            i += 1

    def utf(self, i):
        v = self.e.get(i)
        return v[1] if v and v[0] == 'Utf8' else '#%d' % i

    def cls(self, i):
        v = self.e.get(i)
        return self.utf(v[1]).split('/')[-1] if v and v[0] == 'Class' else '#%d' % i

    def ref(self, i):
        v = self.e.get(i)
        if not v or v[0] not in ('Field', 'Method', 'IMethod', 'Dyn'):
            return '#%d' % i
        ci, nti = v[1]
        nt = self.e.get(nti)
        if nt and nt[0] == 'NameType':
            name = self.utf(nt[1][0])
            desc = self.utf(nt[1][1])
        else:
            name, desc = '?', '?'
        if v[0] == 'Dyn':
            return '%s%s' % (name, desc)
        return '%s.%s%s' % (self.cls(ci), name, desc)

    def const(self, i):
        v = self.e.get(i)
        if not v:
            return '#%d' % i
        if v[0] == 'String':
            return repr(self.utf(v[1]))
        if v[0] == 'Class':
            return self.cls(i)
        return repr(v[1])


class R:
    def __init__(self, b):
        self.b = b
        self.i = 0

    def take(self, n):
        v = self.b[self.i:self.i + n]
        self.i += n
        return v

    def u1(self):
        return self.take(1)[0]

    def u2(self):
        return struct.unpack('>H', self.take(2))[0]

    def u4(self):
        return struct.unpack('>I', self.take(4))[0]


OPS = {
    0x02: 'iconst_m1', 0x03: 'iconst_0', 0x04: 'iconst_1', 0x05: 'iconst_2',
    0x06: 'iconst_3', 0x07: 'iconst_4', 0x08: 'iconst_5', 0x09: 'lconst_0',
    0x0a: 'lconst_1', 0x0b: 'fconst_0', 0x0c: 'fconst_1', 0x0d: 'fconst_2',
    0x0e: 'dconst_0', 0x0f: 'dconst_1', 0x10: 'bipush', 0x11: 'sipush',
    0x12: 'ldc', 0x13: 'ldc_w', 0x14: 'ldc2_w', 0x1a: 'iload_0', 0x1b: 'iload_1',
    0x1c: 'iload_2', 0x22: 'fload_0', 0x23: 'fload_1', 0x24: 'fload_2',
    0x25: 'fload_3', 0x2a: 'aload_0', 0x2b: 'aload_1', 0x2c: 'aload_2',
    0x60: 'iadd', 0x62: 'fadd', 0x64: 'isub', 0x66: 'fsub', 0x68: 'imul',
    0x6a: 'fmul', 0x6c: 'idiv', 0x6e: 'fdiv', 0x86: 'i2f', 0x8b: 'f2i',
    0xac: 'ireturn', 0xae: 'freturn', 0xb0: 'areturn', 0xb1: 'return',
    0xb2: 'getstatic', 0xb3: 'putstatic', 0xb4: 'getfield', 0xb5: 'putfield',
    0xb6: 'invokevirtual', 0xb7: 'invokespecial', 0xb8: 'invokestatic',
    0xb9: 'invokeinterface', 0xba: 'invokedynamic', 0xbb: 'new',
    0xbc: 'newarray', 0xbd: 'anewarray', 0xc0: 'checkcast', 0x59: 'dup',
    0x99: 'ifeq', 0x9a: 'ifne', 0xa7: 'goto', 0x57: 'pop',
}
OPLEN = {0x10: 1, 0x11: 2, 0x12: 1, 0x13: 2, 0x14: 2, 0xbc: 1,
         0xb2: 2, 0xb3: 2, 0xb4: 2, 0xb5: 2, 0xb6: 2, 0xb7: 2, 0xb8: 2,
         0xb9: 4, 0xba: 4, 0xbb: 2, 0xbd: 2, 0xc0: 2, 0xc1: 2,
         0x15: 1, 0x16: 1, 0x17: 1, 0x18: 1, 0x19: 1, 0x36: 1, 0x37: 1,
         0x38: 1, 0x39: 1, 0x3a: 1, 0x84: 2, 0x99: 2, 0x9a: 2, 0x9b: 2,
         0x9c: 2, 0x9d: 2, 0x9e: 2, 0x9f: 2, 0xa0: 2, 0xa1: 2, 0xa2: 2,
         0xa3: 2, 0xa4: 2, 0xa5: 2, 0xa6: 2, 0xa7: 2, 0xc5: 3, 0xc6: 2, 0xc7: 2}


def disasm(path, only=None):
    b = open(path, 'rb').read()
    r = R(b)
    assert r.u4() == 0xCAFEBABE
    r.u2(); r.u2()
    cp = CP(r)
    r.u2(); r.u2(); r.u2()
    for _ in range(r.u2()):
        r.u2()

    def attrs():
        out = []
        for _ in range(r.u2()):
            nm = cp.utf(r.u2())
            ln = r.u4()
            out.append((nm, r.take(ln)))
        return out

    for _ in range(r.u2()):
        r.u2(); r.u2(); r.u2(); attrs()

    for _ in range(r.u2()):
        r.u2()
        name = cp.utf(r.u2())
        desc = cp.utf(r.u2())
        for an, ab in attrs():
            if an != 'Code':
                continue
            if only and only not in name:
                continue
            cr = R(ab)
            cr.u2(); cr.u2()
            code = cr.take(cr.u4())
            print('\n%s%s' % (name, desc))
            i = 0
            while i < len(code):
                pc = i
                op = code[i]; i += 1
                n = OPLEN.get(op, 0)
                operand = code[i:i + n]; i += n
                mn = OPS.get(op, 'op_%02x' % op)
                arg = ''
                if op in (0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba):
                    arg = cp.ref(struct.unpack('>H', operand[:2])[0])
                elif op in (0xbb, 0xbd, 0xc0):
                    arg = cp.cls(struct.unpack('>H', operand[:2])[0])
                elif op == 0x12:
                    arg = cp.const(operand[0])
                elif op in (0x13, 0x14):
                    arg = cp.const(struct.unpack('>H', operand)[0])
                elif op == 0x10:
                    arg = str(struct.unpack('>b', operand)[0])
                elif op == 0x11:
                    arg = str(struct.unpack('>h', operand)[0])
                elif n:
                    arg = str(int.from_bytes(operand, 'big'))
                print('   %4d  %-16s %s' % (pc, mn, arg))


if __name__ == '__main__':
    disasm(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
