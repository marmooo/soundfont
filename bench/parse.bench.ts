// deno bench --allow-read --allow-net bench/parse.bench.ts
//
// Compares @marmooo/soundfont-parser (npm) against this package.
import {
  parse as parseOld,
  SoundFont as SoundFontOld,
} from "@marmooo/soundfont-parser";
import { parse } from "../src/mod.ts";

const file = Deno.readFileSync(
  new URL("../fixture/TestSoundFont.sf2", import.meta.url),
);

// getVoice() warns when a key falls outside every zone's range, which is
// expected but too noisy to print on every iteration.
globalThis.console = { ...console, warn: () => {} };

Deno.bench("parse", { group: "parse", baseline: true }, () => {
  parseOld(file);
});

Deno.bench("parse (new)", { group: "parse" }, () => {
  parse(file);
});

const parsedOld = parseOld(file);
const soundFontOld = new SoundFontOld(parsedOld);
const soundFont = parse(file);
const controllerState = new Float32Array(256);
const bank = soundFont.presetHeaders[0].bank;
const preset = soundFont.presetHeaders[0].preset;

Deno.bench("getVoice + getAllParams (128 keys)", {
  group: "getVoice",
  baseline: true,
}, () => {
  for (let key = 0; key < 128; key++) {
    soundFontOld.getVoice(bank, preset, key, 100)?.getAllParams(
      controllerState,
    );
  }
});

Deno.bench("getVoice + getAllParams (128 keys) (new)", {
  group: "getVoice",
}, () => {
  for (let key = 0; key < 128; key++) {
    soundFont.getVoice(bank, preset, key, 100)?.getAllParams(controllerState);
  }
});
