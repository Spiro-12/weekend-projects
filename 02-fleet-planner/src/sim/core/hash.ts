// State hash (PROTOCOL §1, §5): FNV-1a over the canonical integer state, two 32-bit lanes (16 hex digits).
// Every value must be a safe integer; anything else throws, so a stray fraction in sim state fails loudly.

export class StateHasher {
  private a = 0x811c9dc5;
  private b = 0x2c9277b5;
  words = 0;

  add(v: number): void {
    if (!Number.isSafeInteger(v)) throw new Error(`hash(): non-integer state value ${v} (word ${this.words})`);
    const lo = v >>> 0;
    const hi = Math.floor(v / 4294967296) >>> 0;
    this.word(lo);
    this.word(hi);
    this.words++;
  }

  addAll(list: ArrayLike<number>): void {
    this.add(list.length);
    for (let i = 0; i < list.length; i++) this.add(list[i]);
  }

  private word(w: number): void {
    let a = this.a;
    let b = this.b;
    // lane a: bytes low to high; lane b: high to low (a different byte order, so the lanes don't move together)
    a = Math.imul(a ^ (w & 0xff), 0x01000193);
    a = Math.imul(a ^ ((w >>> 8) & 0xff), 0x01000193);
    a = Math.imul(a ^ ((w >>> 16) & 0xff), 0x01000193);
    a = Math.imul(a ^ (w >>> 24), 0x01000193);
    b = Math.imul(b ^ (w >>> 24), 0x01000193);
    b = Math.imul(b ^ ((w >>> 16) & 0xff), 0x01000193);
    b = Math.imul(b ^ ((w >>> 8) & 0xff), 0x01000193);
    b = Math.imul(b ^ (w & 0xff), 0x01000193);
    this.a = a;
    this.b = b;
  }

  digest(): string {
    return (this.a >>> 0).toString(16).padStart(8, '0') + (this.b >>> 0).toString(16).padStart(8, '0');
  }
}
