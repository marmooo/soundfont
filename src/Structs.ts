import { GeneratorKeys } from "./Constants.ts";
import { ModulatorSource } from "./Modulator.ts";
import Stream from "./Stream.ts";
import WriteStream from "./WriteStream.ts";
import { Chunk } from "./RiffParser.ts";
import { writeChunk } from "./RiffWriter.ts";

export class VersionTag {
  constructor(
    public major: number,
    public minor: number,
  ) {}

  static parse(stream: Stream) {
    const major = stream.readWORD();
    const minor = stream.readWORD();
    return new VersionTag(major, minor);
  }

  write(stream: WriteStream) {
    stream.writeWORD(this.major);
    stream.writeWORD(this.minor);
  }
}

export class Info {
  constructor(
    public comment: string | null,
    public copyright: string | null,
    public creationDate: string | null,
    public engineer: string | null,
    public name: string,
    public product: string | null,
    public software: string | null,
    public version: VersionTag,
    public soundEngine: string,
    public romName: string | null,
    public romVersion: VersionTag | null,
  ) {}

  static parse(data: Uint8Array, chunks: Chunk[]) {
    function getChunk(type: string) {
      for (let i = 0; i < chunks.length; i++) {
        if (chunks[i].type === type) return chunks[i];
      }
      return undefined;
    }

    function toStream(chunk: Chunk) {
      return new Stream(data, chunk.offset);
    }

    function readString(type: string) {
      const chunk = getChunk(type);
      if (!chunk) return null;
      return toStream(chunk).readString(chunk.size);
    }

    function readVersionTag(type: string) {
      const chunk = getChunk(type);
      if (!chunk) return null;
      return VersionTag.parse(toStream(chunk));
    }

    const comment = readString("ICMT");
    const copyright = readString("ICOP");
    const creationDate = readString("ICRD");
    const engineer = readString("IENG");
    const name = readString("INAM")!;
    const product = readString("IPRD");
    const software = readString("ISFT");
    const version = readVersionTag("ifil")!;
    const soundEngine = readString("isng")!;
    const romName = readString("irom");
    const romVersion = readVersionTag("iver");
    return new Info(
      comment,
      copyright,
      creationDate,
      engineer,
      name,
      product,
      software,
      version,
      soundEngine,
      romName,
      romVersion,
    );
  }

  // returns the already-serialized sub-chunks of the INFO-list, in spec order
  write(version: VersionTag = this.version): Uint8Array[] {
    function stringChunk(type: string, value: string | null) {
      if (value === null) return null;
      const stream = new WriteStream();
      stream.writeZString(value);
      // Polyphone's INFO reader advances by `8 + size` and does NOT skip the
      // RIFF pad byte for odd-sized chunks. Pad the payload itself to an even
      // length (extra NUL) so size is even and no external pad is inserted.
      // This matches Polyphone's own writer output.
      const bytes = stream.toUint8Array();
      if ((bytes.length & 1) === 1) {
        const even = new Uint8Array(bytes.length + 1);
        even.set(bytes);
        return writeChunk(type, even);
      }
      return writeChunk(type, bytes);
    }

    function versionChunk(type: string, value: VersionTag | null) {
      if (value === null) return null;
      const stream = new WriteStream(4);
      value.write(stream);
      return writeChunk(type, stream.toUint8Array());
    }

    const chunks = [
      versionChunk("ifil", version),
      stringChunk("isng", this.soundEngine),
      stringChunk("INAM", this.name),
      stringChunk("irom", this.romName),
      versionChunk("iver", this.romVersion),
      stringChunk("ICRD", this.creationDate),
      stringChunk("IENG", this.engineer),
      stringChunk("IPRD", this.product),
      stringChunk("ICOP", this.copyright),
      stringChunk("ICMT", this.comment),
      stringChunk("ISFT", this.software),
    ];

    const result: Uint8Array[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (chunk !== null) result.push(chunk);
    }
    return result;
  }
}

export class Bag {
  constructor(
    public generatorIndex: number,
    public modulatorIndex: number,
  ) {}

  static parse(stream: Stream) {
    const generatorIndex = stream.readWORD();
    const modulatorIndex = stream.readWORD();
    return new Bag(generatorIndex, modulatorIndex);
  }

