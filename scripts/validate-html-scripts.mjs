import { readFile } from "node:fs/promises";
import vm from "node:vm";

const files = process.argv.slice(2);
if (!files.length) throw new Error("pass one or more HTML files");

for (const file of files) {
  const html = await readFile(file, "utf8");
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const [index, match] of scripts.entries()) {
    new vm.Script(match[1], { filename: `${file}#script-${index + 1}` });
  }
  console.log(`ok ${file} (${scripts.length} inline scripts)`);
}
