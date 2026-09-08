export class ModulatorSource {
  constructor(
    public type: number,
    public polarity: number,
    public direction: number,
    public cc: number,
    public index: number,
  ) {}

  get controllerType() {
    return this.cc << 7 | this.index;
  }

  static parse(sourceOper: number) {
    const type = sourceOper >> 10 & 63;
    const index = sourceOper & 127;
    const cc = sourceOper >> 7 & 1;
    const direction = sourceOper >> 8 & 1;
    const polarity = sourceOper >> 9 & 1;
    return new ModulatorSource(type, polarity, direction, cc, index);
  }

  toValue(): number {
    return (this.type & 63) << 10 |
      (this.polarity & 1) << 9 |
      (this.direction & 1) << 8 |
      (this.cc & 1) << 7 |
      (this.index & 127);
  }

  map(normalizedValue: number): number {
    let v = normalizedValue; // [0, 1]
    // polarity (0: unipolar, 1: bipolar)
    if (this.polarity === 1) {
      v = (v - 0.5) * 2; // [-1, 1]
      if (this.direction === 1) {
        v *= -1;
      }
    } else if (this.direction === 1) {
      v = 1 - v;
    }
    switch (this.type) {
      case 0: // linear
        break;
      case 1:
        { // concave
          const absV = Math.abs(v);
          // Clamp out-of-range values to 0 (as required by the spec)
          if (absV <= 0 || absV >= 1) {
            v = 0;
          } else {
            // Normalized concave curve.
            //
            // The factor -40/96 (= 2 * -20/96) comes from the conventional
            // 96 dB full-scale attenuation used by SoundFont.
            // The official SF 2.04 specification never writes the exact
            // concave formula with "96 dB", but:
            //   - attenuation is measured in centibels (1 cB = 0.1 dB)
            //   - the default "Velocity → Initial Attenuation" modulator
            //     (section 8.4.1) has an amount of 960 cB = 96 dB
            //   - implementations (FluidSynth etc.) therefore normalise
            //     the squared-log curve to a 96 dB range
            //
            // This matches the pictures that were already present in the
            // older SF 2.01 documentation (the famous "page 73").
            const concave = -(40 / 96) * Math.log10(1 - absV);
            v = Math.sign(v) * concave;
          }
        }
        break;
      case 2: { // convex
        // Complement of concave: f(v) = 1 + (40/96) * log10(v)
        // (FluidSynth: fluid_convex_tab[i] = 1 - fluid_concave_tab[i])
        const absV = Math.abs(v);
        if (absV <= 0 || absV >= 1) {
          v = 0;
        } else {
          v = Math.sign(v) * (1.0 + (40 / 96) * Math.log10(1 - absV));
        }
        break;
      }
      case 3: // switch
        v = v >= 0.5 ? 1 : 0;
        break;
      default: // treat as linear
        console.warn(`unexpected type: ${this.type}`);
        break;
    }
    return v;
  }
}
