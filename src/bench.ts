// deno bench --allow-read src/bench.ts
//
// Compares @marmooo/soundfont-parser (npm) against this package.
import {
  parse as parseOld,
  SoundFont as SoundFontOld,
} from "@marmooo/soundfont-parser";
import { parse } from "../src/mod.ts";

const file = Deno.readFileSync(
  new URL("../fixtures/GeneralUser_GS_v1.472.sf3", import.meta.url),
);

// Silence expected getVoice() warnings (missing preset / out-of-range key).
// Deno's bench runner may wrap console, so re-apply inside each callback too.
const silenceWarn = () => {
  console.warn = () => {};
};
silenceWarn();

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

// First preset (findIndex is nearly free on the old path — index 0).
const bank0 = soundFont.presetHeaders[0].bank;
const preset0 = soundFont.presetHeaders[0].preset;

// Last non-terminal preset that yields a voice at middle C — forces the old
// path to scan nearly the whole presetHeaders list on every call.
let lastWorking = 0;
for (let i = soundFont.presetHeaders.length - 1; i >= 0; i--) {
  const p = soundFont.presetHeaders[i];
  if (p.isEnd) continue;
  if (soundFont.getVoice(p.bank, p.preset, 60, 100)) {
    lastWorking = i;
    break;
  }
}
const bankLast = soundFont.presetHeaders[lastWorking].bank;
const presetLast = soundFont.presetHeaders[lastWorking].preset;

// Keys that actually resolve for the last preset (avoids warn noise).
const lastKeys: number[] = [];
for (let key = 0; key < 128; key++) {
  if (soundFont.getVoice(bankLast, presetLast, key, 100)) lastKeys.push(key);
}

// Every non-terminal preset, for a single key — stresses lookup volume.
const allPresets: { bank: number; preset: number }[] = [];
for (let i = 0; i < soundFont.presetHeaders.length; i++) {
  const p = soundFont.presetHeaders[i];
  if (p.isEnd) continue;
  allPresets.push({ bank: p.bank, preset: p.preset });
}

Deno.bench("getVoice + getAllParams (128 keys, first preset)", {
  group: "getVoice",
  baseline: true,
}, () => {
  silenceWarn();
  for (let key = 0; key < 128; key++) {
    soundFontOld.getVoice(bank0, preset0, key, 100)?.getAllParams(
      controllerState,
    );
  }
});

Deno.bench("getVoice + getAllParams (128 keys, first preset) (new)", {
  group: "getVoice",
}, () => {
  silenceWarn();
  for (let key = 0; key < 128; key++) {
    soundFont.getVoice(bank0, preset0, key, 100)?.getAllParams(controllerState);
  }
});

Deno.bench("getVoice + getAllParams (working keys, last preset)", {
  group: "getVoice-last",
  baseline: true,
}, () => {
  silenceWarn();
  for (let i = 0; i < lastKeys.length; i++) {
    soundFontOld.getVoice(bankLast, presetLast, lastKeys[i], 100)?.getAllParams(
      controllerState,
    );
  }
});

Deno.bench("getVoice + getAllParams (working keys, last preset) (new)", {
  group: "getVoice-last",
}, () => {
  silenceWarn();
  for (let i = 0; i < lastKeys.length; i++) {
    soundFont.getVoice(bankLast, presetLast, lastKeys[i], 100)?.getAllParams(
      controllerState,
    );
  }
});

// One key per preset. Zone matching still runs, but the old path also pays
// a linear scan of presetHeaders on every call (avg ~half the list).
const KEY = 60;
const VEL = 100;

Deno.bench("getVoice only (all presets, 1 key)", {
  group: "getVoice-all",
  baseline: true,
}, () => {
  silenceWarn();
  for (let i = 0; i < allPresets.length; i++) {
    const { bank, preset } = allPresets[i];
    soundFontOld.getVoice(bank, preset, KEY, VEL);
  }
});

Deno.bench("getVoice only (all presets, 1 key) (new)", {
  group: "getVoice-all",
}, () => {
  silenceWarn();
  for (let i = 0; i < allPresets.length; i++) {
    const { bank, preset } = allPresets[i];
    soundFont.getVoice(bank, preset, KEY, VEL);
  }
});

// getAllParams only — isolates the zero-controller fast path from getVoice.
const voices: ReturnType<typeof soundFont.getVoice>[] = [];
for (let key = 0; key < 128; key++) {
  const v = soundFont.getVoice(bank0, preset0, key, 100);
  if (v) voices.push(v);
}
const controllerActive = new Float32Array(256);
// CC1 (mod wheel): controllerType = (cc<<7)|index = 128+1 = 129
// (see DefaultModulators 0x0081 → index 1, cc 1)
controllerActive[129] = 0.5;

Deno.bench("getAllParams only (zero controllers, 128 voices)", {
  group: "getAllParams",
  baseline: true,
}, () => {
  for (let i = 0; i < voices.length; i++) {
    voices[i]!.getAllParams(controllerState);
  }
});

Deno.bench("getAllParams only (one active controller, 128 voices)", {
  group: "getAllParams",
}, () => {
  for (let i = 0; i < voices.length; i++) {
    voices[i]!.getAllParams(controllerActive);
  }
});
