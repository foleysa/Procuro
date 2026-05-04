/**
 * Setup script for WebKit (Safari) visual regression testing.
 *
 * WebKit requires additional system libraries that are not bundled with
 * Playwright's browser download. This script patches the MiniBrowser
 * wrapper to include the necessary Nix store library paths so that
 * WebKit can launch successfully in the Replit environment.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run setup-webkit-deps
 *
 * After running, generate baselines with:
 *   VISUAL_BROWSERS=webkit-visual pnpm test:visual:update
 */

import fs from "node:fs";
import path from "node:path";

const PLAYWRIGHT_CACHE =
  process.env["PLAYWRIGHT_BROWSERS_PATH"] ||
  path.join(process.cwd(), ".cache", "ms-playwright");

function findWebkitDir(): string | undefined {
  try {
    const entries = fs.readdirSync(PLAYWRIGHT_CACHE);
    const webkit = entries.find((e) => e.startsWith("webkit-"));
    return webkit ? path.join(PLAYWRIGHT_CACHE, webkit) : undefined;
  } catch {
    return undefined;
  }
}

function findNixLib(pattern: string, libName: string): string | undefined {
  const nixStore = "/nix/store";
  try {
    const entries = fs.readdirSync(nixStore);
    for (const entry of entries) {
      if (!entry.includes(pattern)) continue;
      const libDir = path.join(nixStore, entry, "lib");
      if (fs.existsSync(path.join(libDir, libName))) {
        return libDir;
      }
    }
  } catch {
    /* nix store not available */
  }
  return undefined;
}

function main() {
  const webkitDir = findWebkitDir();
  if (!webkitDir) {
    console.error("WebKit browser not found. Run: npx playwright install webkit");
    process.exit(1);
  }

  const wpeWrapper = path.join(webkitDir, "minibrowser-wpe", "MiniBrowser");
  if (!fs.existsSync(wpeWrapper)) {
    console.error(`MiniBrowser wrapper not found at ${wpeWrapper}`);
    process.exit(1);
  }

  const gccLib = findNixLib("gcc-", "libatomic.so.1");
  const mesaLib = findNixLib("mesa-libgbm", "libgbm.so.1");
  const jpegLib = findNixLib("libjpeg-turbo-3", "libjpeg.so.8");
  const jxlLib = findNixLib("libjxl-", "libjxl.so");
  const soupLib = findNixLib("libsoup-3", "libsoup-3.0.so.0");
  const hbIcuLib = findNixLib("harfbuzz-icu-", "libharfbuzz-icu.so.0");

  const extraPaths = [gccLib, mesaLib, jpegLib, jxlLib, soupLib, hbIcuLib].filter(
    (p): p is string => p !== undefined
  );

  if (extraPaths.length === 0) {
    console.error(
      "No Nix library paths found. Ensure system dependencies are installed."
    );
    process.exit(1);
  }

  const depsDir = path.join(process.cwd(), ".local", "webkit-deps");
  fs.mkdirSync(depsDir, { recursive: true });

  if (jxlLib) {
    const src = path.join(jxlLib, "libjxl.so.0.9");
    const dest = path.join(depsDir, "libjxl.so.0.8");
    if (fs.existsSync(src) && !fs.existsSync(dest)) {
      fs.symlinkSync(src, dest);
    }
  }

  const allPaths = [depsDir, ...extraPaths].join(":");

  const wrapperContent = `#!/bin/sh
MYDIR="$(dirname $(readlink -f $0))"
export WEBKIT_EXEC_PATH="\${MYDIR}/bin"
export WEBKIT_INJECTED_BUNDLE_PATH="\${MYDIR}/lib"
export WEBKIT_INSPECTOR_RESOURCES_PATH="\${MYDIR}/share"
export LD_LIBRARY_PATH="\${MYDIR}/lib:\${MYDIR}/sys/lib:${allPaths}"
exec "\${MYDIR}/bin/MiniBrowser" "$@"
`;

  fs.writeFileSync(wpeWrapper, wrapperContent, { mode: 0o755 });
  console.log(`Patched ${wpeWrapper}`);
  console.log(`Extra library paths: ${allPaths}`);
  console.log("WebKit is ready for visual regression testing.");
}

main();
