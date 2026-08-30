import {
  createDefaultInstrumentGeneratorStore,
  createInstrumentGeneratorStore,
  createPresetGeneratorStore,
  GeneratorStore,
} from "./Generator.ts";
import {
  buildModulatorIndexes,
  type ModulatorIndexes,
  Voice,
} from "./Voice.ts";
import type { ParseResult, SamplingData } from "./Parser.ts";
import {
  Bag,
  GeneratorList,
  Info,
  Instrument,
  ModulatorList,
  PresetHeader,
  RangeValue,
  SampleHeader,
} from "./Structs.ts";
import { AudioData } from "./AudioData.ts";
import { DefaultModulators } from "./DefaultModulators.ts";

// A local instrument zone with its global zone (if any) already merged in.
// Built once at parse time so getVoice() only does range checks + a final
// merge onto the default generator store.
class CachedInstrumentZone {
  constructor(
    public generators: GeneratorStore,
    public modulators: ModulatorList[],
    public keyRange: RangeValue | undefined,
    public velRange: RangeValue | undefined,
  ) {}
}

// A local preset zone with its global zone (if any) already merged in.
class CachedPresetZone {
  constructor(
    public generators: GeneratorStore,
    public modulators: ModulatorList[],
    public keyRange: RangeValue | undefined,
    public velRange: RangeValue | undefined,
    public instrumentID: number,
  ) {}
}

// DefaultModulators + zone modulators (+ index maps) and the zone-merged,
// clamped GeneratorStore. Built once per zone pair and shared across every
// note that hits that pair. The generators store is treated as read-only
// on the note-on path (Voice clones it only when modulators actually apply).
type ZonePairMods = ModulatorIndexes & {
  modulators: ModulatorList[];
  generators: GeneratorStore;
};

// SoundFont holds the same fields as ParseResult directly (rather than
// nesting them under a `.parsed` property), plus the voice-lookup methods
// below. `parse()` returns this; write() reads these fields back out.
export class SoundFont implements ParseResult {
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

  // (bank << 16) | preset → index into presetHeaders. Built once so
  // getVoice() is O(1) instead of a linear scan of every preset header.
  // Terminal EOP records are skipped. If you rewrite bank/preset numbers
  // on the headers after construction, call rebuildPresetIndex().
  private presetIndex: Map<number, number>;

  // Per-instrument / per-preset local zones with global generators and
  // modulators already folded in. Built once in the constructor so the
  // note-on path never re-parses GeneratorList[] or re-slices bags.
  private cachedInstrumentZones: CachedInstrumentZone[][];
  private cachedPresetZones: CachedPresetZone[][];

  // Lazy cache of DefaultModulators + zone modulators (+ index maps) and
  // the merged GeneratorStore, keyed by the cached zone objects. Chorded /
  // repeated notes on the same zones reuse the same arrays, Maps, and store
  // without rebuilding.
  private zonePairModCache = new WeakMap<
    CachedPresetZone,
    WeakMap<CachedInstrumentZone, ZonePairMods>
  >();

  constructor(result: ParseResult) {
    this.presetHeaders = result.presetHeaders;
    this.presetZone = result.presetZone;
    this.presetModulators = result.presetModulators;
    this.presetGenerators = result.presetGenerators;
    this.instruments = result.instruments;
    this.instrumentZone = result.instrumentZone;
    this.instrumentModulators = result.instrumentModulators;
    this.instrumentGenerators = result.instrumentGenerators;
    this.sampleHeaders = result.sampleHeaders;
    this.samples = result.samples;
    this.samplingData = result.samplingData;
    this.info = result.info;
    this.presetIndex = new Map();
    this.rebuildPresetIndex();
    this.cachedInstrumentZones = this.buildInstrumentZoneCache();
    this.cachedPresetZones = this.buildPresetZoneCache();
  }

  private getZonePairMods(
    presetZone: CachedPresetZone,
    instrumentZone: CachedInstrumentZone,
  ): ZonePairMods {
    let inner = this.zonePairModCache.get(presetZone);
    if (!inner) {
      inner = new WeakMap();
      this.zonePairModCache.set(presetZone, inner);
    }
    let cached = inner.get(instrumentZone);
    if (!cached) {
      const modulators = [
        ...DefaultModulators,
        ...presetZone.modulators,
        ...instrumentZone.modulators,
      ];
      const indexes = buildModulatorIndexes(modulators);
      // default + instrument (absolute) + preset (relative), clamped once.
      // Shared across all keys/velocities that land on this zone pair.
      const generators = createDefaultInstrumentGeneratorStore();
      generators.overlay(instrumentZone.generators);
      generators.add(presetZone.generators);
      generators.clamp();
      cached = {
        modulators,
        controllerToDestinations: indexes.controllerToDestinations,
        destinationToModulators: indexes.destinationToModulators,
        generators,
      };
      inner.set(instrumentZone, cached);
    }
    return cached;
  }

