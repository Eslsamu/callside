const { build } = require('../package.json');

// Explicitly non-notarized distribution, independent of the builder's Apple account.
module.exports = {
  ...build,
  publish: null,
  forceCodeSigning: false,
  extraMetadata: { callsideCommunityBuild: true },
  files: [...build.files, '!desktop/bin/windows/**/*'],
  mac: {
    ...build.mac,
    target: ['dmg'],
    identity: '-',
    hardenedRuntime: false,
    notarize: false,
  },
};
