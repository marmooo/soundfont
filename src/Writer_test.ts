import { assertEquals } from "@std/assert";
import { parse } from "./Parser.ts";
import { SF3Encoder, write } from "./Writer.ts";
import type { SoundFont } from "./SoundFont.ts";

const input = Deno.readFileSync("./fixtures/TestSoundFont.sf2");
const original = parse(input);
const rewrittenPromise = write(original);

Deno.test("should round-trip INFO", async () => {
  const reparsed = parse(await rewrittenPromise);
  assertEquals(reparsed.info.comment, original.info.comment);
  assertEquals(reparsed.info.copyright, original.info.copyright);
  assertEquals(
    reparsed.info.creationDate,
    original.info.creationDate,
  );
  assertEquals(reparsed.info.engineer, original.info.engineer);
  assertEquals(reparsed.info.name, original.info.name);
  assertEquals(reparsed.info.product, original.info.product);
  assertEquals(reparsed.info.software, original.info.software);
  assertEquals(
    reparsed.info.soundEngine,
    original.info.soundEngine,
  );
  assertEquals(reparsed.info.version, original.info.version);
});

Deno.test("should round-trip presets", async () => {
  const reparsed = parse(await rewrittenPromise);
  assertEquals(
    reparsed.presetHeaders.length,
    original.presetHeaders.length,
  );
  for (let i = 0; i < original.presetHeaders.length; i++) {
    assertEquals(
      reparsed.presetHeaders[i].presetName,
      original.presetHeaders[i].presetName,
    );
    assertEquals(
      reparsed.presetHeaders[i].preset,
      original.presetHeaders[i].preset,
    );
    assertEquals(
      reparsed.presetHeaders[i].bank,
      original.presetHeaders[i].bank,
    );
  }
});

Deno.test("should round-trip instruments", async () => {
  const reparsed = parse(await rewrittenPromise);
  assertEquals(
    reparsed.instruments.length,
    original.instruments.length,
  );
  for (let i = 0; i < original.instruments.length; i++) {
    assertEquals(
      reparsed.instruments[i].instrumentName,
      original.instruments[i].instrumentName,
    );
  }
});

Deno.test("should round-trip samples", async () => {
  const reparsed = parse(await rewrittenPromise);
  assertEquals(
    reparsed.sampleHeaders.length,
    original.sampleHeaders.length,
  );
  for (let i = 0; i < original.sampleHeaders.length; i++) {
    assertEquals(
      reparsed.sampleHeaders[i].sampleName,
      original.sampleHeaders[i].sampleName,
    );
    assertEquals(
      reparsed.sampleHeaders[i].sampleRate,
      original.sampleHeaders[i].sampleRate,
    );
    assertEquals(
      reparsed.sampleHeaders[i].originalPitch,
      original.sampleHeaders[i].originalPitch,
    );
    assertEquals(
      reparsed.sampleHeaders[i].pitchCorrection,
      original.sampleHeaders[i].pitchCorrection,
    );
    assertEquals(
      reparsed.sampleHeaders[i].loopStart,
      original.sampleHeaders[i].loopStart,
    );
    assertEquals(
      reparsed.sampleHeaders[i].loopEnd,
      original.sampleHeaders[i].loopEnd,
    );
    assertEquals(
      reparsed.samples[i].data,
      original.samples[i].data,
    );
  }
});

Deno.test("should round-trip generators and modulators", async () => {
  const reparsed = parse(await rewrittenPromise);
  assertEquals(
    reparsed.presetGenerators,
    original.presetGenerators,
  );
  assertEquals(
    reparsed.instrumentGenerators,
    original.instrumentGenerators,
  );
  assertEquals(
    reparsed.presetModulators,
    original.presetModulators,
  );
  assertEquals(
    reparsed.instrumentModulators,
    original.instrumentModulators,
  );
});

