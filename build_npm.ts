import { copySync } from "@std/fs";
import { build, emptyDir } from "@deno/dnt";

await emptyDir("./npm");

await build({
  entryPoints: ["./src/mod.ts"],
  outDir: "./npm",
  compilerOptions: {
    lib: ["ESNext", "DOM"],
  },
  shims: {
    deno: true,
  },
  package: {
    name: "@marmooo/soundfont",
    version: "0.3.2",
    description: "A SoundFont (SF2, SF3) parser and writer.",
    license: "MIT",
    repository: {
      type: "git",
      url: "git+https://github.com/marmooo/soundfont.git",
    },
    bugs: {
      url: "https://github.com/marmooo/soundfont/issues",
    },
  },
  postBuild() {
    Deno.copyFileSync("LICENSE", "npm/LICENSE");
    Deno.copyFileSync("README.md", "npm/README.md");
    copySync("fixtures", "npm/esm/fixtures");
    copySync("fixtures", "npm/script/fixtures");
  },
});
