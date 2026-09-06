// Placeholder build helper for @outpost/source-spec.
// Copies JSON Schema files into dist/ so the package's `exports` map
// can resolve `./schemas/*.json` after build.
import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");
const src = join(pkgRoot, "src", "schemas");
const dst = join(pkgRoot, "dist", "schemas");

await mkdir(dst, { recursive: true });
try {
  await cp(src, dst, { recursive: true });
  console.log("[source-spec] copied schemas to dist/schemas");
} catch (err) {
  if (err.code === "ENOENT") {
    console.log("[source-spec] no src/schemas yet (expected pre-PR-1)");
  } else {
    throw err;
  }
}
