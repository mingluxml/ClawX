/**
 * after-pack.cjs
 *
 * electron-builder afterPack hook.
 *
 * For CoPaw backend: Since CoPaw is installed at runtime using uv,
 * this hook only performs basic cleanup and validation.
 */

const { existsSync, readdirSync, rmSync } = require('fs');
const { join } = require('path');

// ── Arch helpers ─────────────────────────────────────────────────────────────
// electron-builder Arch enum: 0=ia32, 1=x64, 2=armv7l, 3=arm64, 4=universal
const ARCH_MAP = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };

function resolveArch(archEnum) {
  return ARCH_MAP[archEnum] || 'x64';
}

// ── General cleanup ──────────────────────────────────────────────────────────

function cleanupUnnecessaryFiles(dir) {
  let removedCount = 0;

  const REMOVE_DIRS = new Set([
    'test', 'tests', '__tests__', '.github', 'examples', 'example',
  ]);
  const REMOVE_FILE_EXTS = ['.d.ts', '.d.ts.map', '.js.map', '.mjs.map', '.ts.map', '.markdown'];
  const REMOVE_FILE_NAMES = new Set([
    '.DS_Store', 'README.md', 'CHANGELOG.md', 'LICENSE.md', 'CONTRIBUTING.md',
    'tsconfig.json', '.npmignore', '.eslintrc', '.prettierrc', '.editorconfig',
  ]);

  function walk(currentDir) {
    let entries;
    try { entries = readdirSync(currentDir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (REMOVE_DIRS.has(entry.name)) {
          try { rmSync(fullPath, { recursive: true, force: true }); removedCount++; } catch { /* */ }
        } else {
          walk(fullPath);
        }
      } else if (entry.isFile()) {
        const name = entry.name;
        if (REMOVE_FILE_NAMES.has(name) || REMOVE_FILE_EXTS.some(e => name.endsWith(e))) {
          try { rmSync(fullPath, { force: true }); removedCount++; } catch { /* */ }
        }
      }
    }
  }

  walk(dir);
  return removedCount;
}

// ── Main hook ────────────────────────────────────────────────────────────────

exports.default = async function afterPack(context) {
  const appOutDir = context.appOutDir;
  const platform = context.electronPlatformName; // 'win32' | 'darwin' | 'linux'
  const arch = resolveArch(context.arch);

  console.log(`[after-pack] Target: ${platform}/${arch}`);

  let resourcesDir;
  if (platform === 'darwin') {
    const appName = context.packager.appInfo.productFilename;
    resourcesDir = join(appOutDir, `${appName}.app`, 'Contents', 'Resources');
  } else {
    resourcesDir = join(appOutDir, 'resources');
  }

  // Verify uv binary is present
  const binDir = join(resourcesDir, 'bin');
  const uvBinName = platform === 'win32' ? 'uv.exe' : 'uv';
  const uvPath = join(binDir, uvBinName);
  
  if (existsSync(uvPath)) {
    console.log(`[after-pack] ✅ uv binary found at ${uvPath}`);
  } else {
    console.warn(`[after-pack] ⚠️  uv binary not found at ${uvPath}`);
    console.warn('[after-pack] ⚠️  Run "pnpm run uv:download" before packaging');
  }

  // Clean up resources directory
  console.log('[after-pack] 🧹 Cleaning up unnecessary files ...');
  const removedCount = cleanupUnnecessaryFiles(resourcesDir);
  console.log(`[after-pack] ✅ Removed ${removedCount} unnecessary files/directories.`);

  // Note: CoPaw will be installed at first launch using the bundled uv binary.
  // This approach significantly reduces the app size and allows users to
  // update CoPaw independently of the ClawX app.
  console.log('[after-pack] ℹ️  CoPaw backend will be installed at first launch');
};
