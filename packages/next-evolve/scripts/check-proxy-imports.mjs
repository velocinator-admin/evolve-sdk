// Fails the build if anything reachable from the proxy entry imports the DB
// driver or the db/ modules (the proxy must never touch the customer DB).
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dist = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
const FORBIDDEN = [/^postgres$/, /^pg$/, /^drizzle-orm/];
const IMPORT_RE =
  /(?:import|export)\s*(?:[^'"]*?from\s*)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

const seen = new Set();
const errors = [];
function visit(file, chain) {
  if (seen.has(file)) return;
  seen.add(file);
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2];
    if (spec.startsWith(".")) {
      let target = resolve(dirname(file), spec);
      if (!existsSync(target) && existsSync(`${target}.js`)) target = `${target}.js`;
      if (target.startsWith(resolve(dist, "db"))) errors.push([...chain, spec].join(" → "));
      else visit(target, [...chain, spec]);
    } else if (FORBIDDEN.some((re) => re.test(spec))) {
      errors.push([...chain, spec].join(" → "));
    }
  }
}
visit(resolve(dist, "proxy/index.js"), ["proxy/index.js"]);
if (errors.length) {
  console.error(`check-proxy-imports: the proxy must not reach the DB:\n  ${errors.join("\n  ")}`);
  process.exit(1);
}
console.warn(`check-proxy-imports: ok (${seen.size} modules)`);
