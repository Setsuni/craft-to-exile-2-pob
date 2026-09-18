/* ---- reading a Minecraft .dat in the browser -----------------------------

   So a player can point the page at their own `pob_export.dat` instead of
   installing Python and running the exporter by hand. The file is gzipped NBT;
   both halves are small enough to do here.

   This is a port of nbt.py. The one thing worth knowing about the format: a
   tag's NAME is read before its PAYLOAD, so the two cannot be fetched in one
   expression - JavaScript would evaluate them right-to-left and desync the
   stream for every tag that follows.
*/
const NBT = (() => {
  const END = 0, BYTE = 1, SHORT = 2, INT = 3, LONG = 4, FLOAT = 5, DOUBLE = 6,
        BYTE_ARRAY = 7, STRING = 8, LIST = 9, COMPOUND = 10,
        INT_ARRAY = 11, LONG_ARRAY = 12;

  function Reader(buf) {
    this.d = new DataView(buf);
    this.b = new Uint8Array(buf);
    this.i = 0;
  }
  Reader.prototype = {
    need(n) { if (this.i + n > this.b.length) throw new Error('truncated NBT'); },
    u1() { this.need(1); return this.b[this.i++]; },
    i1() { this.need(1); return this.d.getInt8(this.i++); },
    i2() { this.need(2); const v = this.d.getInt16(this.i); this.i += 2; return v; },
    u2() { this.need(2); const v = this.d.getUint16(this.i); this.i += 2; return v; },
    i4() { this.need(4); const v = this.d.getInt32(this.i); this.i += 4; return v; },
    i8() { this.need(8); const v = this.d.getBigInt64(this.i); this.i += 8; return Number(v); },
    f4() { this.need(4); const v = this.d.getFloat32(this.i); this.i += 4; return v; },
    f8() { this.need(8); const v = this.d.getFloat64(this.i); this.i += 8; return v; },
    str() {
      const n = this.u2();
      this.need(n);
      const s = new TextDecoder('utf-8').decode(this.b.subarray(this.i, this.i + n));
      this.i += n;
      return s;
    },
    payload(t) {
      switch (t) {
        case BYTE: return this.i1();
        case SHORT: return this.i2();
        case INT: return this.i4();
        case LONG: return this.i8();
        case FLOAT: return this.f4();
        case DOUBLE: return this.f8();
        case BYTE_ARRAY: {
          const n = this.i4(); this.need(n);
          const a = Array.from(this.b.subarray(this.i, this.i + n));
          this.i += n; return a;
        }
        case STRING: return this.str();
        case LIST: {
          const it = this.u1(), n = this.i4();
          const out = [];
          for (let k = 0; k < n; k++) out.push(this.payload(it));
          return out;
        }
        case COMPOUND: {
          const out = {};
          for (;;) {
            const tt = this.u1();
            if (tt === END) return out;
            /* Name first, then payload - see the note at the top. */
            const name = this.str();
            out[name] = this.payload(tt);
          }
        }
        case INT_ARRAY: {
          const n = this.i4(), out = [];
          for (let k = 0; k < n; k++) out.push(this.i4());
          return out;
        }
        case LONG_ARRAY: {
          const n = this.i4(), out = [];
          for (let k = 0; k < n; k++) out.push(this.i8());
          return out;
        }
        default: throw new Error('unknown NBT tag ' + t);
      }
    },
  };

  async function gunzip(buf) {
    const u8 = new Uint8Array(buf);
    if (u8[0] !== 0x1f || u8[1] !== 0x8b) return buf;      // already plain
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('This browser cannot un-gzip the file. Chrome, Edge, '
        + 'Firefox 113+ and Safari 16.4+ all can.');
    }
    const ds = new DecompressionStream('gzip');
    const stream = new Blob([buf]).stream().pipeThrough(ds);
    return await new Response(stream).arrayBuffer();
  }

  async function parse(arrayBuffer) {
    const raw = await gunzip(arrayBuffer);
    const r = new Reader(raw);
    const t = r.u1();
    if (t !== COMPOUND) throw new Error('root is not a compound (tag ' + t + ')');
    r.str();                                    // root name, conventionally empty
    return r.payload(COMPOUND);
  }

  /* Mine & Slash stores JSON inside NBT strings. */
  function jload(v) {
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch (e) { return null; }
  }

  return { parse, jload, Reader };
})();

if (typeof module !== 'undefined') module.exports = NBT;
