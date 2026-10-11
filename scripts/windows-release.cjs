// Public installers use a verified publisher. Unsigned QA previews have their
// own config and must never be promoted to a release by renaming the files.
const { build } = require('../package.json');
const preview = require('./windows-preview.cjs');

function signingOptions(env) {
  const publisherName = env.WINDOWS_PUBLISHER_NAME?.trim();
  if (!publisherName) throw Error('Set WINDOWS_PUBLISHER_NAME to the certificate publisher.');
  if (env.WINDOWS_SIGNING_PROVIDER === 'azure') {
    const required = ['AZURE_SIGNING_ENDPOINT', 'AZURE_SIGNING_ACCOUNT', 'AZURE_SIGNING_PROFILE'];
    for (const key of required) {
      if (!env[key]?.trim()) throw Error(`Missing Windows signing configuration: ${key}`);
    }
    const endpoint = new URL(env.AZURE_SIGNING_ENDPOINT);
    if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.codesigning.azure.net')) {
      throw Error('Use an official HTTPS Azure signing endpoint.');
    }
    return {
      azureSignOptions: {
        publisherName,
        endpoint: endpoint.href,
        codeSigningAccountName: env.AZURE_SIGNING_ACCOUNT,
        certificateProfileName: env.AZURE_SIGNING_PROFILE,
        fileDigest: 'SHA256',
        timestampDigest: 'SHA256',
      },
    };
  }
  if (env.WINDOWS_SIGNING_PROVIDER !== 'certificate') {
    throw Error(
      'Set WINDOWS_SIGNING_PROVIDER to azure or certificate. Unsigned public builds are disabled.',
    );
  }
  if (!env.WIN_CSC_LINK) throw Error('Set WIN_CSC_LINK in the protected release environment.');
  return { signtoolOptions: { publisherName, signingHashAlgorithms: ['sha256'] } };
}

module.exports = {
  ...build,
  // Keep the public app identity stable across versions.
  appId: 'org.callside.app',
  productName: 'Callside',
  artifactName: 'Callside-${version}-windows-${arch}.${ext}',
  directories: { output: '.local/windows-release' },
  afterAllArtifactBuild: undefined,
  forceCodeSigning: true,
  files: preview.files,
  extraResources: preview.extraResources,
  asarUnpack: preview.asarUnpack,
  win: {
    target: ['nsis', 'zip'],
    executableName: 'Callside',
    signExecutable: true,
    signExts: ['.dll'],
    verifyUpdateCodeSignature: true,
    requestedExecutionLevel: 'asInvoker',
    ...signingOptions(process.env),
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Callside',
    uninstallDisplayName: 'Callside',
    deleteAppDataOnUninstall: false,
    runAfterFinish: false,
  },
  extraMetadata: {
    callsideWindowsPreview: false,
    callsideBuildId: process.env.GITHUB_SHA || 'local-release',
  },
};
