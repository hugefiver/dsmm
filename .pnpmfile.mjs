export const hooks = {
  beforePacking(manifest) {
    // Linked development plugins declare host peers for DSH's resolver. Installed plugins use the host installation directly.
    delete manifest.peerDependencies;
    delete manifest.peerDependenciesMeta;
    return manifest;
  },
};
