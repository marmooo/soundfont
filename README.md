# @marmooo/soundfont

A SoundFont (SF2, SF3) parser and writer.

## Usage

```
import { parse } from "@marmooo/soundfont";

const file = Deno.readFileSync("soundfont.sf3");
const soundFont = parse(file);
```

### Writing

`write()` serializes a `SoundFont` (as returned by `parse()`) back into SF2/SF3
bytes, and always returns a `Promise<Uint8Array>`. Edit `soundFont` in place,
then pass it to `write()`.

```
import { parse, write } from "@marmooo/soundfont";

const file = Deno.readFileSync("soundfont.sf2");
const soundFont = parse(file);

// e.g. rename a preset
soundFont.presetHeaders[0].presetName = "My Preset";

const output = await write(soundFont);
Deno.writeFileSync("output.sf2", output);
```

`write()` regenerates the terminal records of `phdr`/`inst`/`shdr`/`pgen`/
`igen` automatically. `presetZone`/`instrumentZone`/`presetModulators`/
`instrumentModulators` must already include their terminal record, as returned
by `parse()`.

### Writing SF3

`write()` keeps every sample in its original format by default (PCM stays PCM).
To produce a compressed SF3 file instead, pass `encode` — an Ogg Vorbis encoder.
This package doesn't bundle one, so bring your own (e.g.
[mediabunny](https://github.com/Vanilagy/mediabunny),
[ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm), or a WebCodecs-based
encoder).

```
import { parse, write } from "@marmooo/soundfont";

const file = Deno.readFileSync("soundfont.sf2");
const soundFont = parse(file);

const output = await write(soundFont, {
  encode: async (pcm, sampleRate) => {
    // pcm: Int16Array (mono), sampleRate: number
    // return the Ogg Vorbis bytes for this sample as a Uint8Array
    return await myEncoder.encode(pcm, sampleRate);
  },
});
Deno.writeFileSync("output.sf3", output);
```

Samples that are already compressed (an SF3 input's `"compressed"` samples) are
passed through unchanged. The version tag is always written as 3.0 when `encode`
is given.

Samples are encoded concurrently — up to `options.concurrency` at once (defaults
to `navigator.hardwareConcurrency`, or 4). This matters most when `encode`
shells out to an external encoder or native bindings, since those are typically
CPU-bound in a way a single `await` chain won't parallelize on its own. Pass
`concurrency: 1` to encode sequentially instead.

Most Vorbis encoders only accept a handful of fixed sample rates (e.g. 8000,
11025, 16000, 22050, 32000, 44100, 48000 Hz) and reject anything else, so
real-world SF2s (which often mix sample rates) may need resampling before
encoding. If your encoder has to resample, return `{ data, sampleRate }` instead
of a plain `Uint8Array` — `write()` rescales the sample's stored rate and loop
points to match automatically, so pitch and looping stay correct.

A full, ready-to-use implementation — including this resampling fallback, an
adjustable `bitsPerHz` compression setting, and a CLI — is
[@marmooo/sf2-to-sf3](https://github.com/marmooo/sf2-to-sf3), built on
[mediabunny](https://mediabunny.dev). It's a separate package so this one stays
dependency-free; `write()`'s `encode` option above is the extension point it
uses.

## License

MIT

## Credits

This library is based on
[@marmooo/soundfont-parser](https://github.com/marmooo/soundfont-parser).
