import { GeneratorKeys } from "./Constants.ts";
import { BoundedValue, GeneratorList, RangeValue } from "./Structs.ts";

type GeneratorKey = typeof GeneratorKeys[number];

export const RangeGeneratorKeys = [
  "keyRange",
  "velRange",
] as const;
export type RangeGeneratorKey = typeof RangeGeneratorKeys[number];
export type InstrumentAllowedKey = Exclude<GeneratorKey, undefined>;
export type NonRangeGeneratorKey = Exclude<
  InstrumentAllowedKey,
  RangeGeneratorKey
>;

const IndexGeneratorKeys = [
  "instrument",
  "sampleID",
] as const;
const SubstitutionGeneratorKeys = [
  "keynum",
  "velocity",
] as const;
const SampleGeneratorKeys = [
  "startAddrsOffset",
  "endAddrsOffset",
  "startloopAddrsOffset",
  "endloopAddrsOffset",
  "startAddrsCoarseOffset",
  "endAddrsCoarseOffset",
  "startloopAddrsCoarseOffset",
  "endloopAddrsCoarseOffset",
  "sampleModes",
  "exclusiveClass",
  "overridingRootKey",
] as const;
const presetExcludedKeys = [
  ...SampleGeneratorKeys,
  ...SubstitutionGeneratorKeys,
] as const;
type PresetExcludedKey = typeof presetExcludedKeys[number];
export type PresetAllowedKey = Exclude<InstrumentAllowedKey, PresetExcludedKey>;

type NonValueGeneratorKey =
  | typeof SampleGeneratorKeys[number]
  | typeof SubstitutionGeneratorKeys[number]
  | typeof IndexGeneratorKeys[number]
  | typeof RangeGeneratorKeys[number];
export type ValueGeneratorKey = Exclude<
  InstrumentAllowedKey,
  NonValueGeneratorKey
>;

export type InstrumentGeneratorParams = {
  [key in InstrumentAllowedKey]: key extends RangeGeneratorKey ? RangeValue
    : number;
};
export type PresetGeneratorParams = {
  [key in PresetAllowedKey]: key extends RangeGeneratorKey ? RangeValue
    : number;
};
export type GeneratorParams = {
  [key in InstrumentAllowedKey]: key extends RangeGeneratorKey ? RangeValue
    : BoundedValue;
};

const RangeGeneratorKeysSet = new Set(
  RangeGeneratorKeys as readonly string[],
);
export function isRangeGenerator(key: string): key is RangeGeneratorKey {
  return RangeGeneratorKeysSet.has(key as RangeGeneratorKey);
}

const nonValueGeneratorKeysSet = new Set<string>([
  ...IndexGeneratorKeys,
  ...RangeGeneratorKeys,
  ...SubstitutionGeneratorKeys,
  ...SampleGeneratorKeys,
]);

function extractValueGeneratorKeys(): ValueGeneratorKey[] {
  const result: ValueGeneratorKey[] = [];
  const length = GeneratorKeys.length;
  for (let i = 0; i < length; i++) {
    const key = GeneratorKeys[i];
    if (key !== undefined && !nonValueGeneratorKeysSet.has(key)) {
      result.push(key as ValueGeneratorKey);
    }
  }
  return result;
}

export const ValueGeneratorKeys: readonly ValueGeneratorKey[] =
  extractValueGeneratorKeys();
const ValueGeneratorKeysSet = new Set(
  ValueGeneratorKeys as readonly string[],
);
export function isValueGenerator(key: string): key is ValueGeneratorKey {
  return ValueGeneratorKeysSet.has(key as ValueGeneratorKey);
}

// SF2 generator code (0..58) <-> name, for every non-range generator.
const nameToCode = new Map<NonRangeGeneratorKey, number>();
for (let i = 0; i < GeneratorKeys.length; i++) {
  const key = GeneratorKeys[i];
  if (key !== undefined && !isRangeGenerator(key)) {
    nameToCode.set(key as NonRangeGeneratorKey, i);
  }
}

const presetExcludedCodes = new Set<number>();
for (let i = 0; i < presetExcludedKeys.length; i++) {
  const key = presetExcludedKeys[i] as NonRangeGeneratorKey;
  const code = nameToCode.get(key);
  if (code !== undefined) presetExcludedCodes.add(code);
}

const UNSET = NaN;

// GeneratorStore backs a preset/instrument zone's generator values with a
// single Float64Array indexed by SF2 generator code, instead of a plain
// object with string keys. Voice creation runs once per note-on and merges
// a preset zone onto an instrument zone; with a plain object that merge is
// a `Object.keys()` walk plus megamorphic property access on every note.
// With a typed array it's a flat numeric loop with no per-note allocation
// of intermediate objects, at no cost to type safety: get/set/has are
// still checked against generator names at compile time.
export class GeneratorStore {
  private values: Float64Array;
  keyRange?: RangeValue;
  velRange?: RangeValue;

