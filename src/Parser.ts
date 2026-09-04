import {
  Chunk,
  Options as RiffParserOptions,
  parseChunk,
  parseRiff,
} from "./RiffParser.ts";
import {
  Bag,
  GeneratorList,
  Info,
  Instrument,
  ModulatorList,
  PresetHeader,
  SampleHeader,
} from "./Structs.ts";
import Stream from "./Stream.ts";
import { AudioData } from "./AudioData.ts";
import { SoundFont } from "./SoundFont.ts";

export interface ParseResult {
  presetHeaders: PresetHeader[];
  presetZone: Bag[];
  presetModulators: ModulatorList[];
  presetGenerators: GeneratorList[];
  instruments: Instrument[];
  instrumentZone: Bag[];
  instrumentModulators: ModulatorList[];
  instrumentGenerators: GeneratorList[];
  sampleHeaders: SampleHeader[];
  samples: AudioData[];
  samplingData: SamplingData;
  info: Info;
}

export interface SamplingData {
  offsetMSB: number;
  offsetLSB: number | undefined;
}

// parses raw SF2/SF3 bytes into their constituent structures, without
// wrapping them in a SoundFont. Most callers want parse() instead; this is
// for code that only needs the raw data, e.g. write()'s round-trip tests.
export function parseData(
  input: Uint8Array,
  option: RiffParserOptions = {},
): ParseResult {
  // parse RIFF chunk
  const chunkList = parseRiff(input, 0, input.length, option);

  if (chunkList.length !== 1) {
    throw new Error("wrong chunk length");
  }

  const chunk = chunkList[0];
  if (chunk === null) {
    throw new Error("chunk not found");
  }

  function parseRiffChunk(
    chunk: Chunk,
    data: Uint8Array,
    option: RiffParserOptions = {},
  ) {
    const chunkList = getChunkList(chunk, data, "RIFF", "sfbk", option);

    if (chunkList.length !== 3) {
      throw new Error("invalid sfbk structure");
    }

    const info = parseInfoList(chunkList[0], data);
    const isSF3 = info.version.major === 3;
    if (isSF3 && chunkList[2].type !== "LIST") { // remove padding
      chunkList[2] = parseChunk(data, chunkList[2].offset - 9, false);
    }
    return {
      // INFO-list
      info,

      // sdta-list
      samplingData: parseSdtaList(chunkList[1], data),

      // pdta-list
      ...parsePdtaList(chunkList[2], data, isSF3),
    };
  }

  function parsePdtaList(chunk: Chunk, data: Uint8Array, isSF3: boolean) {
    const chunkList = getChunkList(chunk, data, "LIST", "pdta");

    // check number of chunks
    if (chunkList.length !== 9) {
      throw new Error("invalid pdta chunk");
    }

    const sampleHeaders = parseShdr(chunkList[8], data, isSF3);

    // Legacy SF3 files (older MuseScore / sf3convert) often omit the 0x10
    // compressed flag in sfSampleType even though the data is Ogg Vorbis.
    // Normalize so re-writes and consumers see a consistent header.
    if (isSF3) {
      for (let i = 0; i < sampleHeaders.length; i++) {
        const h = sampleHeaders[i];
        if (!h.isEnd && (h.sampleType & 0x10) === 0) {
          h.sampleType = h.sampleType | 0x10;
        }
      }
    }

    return {
      presetHeaders: parsePhdr(chunkList[0], data),
      presetZone: parsePbag(chunkList[1], data),
      presetModulators: parsePmod(chunkList[2], data),
      presetGenerators: parsePgen(chunkList[3], data),
      instruments: parseInst(chunkList[4], data),
      instrumentZone: parseIbag(chunkList[5], data),
      instrumentModulators: parseImod(chunkList[6], data),
      instrumentGenerators: parseIgen(chunkList[7], data),
      sampleHeaders,
    };
  }

  const result = parseRiffChunk(chunk, input, option);
  const isSF3 = result.info.version.major === 3;

  return {
    ...result,
    samples: createLazySamples(
      result.sampleHeaders,
      result.samplingData.offsetMSB,
      result.samplingData.offsetLSB,
      input,
      isSF3,
    ),
  };
}

function getChunkList(
  chunk: Chunk,
  data: Uint8Array,
  expectedType: string,
  expectedSignature: string,
  option: RiffParserOptions = {},
) {
  // check parse target
  if (chunk.type !== expectedType) {
    throw new Error("invalid chunk type:" + chunk.type);
  }

  const stream = new Stream(data, chunk.offset);

  // check signature
  const signature = stream.readString(4);
  if (signature !== expectedSignature) {
    throw new Error("invalid signature:" + signature);
  }

  // read structure
  return parseRiff(data, stream.offset, chunk.size - 4, option);
}