Deno.test("should write SF3 with a caller-supplied encoder", async () => {
  let calls = 0;
  // stand-in for a real Ogg Vorbis encoder (e.g. mediabunny): just proves
  // writeSF3() routes every sample's PCM + sampleRate through `encode` and
  // stores whatever bytes it returns.
  const fakeEncode: SF3Encoder = (pcm, sampleRate) => {
    calls++;
    const out = new Uint8Array(4 + pcm.length);
    new DataView(out.buffer).setUint32(0, sampleRate, true);
    for (let i = 0; i < pcm.length; i++) out[4 + i] = pcm[i] & 0xff;
    return out;
  };

  const sf3Bytes = await write(original, { encode: fakeEncode });
  const sf3 = parse(sf3Bytes);

  assertEquals(calls, original.samples.length);
  assertEquals(sf3.info.version.major, 3);
  assertEquals(
    sf3.samples.length,
    original.samples.length,
  );
  for (let i = 0; i < original.samples.length; i++) {
    assertEquals(sf3.samples[i].type, "compressed");
    assertEquals(
      sf3.sampleHeaders[i].loopStart,
      original.sampleHeaders[i].loopStart,
    );
    assertEquals(
      sf3.sampleHeaders[i].loopEnd,
      original.sampleHeaders[i].loopEnd,
    );
  }
});

Deno.test("should rescale sampleRate and loop points when the encoder resamples", async () => {
  // stand-in for an encoder that can only handle a fixed rate (like most
  // real Vorbis encoders): halves the sample rate and reports it back.
  const halveRateEncode: SF3Encoder = (pcm, sampleRate) => {
    const half = new Int16Array(Math.floor(pcm.length / 2));
    for (let i = 0; i < half.length; i++) half[i] = pcm[i * 2];
    return { data: new Uint8Array(half.buffer), sampleRate: sampleRate / 2 };
  };

  const sf3Bytes = await write(original, { encode: halveRateEncode });
  const sf3 = parse(sf3Bytes);

  for (let i = 0; i < original.samples.length; i++) {
    assertEquals(
      sf3.sampleHeaders[i].sampleRate,
      original.sampleHeaders[i].sampleRate / 2,
    );
    assertEquals(
      sf3.sampleHeaders[i].loopStart,
      Math.round(original.sampleHeaders[i].loopStart / 2),
    );
    assertEquals(
      sf3.sampleHeaders[i].loopEnd,
      Math.round(original.sampleHeaders[i].loopEnd / 2),
    );
  }
});

Deno.test("should run encodes concurrently up to `concurrency`", async () => {
  // TestSoundFont.sf2 only has 5 samples, which isn't enough to tell
  // concurrent from sequential reliably, so fan each real sample out into
  // several synthetic ones sharing the same underlying PCM.
  const repeat = 4;
  const samples = [];
  const sampleHeaders = [];
  for (let r = 0; r < repeat; r++) {
    samples.push(...original.samples);
    sampleHeaders.push(...original.sampleHeaders);
  }
  const soundFont = { ...original, samples, sampleHeaders } as SoundFont;

  let active = 0;
  let maxActive = 0;
  const delayEncode: SF3Encoder = async (pcm) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active--;
    return new Uint8Array(pcm.buffer);
  };

  await write(soundFont, { encode: delayEncode, concurrency: 3 });
  assertEquals(maxActive, 3);
});

// ---------------------------------------------------------------------------
// SF3 / Polyphone compatibility tests
// ---------------------------------------------------------------------------

function findChunk(data: Uint8Array, id: string): number {
  const a = id.charCodeAt(0),
    b = id.charCodeAt(1),
    c = id.charCodeAt(2),
    d = id.charCodeAt(3);
  for (let i = 0; i < data.length - 4; i++) {
    if (
      data[i] === a && data[i + 1] === b && data[i + 2] === c &&
      data[i + 3] === d
    ) {
      return i;
    }
  }
  return -1;
}

function readU32(data: Uint8Array, offset: number): number {
  return data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) |
    (data[offset + 3] << 24);
}

function readU16(data: Uint8Array, offset: number): number {
  return data[offset] | (data[offset + 1] << 8);
}

Deno.test("SF3 write: ifil chunk size is 4 and version is 3.0", async () => {
  const fakeEncode: SF3Encoder = () =>
    new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 0, 0, 0]);
  const bytes = await write(original, { encode: fakeEncode });

  const ifil = findChunk(bytes, "ifil");
  assertEquals(ifil >= 0, true);
  assertEquals(readU32(bytes, ifil + 4), 4, "ifil size must be 4");
  assertEquals(readU16(bytes, ifil + 8), 3, "major version");
  assertEquals(readU16(bytes, ifil + 10), 0, "minor version must be 0");
});

