import type { SoundFont } from "./SoundFont.ts";
import {
  Bag,
  GeneratorList,
  Instrument,
  ModulatorList,
  PresetHeader,
  SampleHeader,
  VersionTag,
} from "./Structs.ts";
import { AudioData } from "./AudioData.ts";
import WriteStream from "./WriteStream.ts";
import { concatChunks, writeChunk, writeListChunk } from "./RiffWriter.ts";

export interface WriteOptions {
  // silent sample frames appended after every sample, so that interpolation
  // during playback never reads past the end of a sample. Ignored for SF3
  // (compressed) samples. Defaults to 46, the value used by most encoders,
  // or 0 when `encode` is given.
  silentFrames?: number;
}

// Compresses one sample's raw 16-bit PCM (mono) into an Ogg Vorbis stream,
// as required for SF3 sample data. This package doesn't bundle an encoder -
// supply one built on e.g. mediabunny, ffmpeg.wasm, or WebCodecs directly.
//
// Most Vorbis encoders only accept a handful of fixed sample rates (8000,
// 11025, 16000, 22050, 32000, 44100, 48000); anything else fails to even
// initialize. If `sampleRate` isn't one your encoder supports, resample the
// PCM yourself and return the rate you actually encoded at via
// SF3EncodeResult - write() will update the sample's stored sample rate
// and loop points to match, so pitch and looping stay correct.
export interface SF3EncodeResult {
  data: Uint8Array;
  // the sample rate `data` was actually encoded at, if different from the
  // `sampleRate` passed in. Defaults to that `sampleRate` when omitted.
  sampleRate?: number;
}

export type SF3Encoder = (
  pcm: Int16Array,
  sampleRate: number,
) =>
  | Uint8Array
  | SF3EncodeResult
  | Promise<Uint8Array | SF3EncodeResult>;

// Decodes one already-compressed (Ogg Vorbis) sample back into 16-bit PCM,
// so it can be re-encoded through `encode` at a different quality. This
// package doesn't bundle a decoder - supply one built on e.g.
// @wasm-audio-decoders/ogg-vorbis, ffmpeg.wasm, or WebCodecs.
export interface SF3DecodeResult {
  pcm: Int16Array;
  // the sample rate the decoder actually produced, if different from the
  // sample's stored sampleRate. Defaults to the stored sampleRate when
  // omitted.
  sampleRate?: number;
}

export type SF3Decoder = (
  data: Uint8Array,
) =>
  | Int16Array
  | SF3DecodeResult
  | Promise<Int16Array | SF3DecodeResult>;

export interface SF3WriteOptions extends WriteOptions {
  encode: SF3Encoder;
  // Decoder for already-compressed (SF3) samples. When set, every sample -
  // whether it started as PCM or was already compressed - is normalized
  // through `encode` at the requested quality. When omitted (default),
  // already-compressed samples are passed through untouched, as before.
  decode?: SF3Decoder;
  // how many samples to encode concurrently. Encoding is typically I/O- or
  // subprocess-bound (spawning an external encoder, calling into native
  // bindings, etc.), so running several at once can substantially cut wall
  // time on multi-core machines. Defaults to `navigator.hardwareConcurrency`
  // (or 4 if that isn't available). Set to 1 to encode sequentially.
  concurrency?: number;
}

// Serializes a SoundFont (as returned by parse()) back into SF2/SF3 bytes.
//
// Without `options.encode`, every sample keeps its existing format (PCM
// stays PCM, already-compressed SF3 samples stay compressed).
//
// With `options.encode` (see SF3Encoder), every non-compressed sample is
// run through it and packed as Ogg Vorbis, and the version tag is forced
// to 3.0 - this package doesn't bundle an encoder itself, so bring your
// own (e.g. mediabunny, ffmpeg.wasm, or a WebCodecs-based encoder).
//
// Already-compressed samples are passed through untouched unless
// `options.decode` (see SF3Decoder) is also given - in that case they're
// decoded back to PCM first and re-encoded through `options.encode`, so
// SF3 input ends up at the same requested quality as PCM input.
//
// Always returns a Promise, even in the `encode`-less case, so the shape
// of the return value doesn't depend on which options were passed.
//
// presetZone, instrumentZone, presetModulators and instrumentModulators
// must already include their terminal record, as returned by parse();
// phdr/inst/shdr/pgen/igen terminal records are (re)generated automatically
// and don't need to be present.
export function write(
  soundFont: SoundFont,
  options: WriteOptions | SF3WriteOptions = {},
): Promise<Uint8Array> {
  if ("encode" in options) {
    return writeSF3(soundFont, options);
  }
  return Promise.resolve(writeSF2(soundFont, options));
}