function parseInfoList(chunk: Chunk, data: Uint8Array) {
  const chunkList = getChunkList(chunk, data, "LIST", "INFO");
  return Info.parse(data, chunkList);
}

function parseSdtaList(chunk: Chunk, data: Uint8Array): SamplingData {
  const chunkList = getChunkList(chunk, data, "LIST", "sdta");

  return {
    offsetMSB: chunkList[0].offset,
    offsetLSB: chunkList[1]?.offset,
  };
}

function parseChunkObjects<T>(
  chunk: Chunk,
  data: Uint8Array,
  type: string,
  clazz: { parse: (stream: Stream, isSF3?: boolean) => T },
  terminate?: (obj: T) => boolean,
  isSF3?: boolean,
): T[] {
  const result: T[] = [];

  if (chunk.type !== type) {
    throw new Error("invalid chunk type:" + chunk.type);
  }

  const stream = new Stream(data, chunk.offset);
  const size = chunk.offset + chunk.size;

  while (stream.offset < size) {
    const obj = clazz.parse(stream, isSF3);
    if (terminate && terminate(obj)) {
      break;
    }
    result.push(obj);
  }

  return result;
}

const parsePhdr = (chunk: Chunk, data: Uint8Array) =>
  parseChunkObjects(chunk, data, "phdr", PresetHeader, (p) => p.isEnd);
const parsePbag = (chunk: Chunk, data: Uint8Array) =>
  parseChunkObjects(chunk, data, "pbag", Bag);
const parseInst = (chunk: Chunk, data: Uint8Array) =>
  parseChunkObjects(chunk, data, "inst", Instrument, (i) => i.isEnd);
const parseIbag = (chunk: Chunk, data: Uint8Array) =>
  parseChunkObjects(chunk, data, "ibag", Bag);
const parsePmod = (chunk: Chunk, data: Uint8Array) =>
  parseChunkObjects(chunk, data, "pmod", ModulatorList);
const parseImod = (chunk: Chunk, data: Uint8Array) =>
  parseChunkObjects(chunk, data, "imod", ModulatorList);
const parsePgen = (chunk: Chunk, data: Uint8Array) =>
  parseChunkObjects(chunk, data, "pgen", GeneratorList, (g) => g.isEnd);
const parseIgen = (chunk: Chunk, data: Uint8Array) =>
  parseChunkObjects(chunk, data, "igen", GeneratorList);
const parseShdr = (chunk: Chunk, data: Uint8Array, isSF3: boolean) =>
  parseChunkObjects(chunk, data, "shdr", SampleHeader, (s) => s.isEnd, isSF3);

// Builds an AudioData[] that materializes each entry on first index access
// (getVoice / write / samples[i]). Parse only stores headers + a view into
// the original buffer; individual sample subarrays and AudioData wrappers
// are created the first time that index is read, then replaced with a plain
// data property so later reads are a normal array load.
function createLazySamples(
  sampleHeader: SampleHeader[],
  samplingDataOffsetMSB: number,
  samplingDataOffsetLSB: number | undefined,
  data: Uint8Array,
  isSF3: boolean,
): AudioData[] {
  const n = sampleHeader.length;
  const factor = isSF3 ? 1 : 2;
  const type = isSF3 ? "compressed" : samplingDataOffsetLSB ? "pcm24" : "pcm16";
  const samples = new Array<AudioData>(n);

  for (let i = 0; i < n; i++) {
    Object.defineProperty(samples, i, {
      configurable: true,
      enumerable: true,
      get() {
        const { start, end } = sampleHeader[i];
        const startOffset = samplingDataOffsetMSB + start * factor;
        const endOffset = samplingDataOffsetMSB + end * factor;
        const sample = new AudioData(
          type,
          sampleHeader[i],
          data.subarray(startOffset, endOffset),
        );
        // Replace this getter with a data property for subsequent access.
        Object.defineProperty(samples, i, {
          value: sample,
          writable: true,
          enumerable: true,
          configurable: true,
        });
        return sample;
      },
      set(value: AudioData) {
        Object.defineProperty(samples, i, {
          value,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      },
    });
  }

  return samples;
}

// parses raw SF2/SF3 bytes into a SoundFont, ready for voice lookup
// (getVoice()) and, if needed, editing + write().
export function parse(
  input: Uint8Array,
  option: RiffParserOptions = {},
): SoundFont {
  return new SoundFont(parseData(input, option));
}