  // key for presetIndex: bank and preset are both 16-bit in the SF2 spec.
  private static presetKey(bank: number, preset: number): number {
    return (bank << 16) | preset;
  }

  rebuildPresetIndex(): void {
    const map = this.presetIndex;
    map.clear();
    const headers = this.presetHeaders;
    for (let i = 0; i < headers.length; i++) {
      const p = headers[i];
      if (p.isEnd) continue;
      map.set(SoundFont.presetKey(p.bank, p.preset), i);
    }
  }

  // Pre-merge each instrument's global zone into every local zone so
  // findInstrumentZone only range-checks and returns a cached entry.
  // Note: parse() drops the terminal EOI record, so every entry in
  // instruments[] is a real instrument.
  private buildInstrumentZoneCache(): CachedInstrumentZone[][] {
    const n = this.instruments.length;
    const cache: CachedInstrumentZone[][] = new Array(n);
    for (let id = 0; id < n; id++) {
      const generatorSegments = this.getInstrumentGenerators(id);
      const modulatorSegments = this.getInstrumentModulators(id);
      const locals: CachedInstrumentZone[] = [];
      let globalGenerators: GeneratorStore | undefined;
      let globalModulators: ModulatorList[] = [];
      for (let i = 0; i < generatorSegments.length; i++) {
        const generators = createInstrumentGeneratorStore(generatorSegments[i]);
        if (!generators.has("sampleID")) {
          globalGenerators = generators;
          globalModulators = modulatorSegments[i];
          continue;
        }
        let gen: GeneratorStore;
        let mod: ModulatorList[];
        if (globalGenerators) {
          gen = globalGenerators.clone();
          gen.overlay(generators);
          mod = globalModulators.length === 0
            ? modulatorSegments[i]
            : [...globalModulators, ...modulatorSegments[i]];
        } else {
          gen = generators;
          mod = modulatorSegments[i];
        }
        // Range checks use the local zone's ranges only (SF2: a local zone
        // without keyRange/velRange is unrestricted, even if the global zone
        // set one). Generators/modulators are still the global+local merge.
        locals.push(
          new CachedInstrumentZone(
            gen,
            mod,
            generators.keyRange,
            generators.velRange,
          ),
        );
      }
      cache[id] = locals;
    }
    return cache;
  }

  // Same for presets: fold the global preset zone into each local zone.
  // Note: parse() drops the terminal EOP record, so every entry in
  // presetHeaders[] is a real preset.
  private buildPresetZoneCache(): CachedPresetZone[][] {
    const n = this.presetHeaders.length;
    const cache: CachedPresetZone[][] = new Array(n);
    for (let id = 0; id < n; id++) {
      const generatorSegments = this.getPresetGenerators(id);
      const modulatorSegments = this.getPresetModulators(id);
      const locals: CachedPresetZone[] = [];
      let globalGenerators: GeneratorStore | undefined;
      let globalModulators: ModulatorList[] = [];
      for (let i = 0; i < generatorSegments.length; i++) {
        const generators = createPresetGeneratorStore(generatorSegments[i]);
        if (!generators.has("instrument")) {
          globalGenerators = generators;
          globalModulators = modulatorSegments[i];
          continue;
        }
        let gen: GeneratorStore;
        let mod: ModulatorList[];
        if (globalGenerators) {
          gen = globalGenerators.clone();
          gen.overlay(generators);
          mod = globalModulators.length === 0
            ? modulatorSegments[i]
            : [...globalModulators, ...modulatorSegments[i]];
        } else {
          gen = generators;
          mod = modulatorSegments[i];
        }
        locals.push(
          new CachedPresetZone(
            gen,
            mod,
            generators.keyRange,
            generators.velRange,
            generators.get("instrument"),
          ),
        );
      }
      cache[id] = locals;
    }
    return cache;
  }

  getGeneratorParams(
    generators: GeneratorList[],
    zone: Bag[],
    from: number,
    to: number,
  ) {
    const result = new Array(to - from);
    for (let i = from; i < to; i++) {
      const segmentFrom = zone[i].generatorIndex;
      const segmentTo = zone[i + 1].generatorIndex;
      result[i - from] = generators.slice(segmentFrom, segmentTo);
    }
    return result;
  }

  getPresetGenerators(presetHeaderIndex: number) {
    const presetHeader = this.presetHeaders[presetHeaderIndex];
    const nextPresetHeader = this.presetHeaders[presetHeaderIndex + 1];
    const nextPresetBagIndex = nextPresetHeader
      ? nextPresetHeader.presetBagIndex
      : this.presetZone.length - 1;
    return this.getGeneratorParams(
      this.presetGenerators,
      this.presetZone,
      presetHeader.presetBagIndex,
      nextPresetBagIndex,
    );
  }