  constructor(values?: Float64Array) {
    this.values = values ?? new Float64Array(GeneratorKeys.length).fill(UNSET);
  }

  get<K extends NonRangeGeneratorKey>(key: K): number {
    return this.values[nameToCode.get(key)!];
  }

  set<K extends NonRangeGeneratorKey>(key: K, value: number): void {
    this.values[nameToCode.get(key)!] = value;
  }

  has(key: NonRangeGeneratorKey): boolean {
    return !Number.isNaN(this.values[nameToCode.get(key)!]);
  }

  getByCode(code: number): number {
    return this.values[code];
  }

  setByCode(code: number, value: number): void {
    this.values[code] = value;
  }

  clone(): GeneratorStore {
    const store = new GeneratorStore(this.values.slice());
    store.keyRange = this.keyRange;
    store.velRange = this.velRange;
    return store;
  }

  // adds every set value of `other` onto this store in place (used to merge
  // a preset zone's relative offsets onto an instrument zone's values).
  // keyRange/velRange live outside `values`, so they're naturally skipped,
  // matching how the old object-based merge used isRangeGenerator() to
  // skip them.
  add(other: GeneratorStore): void {
    const values = this.values;
    const otherValues = other.values;
    for (let i = 0; i < values.length; i++) {
      const delta = otherValues[i];
      if (Number.isNaN(delta)) continue;
      values[i] = Number.isNaN(values[i]) ? delta : values[i] + delta;
    }
  }

  // adds `value` onto a single named generator in place.
  addTo(key: NonRangeGeneratorKey, value: number): void {
    const code = nameToCode.get(key)!;
    const current = this.values[code];
    this.values[code] = Number.isNaN(current) ? value : current + value;
  }

  // overwrites this store's set values with `other`'s set values in place
  // (used to merge a global zone with a local zone: the local zone wins).
  overlay(other: GeneratorStore): void {
    const values = this.values;
    const otherValues = other.values;
    for (let i = 0; i < values.length; i++) {
      if (!Number.isNaN(otherValues[i])) values[i] = otherValues[i];
    }
    if (other.keyRange) this.keyRange = other.keyRange;
    if (other.velRange) this.velRange = other.velRange;
  }

  // clamps every set generator value to its legal range (SF2 spec §9.5) in
  // place. Zone summation (instrument + preset) and modulators can push a
  // value out of range; the spec requires clamping before use, regardless
  // of how a particular synthesis engine interprets the value afterward.
  clamp(): void {
    for (const [key, code] of nameToCode) {
      const value = this.values[code];
      if (Number.isNaN(value)) continue;
      this.values[code] = clampGenerator(key, value);
    }
  }
}

const fixedGenerators = [
  ["keynum", "keyRange"],
  ["velocity", "velRange"],
] as const;

export function createPresetGeneratorStore(
  generators: GeneratorList[],
): GeneratorStore {
  const store = new GeneratorStore();
  for (let i = 0; i < generators.length; i++) {
    const gen = generators[i];
    const type = gen.type;
    if (type === undefined) continue;
    if (presetExcludedCodes.has(gen.code)) continue;
    if (type === "keyRange") {
      store.keyRange = gen.value as RangeValue;
    } else if (type === "velRange") {
      store.velRange = gen.value as RangeValue;
    } else {
      store.setByCode(gen.code, gen.value as number);
    }
  }
  return store;
}

export function createInstrumentGeneratorStore(
  generators: GeneratorList[],
): GeneratorStore {
  const store = new GeneratorStore();
  for (let i = 0; i < generators.length; i++) {
    const gen = generators[i];
    const type = gen.type;
    if (type === undefined) continue;
    if (type === "keyRange") {
      store.keyRange = gen.value as RangeValue;
    } else if (type === "velRange") {
      store.velRange = gen.value as RangeValue;
    } else {
      store.setByCode(gen.code, gen.value as number);
    }
  }
  for (let i = 0; i < fixedGenerators.length; i++) {
    const [src, dst] = fixedGenerators[i];
    if (!store.has(src)) continue;
    const v = store.get(src);
    if (dst === "keyRange") {
      store.keyRange = new RangeValue(v, v);
    } else {
      store.velRange = new RangeValue(v, v);
    }
  }
  return store;
}