function writeSF2(soundFont: SoundFont, options: WriteOptions): Uint8Array {
  const isSF3 = soundFont.info.version.major === 3;
  // Compressed samples must not have the SF2-mandated 46-frame silence
  // padding; only PCM needs it.
  const silentFrames = options.silentFrames ?? (isSF3 ? 0 : 46);

  const { data: sampleData, sampleHeaders } = repackSamples(
    soundFont.samples,
    soundFont.sampleHeaders,
    isSF3,
    silentFrames,
  );

  // Always emit a clean 3.0 version tag for SF3. Legacy files sometimes
  // carry a garbage minor (from an incorrect ifil chunk size of 2).
  const version = isSF3 ? new VersionTag(3, 0) : soundFont.info.version;

  return buildContainer(
    soundFont,
    isSF3,
    version,
    sampleData,
    sampleHeaders,
  );
}

async function writeSF3(
  soundFont: SoundFont,
  options: SF3WriteOptions,
): Promise<Uint8Array> {
  const silentFrames = options.silentFrames ?? 0;
  const concurrency = options.concurrency ?? defaultConcurrency();

  const { samples: encodedSamples, sampleHeaders: encodedHeaders } =
    await encodeSamples(
      soundFont.samples,
      soundFont.sampleHeaders,
      options.encode,
      concurrency,
      options.decode,
    );
  const { data: sampleData, sampleHeaders } = repackSamples(
    encodedSamples,
    encodedHeaders,
    true,
    silentFrames,
  );

  return buildContainer(
    soundFont,
    true,
    new VersionTag(3, 0),
    sampleData,
    sampleHeaders,
  );
}

function defaultConcurrency(): number {
  return typeof navigator !== "undefined" && navigator.hardwareConcurrency
    ? navigator.hardwareConcurrency
    : 4;
}

function buildContainer(
  soundFont: SoundFont,
  isSF3: boolean,
  version: VersionTag,
  sampleData: Uint8Array,
  sampleHeaders: SampleHeader[],
): Uint8Array {
  const infoList = writeListChunk(
    "LIST",
    "INFO",
    soundFont.info.write(version),
  );
  const sdtaList = writeListChunk("LIST", "sdta", [
    writeChunk("smpl", sampleData),
  ]);
  const pdtaList = writeListChunk("LIST", "pdta", [
    writePhdr(soundFont.presetHeaders, soundFont.presetZone.length),
    writeBag("pbag", soundFont.presetZone),
    writeMod("pmod", soundFont.presetModulators),
    writeGen("pgen", soundFont.presetGenerators),
    writeInst(soundFont.instruments, soundFont.instrumentZone.length),
    writeBag("ibag", soundFont.instrumentZone),
    writeMod("imod", soundFont.instrumentModulators),
    writeGen("igen", soundFont.instrumentGenerators),
    writeShdr(sampleHeaders, isSF3),
  ]);

  return writeListChunk("RIFF", "sfbk", [infoList, sdtaList, pdtaList]);
}

function stripEnd<T>(items: T[], isEnd: (item: T) => boolean): T[] {
  if (items.length > 0 && isEnd(items[items.length - 1])) {
    return items.slice(0, -1);
  }
  return items;
}

