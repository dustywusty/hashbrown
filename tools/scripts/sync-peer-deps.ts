import { createProjectGraphAsync } from '@nx/devkit';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function readJsonFile<T = any>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

function writeJsonFile(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

async function main() {
  const nxJson = readJsonFile<Record<string, any>>('nx.json');
  const releaseConfig = nxJson.release;
  if (!releaseConfig) {
    console.log('No release configuration found. Skipping peer dependency sync.');
    return;
  }

  const releaseProjects = new Set<string>();
  if (Array.isArray(releaseConfig.projects)) {
    for (const project of releaseConfig.projects) {
      releaseProjects.add(project);
    }
  }
  const groups = releaseConfig.groups ?? {};
  for (const group of Object.values(groups)) {
    if (Array.isArray(group.projects)) {
      for (const project of group.projects) {
        releaseProjects.add(project);
      }
    }
  }

  if (releaseProjects.size === 0) {
    console.log('No release projects configured. Skipping peer dependency sync.');
    return;
  }

  const projectGraph = await createProjectGraphAsync();
  const workspacePackages = new Map<string, { packageJsonPath: string; packageName: string; version: string }>();

  for (const projectName of releaseProjects) {
    const node = projectGraph.nodes[projectName];
    if (!node) {
      continue;
    }
    const packageJsonPath = join(node.data.root, 'package.json');
    if (!existsSync(packageJsonPath)) {
      continue;
    }
    try {
      const packageJson = readJsonFile<{ name?: string; version?: string }>(packageJsonPath);
      if (!packageJson.name || !packageJson.version) {
        continue;
      }
      workspacePackages.set(projectName, {
        packageJsonPath,
        packageName: packageJson.name,
        version: packageJson.version,
      });
    } catch {
      // Ignore packages with invalid JSON
    }
  }

  for (const projectName of releaseProjects) {
    const node = projectGraph.nodes[projectName];
    if (!node) {
      continue;
    }
    const pkgMeta = workspacePackages.get(projectName);
    if (!pkgMeta) {
      continue;
    }
    const packageJson = readJsonFile<Record<string, any>>(pkgMeta.packageJsonPath);
    const peerDeps = { ...(packageJson.peerDependencies ?? {}) } as Record<string, string>;
    let changed = false;

    const dependencies = projectGraph.dependencies[projectName] ?? [];
    for (const dependency of dependencies) {
      if (dependency.type === 'implicit') {
        continue;
      }
      const depMeta = workspacePackages.get(dependency.target);
      if (!depMeta) {
        continue;
      }
      if (peerDeps[depMeta.packageName] !== depMeta.version) {
        peerDeps[depMeta.packageName] = depMeta.version;
        changed = true;
      }
    }

    if (changed) {
      const sortedPeerDeps = Object.keys(peerDeps)
        .sort()
        .reduce<Record<string, string>>((acc, key) => {
          acc[key] = peerDeps[key];
          return acc;
        }, {});
      packageJson.peerDependencies = sortedPeerDeps;
      writeJsonFile(pkgMeta.packageJsonPath, packageJson);
      console.log(`Updated peerDependencies for ${pkgMeta.packageName}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