  getInstrumentGenerators(instrumentID: number) {
    const instrument = this.instruments[instrumentID];
    const nextInstrument = this.instruments[instrumentID + 1];
    const nextInstrumentBagIndex = nextInstrument
      ? nextInstrument.instrumentBagIndex
      : this.instrumentZone.length - 1;
    return this.getGeneratorParams(
      this.instrumentGenerators,
      this.instrumentZone,
      instrument.instrumentBagIndex,
      nextInstrumentBagIndex,
    );
  }

  getModulators(
    modulators: ModulatorList[],
    zone: Bag[],
    from: number,
    to: number,
  ) {
    const result = new Array(to - from);
    for (let i = from; i < to; i++) {
      const segmentFrom = zone[i].modulatorIndex;
      const segmentTo = zone[i + 1].modulatorIndex;
      result[i - from] = modulators.slice(segmentFrom, segmentTo);
    }
    return result;
  }

  getPresetModulators(presetHeaderIndex: number) {
    const presetHeader = this.presetHeaders[presetHeaderIndex];
    const nextPresetHeader = this.presetHeaders[presetHeaderIndex + 1];
    const nextPresetBagIndex = nextPresetHeader
      ? nextPresetHeader.presetBagIndex
      : this.presetZone.length - 1;
    return this.getModulators(
      this.presetModulators,
      this.presetZone,
      presetHeader.presetBagIndex,
      nextPresetBagIndex,
    );
  }

  getInstrumentModulators(instrumentID: number) {
    const instrument = this.instruments[instrumentID];
    const nextInstrument = this.instruments[instrumentID + 1];
    const nextInstrumentBagIndex = nextInstrument
      ? nextInstrument.instrumentBagIndex
      : this.instrumentZone.length - 1;
    return this.getModulators(
      this.instrumentModulators,
      this.instrumentZone,
      instrument.instrumentBagIndex,
      nextInstrumentBagIndex,
    );
  }

  findInstrumentZone(
    instrumentID: number,
    key: number,
    velocity: number,
  ): CachedInstrumentZone | undefined {
    const zones = this.cachedInstrumentZones[instrumentID];
    if (!zones) return;
    for (let i = 0; i < zones.length; i++) {
      const zone = zones[i];
      if (zone.keyRange && !zone.keyRange.in(key)) continue;
      if (zone.velRange && !zone.velRange.in(velocity)) continue;
      return zone;
    }
    return;
  }

  findInstrument(presetHeaderIndex: number, key: number, velocity: number) {
    const zones = this.cachedPresetZones[presetHeaderIndex];
    if (!zones) return null;
    for (let i = 0; i < zones.length; i++) {
      const zone = zones[i];
      if (zone.keyRange && !zone.keyRange.in(key)) continue;
      if (zone.velRange && !zone.velRange.in(velocity)) continue;
      const instrumentZone = this.findInstrumentZone(
        zone.instrumentID,
        key,
        velocity,
      );
      if (instrumentZone) {
        return this.createVoice(key, zone, instrumentZone);
      }
    }
    return null;
  }

  createVoice(
    key: number,
    presetZone: CachedPresetZone,
    instrumentZone: CachedInstrumentZone,
  ) {
    const zoneMods = this.getZonePairMods(presetZone, instrumentZone);
    const generators = zoneMods.generators;
    const sampleID = generators.get("sampleID");
    const sample = this.samples[sampleID];
    const sampleHeader = this.sampleHeaders[sampleID];
    return new Voice(
      key,
      generators,
      zoneMods.modulators,
      sample,
      sampleHeader,
      zoneMods,
    );
  }

  getVoice(
    bankNumber: number,
    instrumentNumber: number,
    key: number,
    velocity: number,
  ): Voice | null {
    const presetHeaderIndex = this.presetIndex.get(
      SoundFont.presetKey(bankNumber, instrumentNumber),
    );
    if (presetHeaderIndex === undefined) {
      console.warn(
        "preset not found: bank=%s instrument=%s",
        bankNumber,
        instrumentNumber,
      );
      return null;
    }
    const instrument = this.findInstrument(presetHeaderIndex, key, velocity);
    if (!instrument) {
      console.warn(
        "instrument not found: bank=%s instrument=%s",
        bankNumber,
        instrumentNumber,
      );
      return null;
    }
    return instrument;
  }

  // presetNames[bankNumber][presetNumber] = presetName
  getPresetNames() {
    const bank: { [index: number]: { [index: number]: string } } = {};
    const presetHeaders = this.presetHeaders;
    for (let i = 0; i < presetHeaders.length; i++) {
      const preset = presetHeaders[i];
      if (!bank[preset.bank]) {
        bank[preset.bank] = {};
      }
      bank[preset.bank][preset.preset] = preset.presetName;
    }
    return bank;
  }
}
