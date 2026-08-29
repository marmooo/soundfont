export default class WriteStream {
  private data: Uint8Array;
  public offset: number = 0;

  constructor(initialSize: number = 1024) {
    this.data = new Uint8Array(initialSize);
  }

  private ensure(size: number) {
    const required = this.offset + size;
    if (required <= this.data.length) return;
    let newSize = this.data.length * 2;
    while (newSize < required) newSize *= 2;
    const newData = new Uint8Array(newSize);
    newData.set(this.data);
    this.data = newData;
  }

  writeBytes(bytes: Uint8Array) {
    this.ensure(bytes.length);
    this.data.set(bytes, this.offset);
    this.offset += bytes.length;
  }

  // fixed-length, zero-padded string (used by phdr/inst/shdr, 20 bytes)
  writeString(value: string, size: number) {
    this.ensure(size);
    const length = Math.min(value.length, size);
    for (let i = 0; i < length; i++) {
      this.data[this.offset++] = value.charCodeAt(i);
    }
    for (let i = length; i < size; i++) {
      this.data[this.offset++] = 0;
    }
  }

  // null-terminated string of arbitrary length (used by INFO chunks)
  writeZString(value: string) {
    this.ensure(value.length + 1);
    for (let i = 0; i < value.length; i++) {
      this.data[this.offset++] = value.charCodeAt(i);
    }
    this.data[this.offset++] = 0;
  }

  writeByte(value: number) {
    this.ensure(1);
    this.data[this.offset++] = value & 0xff;
  }

  writeWORD(value: number) {
    this.ensure(2);
    this.data[this.offset++] = value & 0xff;
    this.data[this.offset++] = (value >> 8) & 0xff;
  }

  writeDWORD(value: number, bigEndian: boolean = false) {
    this.ensure(4);
    if (bigEndian) {
      this.data[this.offset++] = (value >>> 24) & 0xff;
      this.data[this.offset++] = (value >>> 16) & 0xff;
      this.data[this.offset++] = (value >>> 8) & 0xff;
      this.data[this.offset++] = value & 0xff;
    } else {
      this.data[this.offset++] = value & 0xff;
      this.data[this.offset++] = (value >>> 8) & 0xff;
      this.data[this.offset++] = (value >>> 16) & 0xff;
      this.data[this.offset++] = (value >>> 24) & 0xff;
    }
  }

  /* helper */

  writeUInt8(value: number) {
    this.writeByte(value);
  }

  writeInt8(value: number) {
    this.writeByte(value);
  }

  writeUInt16(value: number) {
    this.writeWORD(value);
  }

  writeInt16(value: number) {
    this.writeWORD(value);
  }

  writeUInt32(value: number) {
    this.writeDWORD(value);
  }

  toUint8Array(): Uint8Array {
    return this.data.subarray(0, this.offset);
  }
}