Deno.test("SF3 write: every sample has the 0x10 compressed flag", async () => {
  const fakeEncode: SF3Encoder = () =>
    new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 0, 0, 0]);
  const bytes = await write(original, { encode: fakeEncode });
  const sf3 = parse(bytes);

  for (let i = 0; i < sf3.sampleHeaders.length; i++) {
    const h = sf3.sampleHeaders[i];
    if (h.isEnd) continue;
    assertEquals(
      (h.sampleType & 0x10) !== 0,
      true,
      `sample ${i} (${h.sampleName}) missing 0x10 flag`,
    );
  }
});

Deno.test("SF3 write: terminal shdr is a zeroed record (not named EOS)", async () => {
  const fakeEncode: SF3Encoder = () => new Uint8Array([0x4f, 0x67, 0x67, 0x53]);
  const bytes = await write(original, { encode: fakeEncode });

  const shdr = findChunk(bytes, "shdr");
  const size = readU32(bytes, shdr + 4);
  const n = size / 46;
  const lastName = bytes.subarray(
    shdr + 8 + (n - 1) * 46,
    shdr + 8 + (n - 1) * 46 + 20,
  );
  // all zeros
  for (let i = 0; i < 20; i++) {
    assertEquals(lastName[i], 0, `terminal name byte ${i} should be 0`);
  }
});

Deno.test("parse normalizes missing 0x10 flag on legacy SF3", () => {
  // The bundled GeneralUser fixture is a known legacy SF3 with size=2 ifil
  // and sampleType without the compressed bit.
  const input = Deno.readFileSync("./fixtures/GeneralUser_GS_v1.472.sf3");
  const sf = parse(input);
  assertEquals(sf.info.version.major, 3);
  // After normalization every non-terminal sample must have the flag.
  for (let i = 0; i < sf.sampleHeaders.length; i++) {
    const h = sf.sampleHeaders[i];
    if (h.isEnd) continue;
    assertEquals(
      (h.sampleType & 0x10) !== 0,
      true,
      `fixture sample ${i} should have been normalized to include 0x10`,
    );
  }
});

Deno.test("re-write of legacy SF3 produces correct ifil and flags", async () => {
  const input = Deno.readFileSync("./fixtures/GeneralUser_GS_v1.472.sf3");
  const sf = parse(input);
  // Pass-through write (no encode) must still emit a clean SF3.
  const bytes = await write(sf);

  const ifil = findChunk(bytes, "ifil");
  assertEquals(readU32(bytes, ifil + 4), 4);
  assertEquals(readU16(bytes, ifil + 8), 3);
  assertEquals(readU16(bytes, ifil + 10), 0);

  const reparsed = parse(bytes);
  for (let i = 0; i < reparsed.sampleHeaders.length; i++) {
    const h = reparsed.sampleHeaders[i];
    if (h.isEnd) continue;
    assertEquals((h.sampleType & 0x10) !== 0, true);
  }
});

Deno.test("parse accepts both EOS and empty-name terminal shdr", () => {
  // Polyphone-style empty terminal
  const poly = Deno.readFileSync("./fixtures/GeneralUser_GS_v1.472.sf3");
  const sfPoly = parse(poly);
  // Should not include the terminal as a real sample
  for (const h of sfPoly.sampleHeaders) {
    assertEquals(h.isEnd, false);
    assertEquals(h.sampleName !== "", true);
  }
  assertEquals(sfPoly.sampleHeaders.length > 0, true);

  // EOS-style terminal (the other attached file)
  const g = Deno.readFileSync("./fixtures/TestSoundFont.sf3");
  const sfG = parse(g);
  for (const h of sfG.sampleHeaders) {
    assertEquals(h.isEnd, false);
  }
});

Deno.test("INFO string chunks have even size (Polyphone compatibility)", async () => {
  // Polyphone's INFO parser does pos += 8 + size and never skips a RIFF pad
  // byte. Odd-sized INFO strings therefore break parsing ("invalid header").
  // Our writer must emit even-sized string payloads.
  const bytes = await write(original);
  const listPos = findChunk(bytes, "LIST");
  // First LIST is INFO
  const listSize = readU32(bytes, listPos + 4);
  let pos = listPos + 12; // after LIST + size + "INFO"
  const end = listPos + 8 + listSize;
  while (pos + 8 <= end) {
    const id = String.fromCharCode(
      bytes[pos],
      bytes[pos + 1],
      bytes[pos + 2],
      bytes[pos + 3],
    );
    const size = readU32(bytes, pos + 4);
    assertEquals(
      size % 2,
      0,
      `INFO chunk ${id} size ${size} must be even for Polyphone`,
    );
    pos += 8 + size;
  }
});