  write(stream: WriteStream) {
    stream.writeWORD(this.generatorIndex);
    stream.writeWORD(this.modulatorIndex);
  }
}

export class PresetHeader {
  constructor(
    public presetName: string,
    public preset: number,
    public bank: number,
    public presetBagIndex: number,
    public library: number,
    public genre: number,
    public morphology: number,
  ) {}

  get isEnd() {
    const { presetName, preset, bank, library, genre, morphology } = this;
    return (presetName === "EOP") ||
      presetName === "" && preset + bank + library + genre + morphology === 0;
  }

  static parse(stream: Stream) {
    const presetName = stream.readString(20);
    const preset = stream.readWORD();
    const bank = stream.readWORD();
    const presetBagIndex = stream.readWORD();
    const library = stream.readDWORD();
    const genre = stream.readDWORD();
    const morphology = stream.readDWORD();
    return new PresetHeader(
      presetName,
      preset,
      bank,
      presetBagIndex,
      library,
      genre,
      morphology,
    );
  }

  // terminal "EOP" record, marks the end of the phdr sub-chunk
  static end(presetBagIndex: number) {
    return new PresetHeader("EOP", 0, 0, presetBagIndex, 0, 0, 0);
  }

  write(stream: WriteStream) {
    stream.writeString(this.presetName, 20);
    stream.writeWORD(this.preset);
    stream.writeWORD(this.bank);
    stream.writeWORD(this.presetBagIndex);
    stream.writeDWORD(this.library);
    stream.writeDWORD(this.genre);
    stream.writeDWORD(this.morphology);
  }
}

export class RangeValue {
  lo: number;
  hi: number;

  constructor(lo: number, hi: number) {
    this.lo = lo;
    this.hi = hi;
  }

  in(value: number) {
    return (this.lo <= value && value <= this.hi);
  }

  static parse(stream: Stream) {
    const lo = stream.readByte();
    const hi = stream.readByte();
    return new RangeValue(lo, hi);
  }
}

export class ModulatorList {
  constructor(
    public sourceOper: ModulatorSource,
    public destinationOper: number,
    public amount: number,
    public amountSourceOper: ModulatorSource,
    public transOper: number,
  ) {}

  transform(inputValue: number): number {
    const newValue = this.amount * inputValue;
    switch (this.transOper) {
      case 0:
        return newValue;
      case 2:
        return Math.abs(newValue);
      default:
        return newValue;
    }
  }

  static parse(stream: Stream) {
    const source = stream.readWORD();
    const destinationOper = stream.readWORD();
    const value = stream.readInt16();
    const amountSource = stream.readWORD();
    const transOper = stream.readWORD();
    const sourceOper = ModulatorSource.parse(source);
    const amountSourceOper = ModulatorSource.parse(amountSource);
    return new ModulatorList(
      sourceOper,
      destinationOper,
      value,
      amountSourceOper,
      transOper,
    );
  }

  // terminal record, marks the end of the pmod/imod sub-chunk
  static end() {
    return new ModulatorList(
      ModulatorSource.parse(0),
      0,
      0,
      ModulatorSource.parse(0),
      0,
    );
  }

  write(stream: WriteStream) {
    stream.writeWORD(this.sourceOper.toValue());
    stream.writeWORD(this.destinationOper);
    stream.writeInt16(this.amount);
    stream.writeWORD(this.amountSourceOper.toValue());
    stream.writeWORD(this.transOper);
  }
}

export class GeneratorList {
  constructor(
    public code: number,
    public value: number | RangeValue,
  ) {}

  get type() {
    return GeneratorKeys[this.code];
  }

  get isEnd() {
    return this.code === 0 && this.value === 0;
  }

  static parse(stream: Stream) {
    const code = stream.readWORD();
    const type = GeneratorKeys[code];

    let value: number | RangeValue;
    switch (type) {
      case "keyRange":
      case "velRange":
        value = RangeValue.parse(stream);
        break;
      case "instrument":
      case "sampleID":
        value = stream.readUInt16();
        break;
      default:
        value = stream.readInt16();
        break;
    }

    return new GeneratorList(code, value);
  }

  // terminal record, marks the end of the pgen/igen sub-chunk
  static end() {
    return new GeneratorList(0, 0);
  }

