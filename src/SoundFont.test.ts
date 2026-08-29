import { assertAlmostEquals, assertEquals, assertNotEquals } from "@std/assert";
import { parse } from "./Parser.ts";
import { timecentToSecond } from "./Voice.ts";
import { createInstrumentGeneratorStore } from "./Generator.ts";

const tolerance = 5e-3;
const input = Deno.readFileSync("./fixture/TestSoundFont.sf2");
const soundFont = parse(input);

Deno.test("should create Preset Zone", () => {
  const zone = soundFont.getPresetGenerators(0);
  assertNotEquals(zone, null);
});
Deno.test("should create Instrument Zone", () => {
  const bag = soundFont.getInstrumentGenerators(1);

  const globalZone = createInstrumentGeneratorStore(bag[0]);
  assertEquals(globalZone.has("sampleID"), false);
  assertAlmostEquals(
    timecentToSecond(globalZone.get("attackVolEnv") || 0),
    0.123,
    tolerance,
    "attackVolEnv",
  );
  assertAlmostEquals(
    timecentToSecond(globalZone.get("decayVolEnv") || 0),
    0.234,
    tolerance,
    "decayVolEnv",
  );

  const instrumentZone = createInstrumentGeneratorStore(bag[1]);
  assertEquals(instrumentZone.has("sampleID"), true);
});
Deno.test("should create Voice", () => {
  const voice = soundFont.getVoice(0, 0, 40, 100)!;
  const params = voice.getAllParams(new Float32Array(256));
  assertNotEquals(params, null);
  assertEquals(params.sampleHeader.sampleName, "crash");

  const g = params.generators;
  assertAlmostEquals(
    timecentToSecond(g.get("attackVolEnv")),
    0.2,
    tolerance,
    "attackVolEnv",
  );
  assertAlmostEquals(
    timecentToSecond(g.get("decayVolEnv")),
    0.4,
    tolerance,
    "decayVolEnv",
  );
  assertAlmostEquals(
    timecentToSecond(g.get("releaseVolEnv")),
    0.6,
    tolerance,
    "releaseVolEnv",
  );

  assertAlmostEquals(
    timecentToSecond(g.get("attackModEnv")),
    0.2,
    tolerance,
    "attackModEnv",
  );
  assertAlmostEquals(
    timecentToSecond(g.get("decayModEnv")),
    0.4,
    tolerance,
    "decayModEnv",
  );
  assertAlmostEquals(g.get("sustainModEnv"), 5, tolerance, "sustainModEnv");
  assertAlmostEquals(
    timecentToSecond(g.get("releaseModEnv")),
    0.6,
    tolerance,
    "releaseModEnv",
  );
  assertAlmostEquals(g.get("modEnvToPitch"), 1, tolerance, "modEnvToPitch");
  assertAlmostEquals(
    g.get("modEnvToFilterFc"),
    2,
    tolerance,
    "modEnvToFilterFc",
  );
});
Deno.test("should apply Global Instrument Zone", () => {
  const voice = soundFont.getVoice(0, 1, 40, 100)!;
  const params = voice.getAllParams(new Float32Array(256));
  const g = params.generators;
  // global zone values
  assertAlmostEquals(
    timecentToSecond(g.get("attackVolEnv")),
    0.123,
    tolerance,
  );
  assertAlmostEquals(
    timecentToSecond(g.get("decayVolEnv")),
    0.345,
    tolerance,
  );
});
