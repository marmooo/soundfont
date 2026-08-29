import {
  createDefaultInstrumentGeneratorStore,
  createInstrumentGeneratorStore,
  createPresetGeneratorStore,
  GeneratorStore,
} from "./Generator.ts";
import { Voice } from "./Voice.ts";
import type { ParseResult, SamplingData } from "./Parser.ts";
import {
  Bag,
  GeneratorList,
  Info,
  Instrument,
  ModulatorList,
  PresetHeader,
  SampleHeader,
} from "./Structs.ts";
import { AudioData } from "./AudioData.ts";
import { DefaultModulators } from "./DefaultModulators.ts";

class InstrumentZone {
  constructor(
    public generators: GeneratorStore,
    public modulators: ModulatorList[],
  ) {}
}

class PresetZone {
  constructor(
    public generators: GeneratorStore,
    public modulators: ModulatorList[],
  ) {}
}

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

  findInstrumentZone(instrumentID: number, key: number, velocity: number) {
    const instrumentGenerators = this.getInstrumentGenerators(instrumentID);
    const instrumentModulators = this.getInstrumentModulators(instrumentID);
    let globalGenerators: GeneratorStore | undefined;
    let globalModulators: ModulatorList[] = [];
    for (let i = 0; i < instrumentGenerators.length; i++) {
      const generators = createInstrumentGeneratorStore(
        instrumentGenerators[i],
      );
      if (!generators.has("sampleID")) {
        globalGenerators = generators;
        globalModulators = instrumentModulators[i];
        continue;
      }
      if (generators.keyRange && !generators.keyRange.in(key)) continue;
      if (generators.velRange && !generators.velRange.in(velocity)) continue;
      if (globalGenerators) {
        const gen = globalGenerators.clone();
        gen.overlay(generators);
        const mod = [...globalModulators, ...instrumentModulators[i]];
        return new InstrumentZone(gen, mod);
      } else {
        return new InstrumentZone(generators, instrumentModulators[i]);
      }
    }
    return;
  }

  findInstrument(presetHeaderIndex: number, key: number, velocity: number) {
    const presetGenerators = this.getPresetGenerators(presetHeaderIndex);
    const presetModulators = this.getPresetModulators(presetHeaderIndex);
    let globalGenerators: GeneratorStore | undefined;
    let globalModulators: ModulatorList[] = [];
    for (let i = 0; i < presetGenerators.length; i++) {
      const generators = createPresetGeneratorStore(presetGenerators[i]);
      if (!generators.has("instrument")) {
        globalGenerators = generators;
        globalModulators = presetModulators[i];
        continue;
      }
      if (generators.keyRange && !generators.keyRange.in(key)) continue;
      if (generators.velRange && !generators.velRange.in(velocity)) continue;
      const instrumentZone = this.findInstrumentZone(
        generators.get("instrument"),
        key,
        velocity,
      );
      if (instrumentZone) {
        if (globalGenerators) {
          const gen = globalGenerators.clone();
          gen.overlay(generators);
          const mod = [...globalModulators, ...presetModulators[i]];
          const presetZone = new PresetZone(gen, mod);
          return this.createVoice(key, presetZone, instrumentZone);
        } else {
          const presetZone = new PresetZone(generators, presetModulators[i]);
          return this.createVoice(key, presetZone, instrumentZone);
        }
      }
    }
    return null;
  }

  createVoice(
    key: number,
    presetZone: PresetZone,
    instrumentZone: InstrumentZone,
  ) {
    const generators = createDefaultInstrumentGeneratorStore();
    generators.overlay(instrumentZone.generators);
    generators.add(presetZone.generators);
    const modulators = [
      ...DefaultModulators,
      ...presetZone.modulators,
      ...instrumentZone.modulators,
    ];
    const sampleID = generators.get("sampleID");
    const sample = this.samples[sampleID];
    const sampleHeader = this.sampleHeaders[sampleID];
    return new Voice(
      key,
      generators,
      modulators,
      sample,
      sampleHeader,
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
