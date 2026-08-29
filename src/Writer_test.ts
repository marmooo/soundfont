import { assertEquals } from "@std/assert";
import { parse } from "./Parser.ts";
import { SF3Encoder, write } from "./Writer.ts";
import type { SoundFont } from "./SoundFont.ts";

const input = Deno.readFileSync("./fixture/TestSoundFont.sf2");
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