function writePhdr(
  presetHeaders: PresetHeader[],
  presetBagCount: number,
): Uint8Array {
  const items = stripEnd(presetHeaders, (p) => p.isEnd);
  const stream = new WriteStream();
  for (let i = 0; i < items.length; i++) {
    items[i].write(stream);
  }
  PresetHeader.end(presetBagCount - 1).write(stream);
  return writeChunk("phdr", stream.toUint8Array());
}

function writeInst(
  instruments: Instrument[],
  instrumentBagCount: number,
): Uint8Array {
  const items = stripEnd(instruments, (i) => i.isEnd);
  const stream = new WriteStream();
  for (let i = 0; i < items.length; i++) {
    items[i].write(stream);
  }
  Instrument.end(instrumentBagCount - 1).write(stream);
  return writeChunk("inst", stream.toUint8Array());
}

function writeShdr(sampleHeaders: SampleHeader[], isSF3: boolean) {
  const items = stripEnd(sampleHeaders, (s) => s.isEnd);
  const stream = new WriteStream();
  for (let i = 0; i < items.length; i++) {
    items[i].write(stream, isSF3);
  }
  SampleHeader.end().write(stream, isSF3);
  return writeChunk("shdr", stream.toUint8Array());
}

function writeBag(type: string, items: Bag[]): Uint8Array {
  const stream = new WriteStream();
  for (let i = 0; i < items.length; i++) {
    items[i].write(stream);
  }
  return writeChunk(type, stream.toUint8Array());
}

function writeMod(type: string, items: ModulatorList[]): Uint8Array {
  const stream = new WriteStream();
  for (let i = 0; i < items.length; i++) {
    items[i].write(stream);
  }
  return writeChunk(type, stream.toUint8Array());
}

function writeGen(type: string, items: GeneratorList[]): Uint8Array {
  const trimmed = stripEnd(items, (g) => g.isEnd);
  const stream = new WriteStream();
  for (let i = 0; i < trimmed.length; i++) {
    trimmed[i].write(stream);
  }
  GeneratorList.end().write(stream);
  return writeChunk(type, stream.toUint8Array());
}

// Rebuilds the smpl chunk from AudioData, and returns SampleHeader clones
// with start/end offsets updated to match the new layout. loopStart/loopEnd
// stay sample-relative (as returned by parse()); SampleHeader.write() adds
// the new `start` back on for non-SF3 files. For SF3, loop points address
// the decoded PCM directly (not the compressed byte stream), so they're
// written unchanged regardless of repacking - see writeSF3()'s use of
// encodeSamples() below.
function repackSamples(
  samples: AudioData[],
  sampleHeaders: SampleHeader[],
  isSF3: boolean,
  silentFrames: number,
): { data: Uint8Array; sampleHeaders: SampleHeader[] } {
  const headers = stripEnd(sampleHeaders, (s) => s.isEnd);
  const bytesPerFrame = isSF3 ? 1 : 2; // matches Parser.ts loadSamples' `factor`
  const silence = new Uint8Array(silentFrames * bytesPerFrame);
  const chunks: Uint8Array[] = [];
  const newHeaders: SampleHeader[] = new Array(headers.length);

  let frameOffset = 0;
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i];
    const sample = samples[i];
    const frameCount = sample.data.byteLength / bytesPerFrame;
    const sampleType = isSF3 ? (header.sampleType | 0x10) : header.sampleType;
    newHeaders[i] = new SampleHeader(
      header.sampleName,
      frameOffset,
      frameOffset + frameCount,
      header.loopStart,
      header.loopEnd,
      header.sampleRate,
      header.originalPitch,
      header.pitchCorrection,
      header.sampleLink,
      sampleType,
    );
    chunks.push(sample.data);
    chunks.push(silence);
    frameOffset += frameCount + silentFrames;
  }

  return { data: concatChunks(chunks), sampleHeaders: newHeaders };
}