const int16min = -32768;
const int16max = 32767;
const uint16min = 0;
const uint16max = 65535;
export const DefaultInstrumentZone: GeneratorParams = {
  startAddrsOffset: new BoundedValue(0, 0, int16max),
  endAddrsOffset: new BoundedValue(int16min, 0, 0),
  startloopAddrsOffset: new BoundedValue(int16min, 0, int16max),
  endloopAddrsOffset: new BoundedValue(int16min, 0, int16max),
  startAddrsCoarseOffset: new BoundedValue(0, 0, int16max),
  modLfoToPitch: new BoundedValue(-12000, 0, 12000),
  vibLfoToPitch: new BoundedValue(-12000, 0, 12000),
  modEnvToPitch: new BoundedValue(-12000, 0, 12000),
  initialFilterFc: new BoundedValue(1500, 13500, 13500),
  initialFilterQ: new BoundedValue(0, 0, 960),
  modLfoToFilterFc: new BoundedValue(-12000, 0, 12000),
  modEnvToFilterFc: new BoundedValue(-12000, 0, 12000),
  endAddrsCoarseOffset: new BoundedValue(int16min, 0, 0),
  modLfoToVolume: new BoundedValue(-960, 0, 960),
  chorusEffectsSend: new BoundedValue(0, 0, 1000),
  reverbEffectsSend: new BoundedValue(0, 0, 1000),
  pan: new BoundedValue(-500, 0, 500),
  delayModLFO: new BoundedValue(-12000, -12000, 5000),
  freqModLFO: new BoundedValue(-16000, 0, 4500),
  delayVibLFO: new BoundedValue(-12000, -12000, 5000),
  freqVibLFO: new BoundedValue(-16000, 0, 4500),
  delayModEnv: new BoundedValue(-12000, -12000, 5000),
  attackModEnv: new BoundedValue(-12000, -12000, 8000),
  holdModEnv: new BoundedValue(-12000, -12000, 5000),
  decayModEnv: new BoundedValue(-12000, -12000, 8000),
  sustainModEnv: new BoundedValue(0, 0, 1000),
  releaseModEnv: new BoundedValue(-12000, -12000, 8000),
  keynumToModEnvHold: new BoundedValue(-1200, 0, 1200),
  keynumToModEnvDecay: new BoundedValue(-1200, 0, 1200),
  delayVolEnv: new BoundedValue(-12000, -12000, 5000),
  attackVolEnv: new BoundedValue(-12000, -12000, 8000),
  holdVolEnv: new BoundedValue(-12000, -12000, 5000),
  decayVolEnv: new BoundedValue(-12000, -12000, 8000),
  sustainVolEnv: new BoundedValue(0, 0, 1440),
  releaseVolEnv: new BoundedValue(-12000, -12000, 8000),
  keynumToVolEnvHold: new BoundedValue(-1200, 0, 1200),
  keynumToVolEnvDecay: new BoundedValue(-1200, 0, 1200),
  instrument: new BoundedValue(uint16min, uint16max, uint16max),
  keyRange: new RangeValue(0, 127),
  velRange: new RangeValue(0, 127),
  startloopAddrsCoarseOffset: new BoundedValue(int16min, 0, int16max),
  keynum: new BoundedValue(-1, -1, 127),
  velocity: new BoundedValue(-1, -1, 127),
  initialAttenuation: new BoundedValue(0, 0, 1440),
  endloopAddrsCoarseOffset: new BoundedValue(int16min, 0, int16max),
  coarseTune: new BoundedValue(-120, 0, 120),
  fineTune: new BoundedValue(-99, 0, 99),
  sampleID: new BoundedValue(uint16min, uint16max, uint16max),
  sampleModes: new BoundedValue(0, 0, 3),
  scaleTuning: new BoundedValue(0, 100, 100),
  exclusiveClass: new BoundedValue(0, 0, 127),
  overridingRootKey: new BoundedValue(-1, -1, 127),
};

// clamps a single generator's raw value to its legal range, per the SF2
// spec's own bounds for that generator (not tied to any particular
// synthesis engine's interpretation of the value).
export function clampGenerator(
  key: NonRangeGeneratorKey,
  value: number,
): number {
  return (DefaultInstrumentZone[key] as BoundedValue).clamp(value);
}

// pre-clamped default value for every non-range generator, indexed by code,
// so a fresh default GeneratorStore can be built with a single array copy
// instead of walking DefaultInstrumentZone by name on every voice.
const DefaultValuesByCode = new Float64Array(GeneratorKeys.length).fill(
  UNSET,
);
for (const [key, code] of nameToCode) {
  const bounded = DefaultInstrumentZone[key] as BoundedValue;
  DefaultValuesByCode[code] = clampGenerator(key, bounded.defaultValue);
}

export function createDefaultInstrumentGeneratorStore(): GeneratorStore {
  const store = new GeneratorStore(DefaultValuesByCode.slice());
  store.keyRange = DefaultInstrumentZone.keyRange as RangeValue;
  store.velRange = DefaultInstrumentZone.velRange as RangeValue;
  return store;
}