  write(stream: WriteStream) {
    stream.writeWORD(this.code);
    const type = this.type;
    if (this.value instanceof RangeValue) {
      stream.writeByte(this.value.lo);
      stream.writeByte(this.value.hi);
    } else if (type === "instrument" || type === "sampleID") {
      stream.writeUInt16(this.value);
    } else {
      stream.writeInt16(this.value);
    }
  }
}

export class Instrument {
  instrumentName!: string;
  instrumentBagIndex!: number;

  get isEnd() {
    return this.instrumentName === "EOI";
  }

  static parse(stream: Stream) {
    const t = new Instrument();
    t.instrumentName = stream.readString(20);
    t.instrumentBagIndex = stream.readWORD();
    return t;
  }

  // terminal "EOI" record, marks the end of the inst sub-chunk
  static end(instrumentBagIndex: number) {
    const t = new Instrument();
    t.instrumentName = "EOI";
    t.instrumentBagIndex = instrumentBagIndex;
    return t;
  }

  write(stream: WriteStream) {
    stream.writeString(this.instrumentName, 20);
    stream.writeWORD(this.instrumentBagIndex);
  }
}

export class SampleHeader {
  constructor(
    public sampleName: string,
    public start: number,
    public end: number,
    public loopStart: number,
    public loopEnd: number,
    public sampleRate: number,
    public originalPitch: number,
    public pitchCorrection: number,
    public sampleLink: number,
    public sampleType: number,
  ) {}

  get isEnd() {
    // Accept both the common "EOS" sentinel and a fully zeroed record
    // (what Polyphone and some other writers emit).
    if (this.sampleName === "EOS") return true;
    return this.sampleName === "" &&
      this.start === 0 && this.end === 0 &&
      this.loopStart === 0 && this.loopEnd === 0 &&
      this.sampleRate === 0 && this.originalPitch === 0 &&
      this.pitchCorrection === 0 && this.sampleLink === 0 &&
      this.sampleType === 0;
  }

  static parse(stream: Stream, isSF3?: boolean) {
    const sampleName = stream.readString(20);
    const start = stream.readDWORD();
    const end = stream.readDWORD();
    let loopStart = stream.readDWORD();
    let loopEnd = stream.readDWORD();
    const sampleRate = stream.readDWORD();
    const originalPitch = stream.readByte();
    const pitchCorrection = stream.readInt8();
    const sampleLink = stream.readWORD();
    const sampleType = stream.readWORD();

    if (!isSF3) {
      loopStart -= start;
      loopEnd -= start;
    }

    return new SampleHeader(
      sampleName,
      start,
      end,
      loopStart,
      loopEnd,
      sampleRate,
      originalPitch,
      pitchCorrection,
      sampleLink,
      sampleType,
    );
  }

  // terminal record for the shdr sub-chunk.
  // Empty name matches Polyphone / SF2 terminal convention used by several
  // tools; "EOS" is still accepted by isEnd when reading older files.
  static end() {
    return new SampleHeader("", 0, 0, 0, 0, 0, 0, 0, 0, 0);
  }

  write(stream: WriteStream, isSF3?: boolean) {
    stream.writeString(this.sampleName, 20);
    stream.writeDWORD(this.start);
    stream.writeDWORD(this.end);
    if (isSF3) {
      stream.writeDWORD(this.loopStart);
      stream.writeDWORD(this.loopEnd);
    } else {
      stream.writeDWORD(this.loopStart + this.start);
      stream.writeDWORD(this.loopEnd + this.start);
    }
    stream.writeDWORD(this.sampleRate);
    stream.writeByte(this.originalPitch);
    stream.writeInt8(this.pitchCorrection);
    stream.writeWORD(this.sampleLink);
    stream.writeWORD(this.sampleType);
  }
}

export const SampleLink = {
  monoSample: 1,
  rightSample: 2,
  leftSample: 4,
  linkedSample: 8,
  RomMonoSample: 0x8001,
  RomRightSample: 0x8002,
  RomLeftSample: 0x8004,
  RomLinkedSample: 0x8008,
};

export class BoundedValue {
  min: number;
  max: number;
  defaultValue: number;

  constructor(min: number, defaultValue: number, max: number) {
    this.min = min;
    this.defaultValue = defaultValue;
    this.max = max;
  }

  clamp(value: number): number {
    return Math.max(this.min, Math.min(value, this.max));
  }
}