// Runs `encode` over every non-compressed sample, returning AudioData with
// type "compressed" for all of them, plus SampleHeader clones with
// sampleRate/loopStart/loopEnd rescaled for any sample the encoder
// resampled (see SF3EncodeResult). Up to `concurrency` samples are encoded
// at once: each worker pulls the next unencoded index off a shared counter
// and calls `encode`, so slow/uneven samples don't stall the whole batch
// the way a fixed chunk-based split would.
//
// Already-compressed (SF3) samples are passed through untouched, unless
// `decode` is given - in that case they're decoded back to PCM first (see
// SF3Decoder) and then run through `encode` like any other sample, so SF3
// input ends up re-quantized at the requested quality instead of keeping
// whatever quality it was originally encoded at.
async function encodeSamples(
  samples: AudioData[],
  sampleHeaders: SampleHeader[],
  encode: SF3Encoder,
  concurrency: number,
  decode?: SF3Decoder,
): Promise<{ samples: AudioData[]; sampleHeaders: SampleHeader[] }> {
  const newSamples: AudioData[] = new Array(samples.length);
  const newHeaders: SampleHeader[] = new Array(samples.length);

  let nextIndex = 0;
  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= samples.length) return;
      const sample = samples[i];
      const header = sampleHeaders[i];

      if (sample.type === "compressed") {
        if (!decode) {
          newSamples[i] = sample;
          newHeaders[i] = header;
          continue;
        }
        const decoded = await decode(sample.data);
        const pcm = decoded instanceof Int16Array ? decoded : decoded.pcm;
        const srcRate = decoded instanceof Int16Array
          ? header.sampleRate
          : decoded.sampleRate ?? header.sampleRate;
        const result = await encode(pcm, srcRate);
        const data = result instanceof Uint8Array ? result : result.data;
        const sampleRate = result instanceof Uint8Array
          ? srcRate
          : result.sampleRate ?? srcRate;
        newSamples[i] = new AudioData("compressed", header, data);
        newHeaders[i] = sampleRate === header.sampleRate
          ? header
          : rescaleSampleHeader(header, sampleRate);
        continue;
      }

      const pcm = toInt16PCM(sample);
      const result = await encode(pcm, header.sampleRate);
      const data = result instanceof Uint8Array ? result : result.data;
      const sampleRate = result instanceof Uint8Array
        ? header.sampleRate
        : result.sampleRate ?? header.sampleRate;
      newSamples[i] = new AudioData("compressed", header, data);
      newHeaders[i] = sampleRate === header.sampleRate
        ? header
        : rescaleSampleHeader(header, sampleRate);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, samples.length));
  const workers = new Array(workerCount);
  for (let i = 0; i < workerCount; i++) {
    workers[i] = worker();
  }
  await Promise.all(workers);

  return { samples: newSamples, sampleHeaders: newHeaders };
}

// used when an encoder resampled a sample to a rate it supports (e.g. most
// Vorbis encoders only accept a handful of fixed rates): scales loopStart/
// loopEnd (in sample-frame units) by the same ratio as the sample rate, so
// pitch and looping stay correct at the new rate.
function rescaleSampleHeader(
  header: SampleHeader,
  sampleRate: number,
): SampleHeader {
  const ratio = sampleRate / header.sampleRate;
  return new SampleHeader(
    header.sampleName,
    header.start,
    header.end,
    Math.round(header.loopStart * ratio),
    Math.round(header.loopEnd * ratio),
    sampleRate,
    header.originalPitch,
    header.pitchCorrection,
    header.sampleLink,
    header.sampleType,
  );
}

// Converts pcm16/pcm24 sample data to a plain 16-bit PCM view, for handing
// to an SF3Encoder. pcm24 is downsampled by dropping its low byte.
function toInt16PCM(sample: AudioData): Int16Array {
  if (sample.type === "pcm16") {
    // data may be a subarray view; copy so the Int16Array's byteOffset is
    // guaranteed to be a multiple of 2.
    const copy = sample.data.slice();
    return new Int16Array(copy.buffer, copy.byteOffset, copy.byteLength / 2);
  }
  const data = sample.data;
  const frameCount = data.byteLength / 3;
  const result = new Int16Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    const idx = i * 3;
    result[i] = (data[idx + 2] << 8) | data[idx + 1];
  }
  return result;
}
