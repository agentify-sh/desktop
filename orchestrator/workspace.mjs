import fs from 'node:fs/promises';
import path from 'node:path';

async function exists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function findRepoRoot(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  for (let i = 0; i < 50; i++) {
    if (await exists(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export async function detectWorkspaceRoot(startDir) {
  const gitRoot = await findRepoRoot(startDir);
  if (gitRoot) return gitRoot;

  // Fallback: walk up for common markers.
  let dir = path.resolve(startDir || process.cwd());
  const markers = ['package.json', 'pnpm-workspace.yaml', 'turbo.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'requirements.txt'];
  for (let i = 0; i < 50; i++) {
    for (const m of markers) {
      if (await exists(path.join(dir, m))) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(startDir || process.cwd());
}

export async function detectPackageManager(workspaceDir) {
  const dir = path.resolve(workspaceDir);
  const has = async (name) => await exists(path.join(dir, name));
  if (await has('pnpm-lock.yaml')) return 'pnpm';
  if (await has('yarn.lock')) return 'yarn';
  if (await has('package-lock.json')) return 'npm';
  return 'npm';
}

export async function detectTestCommand(workspaceDir) {
  const dir = path.resolve(workspaceDir);
  const has = async (name) => await exists(path.join(dir, name));
  const pkgPath = path.join(dir, 'package.json');
  if (await has('package.json')) {
    try {
      const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
      const scripts = pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
      if (typeof scripts.test === 'string' && scripts.test.trim()) {
        const pm = await detectPackageManager(dir);
        return pm === 'pnpm' ? 'pnpm test' : pm === 'yarn' ? 'yarn test' : 'npm test';
      }
    } catch {}
  }

  if (await has('pytest.ini') || await has('pyproject.toml') || await has('requirements.txt')) return 'pytest -q';
  if (await has('go.mod')) return 'go test ./...';
  if (await has('Cargo.toml')) return 'cargo test';

  return null;
}

