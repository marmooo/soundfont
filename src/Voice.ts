import {
  clampGenerator,
  GeneratorStore,
  isValueGenerator,
  ValueGeneratorKey,
} from "./Generator.ts";
import { GeneratorKeys } from "./Constants.ts";
import { ModulatorList, SampleHeader } from "./Structs.ts";
import { AudioData } from "./AudioData.ts";

// SF2 spec §8.1.2: converts a generator value expressed in timecents into
// seconds. Exported as a convenience since it's needed to interpret almost
// every time-related generator value (attackVolEnv, delayModEnv, ...).
export function timecentToSecond(value: number) {
  return Math.pow(2, value / 1200);
}

// The spec-defined generator values for a voice (a specific note on a
// specific preset/instrument), after zone merging and — if controller
// values are supplied — modulator application. Units are exactly as
// defined by the SF2 spec (timecents, centibels, tenths of a percent,
// ...); convert them yourself (e.g. with timecentToSecond) as your
// synthesis engine needs. This is deliberately a thin, generic view of the
// data rather than a pre-interpreted set of playback parameters, so it
// isn't tied to any one synthesis engine's conventions.
export interface VoiceParams {
  key: number;
  generators: GeneratorStore;
  sample: AudioData;
  sampleHeader: SampleHeader;
  // resolved absolute sample playback range: the header's own start/end/
  // loop points combined with the startAddrsOffset-family generators, per
  // SF2 spec §7.9 (fine offset + 32768 * coarse offset).
  start: number;
  end: number;
  loopStart: number;
  loopEnd: number;
}

export class Voice {
  controllerToDestinations = new Map<number, Set<number>>();
  destinationToModulators = new Map<number, ModulatorList[]>();

  constructor(
    public key: number,
    public generators: GeneratorStore,
    public modulators: ModulatorList[],
    public sample: AudioData,
    public sampleHeader: SampleHeader,
  ) {
    this.setControllerToDestinations();
    this.setDestinationToModulators();
  }

  setControllerToDestinations() {
    for (let i = 0; i < this.modulators.length; i++) {
      const modulator = this.modulators[i];
      const controllerType = modulator.sourceOper.controllerType;
      const destinationOper = modulator.destinationOper;
      const list = this.controllerToDestinations.get(controllerType);
      if (list) {
        list.add(modulator.destinationOper);
      } else {
        this.controllerToDestinations.set(
          controllerType,
          new Set([destinationOper]),
        );
      }
    }
  }

  setDestinationToModulators() {
    for (let i = 0; i < this.modulators.length; i++) {
      const modulator = this.modulators[i];
      const generatorKey = modulator.destinationOper;
      const list = this.destinationToModulators.get(generatorKey);
      if (list) {
        list.push(modulator);
      } else {
        this.destinationToModulators.set(generatorKey, [modulator]);
      }
    }
  }

  // applies every modulator whose source controller is present in
  // `controllerState` on top of this voice's static (zone-merged)
  // generators, and clamps the result to each generator's legal range —
  // both are spec-mandated (SF2 §8, §9.5), not implementation choices.
  transformAllParams(controllerState: Float32Array): GeneratorStore {
    const params = this.generators.clone();
    for (const modulator of this.modulators) {
      const controllerType = modulator.sourceOper.controllerType;
      const controllerValue = controllerState[controllerType];
      if (!controllerValue) continue;
      const generatorKey = GeneratorKeys[modulator.destinationOper];
      if (!generatorKey) continue;
      if (!isValueGenerator(generatorKey)) continue;
      const source = modulator.sourceOper;
      const primary = source.map(controllerValue);
      let secondary = 1;
      const amountSource = modulator.amountSourceOper;
      if (!(amountSource.cc === 0 && amountSource.index === 0)) {
        const amount = controllerState[amountSource.controllerType];
        secondary = amountSource.map(amount);
      }
      const summingValue = modulator.transform(primary * secondary);
      if (Number.isNaN(summingValue)) continue;
      params.addTo(generatorKey, summingValue);
    }
    params.clamp();
    return params;
  }

  // same as transformAllParams(), but only recomputes the generators
  // affected by a single controller change (e.g. one MIDI CC), for
  // incremental updates instead of recomputing every generator on every
  // controller message.
  transformParams(
    controllerType: number,
    controllerState: Float32Array,
  ): Partial<Record<ValueGeneratorKey, number>> {
    const params: Partial<Record<ValueGeneratorKey, number>> = {};
    const destinations = this.controllerToDestinations.get(controllerType);
    if (!destinations) return params;
    for (const destinationOper of destinations) {
      const generatorKey = GeneratorKeys[destinationOper];
      if (!generatorKey) continue;
      if (!isValueGenerator(generatorKey)) continue;
      const modulators = this.destinationToModulators.get(destinationOper);
      if (!modulators) continue;
      let value = this.generators.get(generatorKey);
      for (const modulator of modulators) {
        const source = modulator.sourceOper;
        const primary = source.map(controllerState[source.controllerType]);
        let secondary = 1;
        const amountSource = modulator.amountSourceOper;
        if (!(amountSource.cc === 0 && amountSource.index === 0)) {
          const amount = controllerState[amountSource.controllerType];
          secondary = amountSource.map(amount);
        }
        const summingValue = modulator.transform(primary * secondary);
        if (Number.isNaN(summingValue)) continue;
        value += summingValue;
      }
      params[generatorKey] = clampGenerator(generatorKey, value);
    }
    return params;
  }

  // the full set of spec-defined generator values for this voice — see
  // transformAllParams() — plus the resolved absolute sample playback
  // range (SF2 §7.9).
  getAllParams(controllerValues: Float32Array): VoiceParams {
    const generators = this.transformAllParams(controllerValues);
    return {
      key: this.key,
      generators,
      sample: this.sample,
      sampleHeader: this.sampleHeader,
      start: this.generators.get("startAddrsCoarseOffset") * 32768 +
        this.generators.get("startAddrsOffset"),
      end: this.generators.get("endAddrsCoarseOffset") * 32768 +
        this.generators.get("endAddrsOffset"),
      loopStart: this.sampleHeader.loopStart +
        this.generators.get("startloopAddrsCoarseOffset") * 32768 +
        this.generators.get("startloopAddrsOffset"),
      loopEnd: this.sampleHeader.loopEnd +
        this.generators.get("endloopAddrsCoarseOffset") * 32768 +
        this.generators.get("endloopAddrsOffset"),
    };
  }

  // just the generators affected by a single controller change (e.g. mod
  // wheel) — see transformParams(). Same raw spec units as
  // getAllParams().generators.
  getParams(
    controllerType: number,
    controllerState: Float32Array,
  ): Partial<Record<ValueGeneratorKey, number>> {
    return this.transformParams(controllerType, controllerState);
  }
}
