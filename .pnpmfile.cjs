// Some packages list every tool they can integrate with as an optional peer, and pnpm
// satisfies optional peers from anywhere in the workspace. That drags unrelated packages
// into production graphs and, worse, gives one library several copies with different
// peer sets, which breaks type identity across workspace packages. Keep only the peers
// Hekate actually uses.
const keepPeers = {
  // Otherwise drizzle-kit (and its esbuild binaries), vitest and React reach the server image.
  "better-auth": ["drizzle-orm"],
  // Otherwise pg (from pg-boss) and OpenTelemetry create a second drizzle-orm instance in the server.
  "drizzle-orm": ["postgres", "kysely"],
};

function readPackage(pkg) {
  const keep = keepPeers[pkg.name];
  if (keep && pkg.peerDependencies) {
    for (const name of Object.keys(pkg.peerDependencies)) {
      if (!keep.includes(name)) {
        delete pkg.peerDependencies[name];
        if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta[name];
      }
    }
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
