// better-auth lists every framework and tool it can integrate with as an optional peer.
// pnpm satisfies optional peers from anywhere in the workspace, which drags drizzle-kit
// (and its esbuild binaries), vitest and React into the server's production graph.
// Keep only the peer the server actually uses.
const keep = new Set(["drizzle-orm"]);

function readPackage(pkg) {
  if (pkg.name === "better-auth" && pkg.peerDependencies) {
    for (const name of Object.keys(pkg.peerDependencies)) {
      if (!keep.has(name)) {
        delete pkg.peerDependencies[name];
        if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta[name];
      }
    }
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
