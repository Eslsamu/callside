import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const configPath = require.resolve('../scripts/windows-release.cjs');
const load = () => {
  delete require.cache[configPath];
  return require(configPath);
};

afterEach(() => {
  vi.unstubAllEnvs();
  delete require.cache[configPath];
});

describe('public Windows release signing', () => {
  it('fails closed with missing signing credentials instead of creating an unsigned release', () => {
    vi.stubEnv('WINDOWS_PUBLISHER_NAME', 'Callside test publisher');
    vi.stubEnv('WINDOWS_SIGNING_PROVIDER', 'certificate');
    vi.stubEnv('WIN_CSC_LINK', '');
    expect(load).toThrow('WIN_CSC_LINK');
    vi.stubEnv('WINDOWS_SIGNING_PROVIDER', 'unsigned');
    expect(load).toThrow('Unsigned public builds are disabled');
  });

  it('keeps the public app identity and model bundle while requiring signed updates', () => {
    vi.stubEnv('WINDOWS_PUBLISHER_NAME', 'Callside test publisher');
    vi.stubEnv('WINDOWS_SIGNING_PROVIDER', 'certificate');
    vi.stubEnv('WIN_CSC_LINK', '/test/fixture.pfx');
    const config = load();
    expect(config.appId).toBe('org.callside.app');
    expect(config.forceCodeSigning).toBe(true);
    expect(config.win.signExecutable).toBe(true);
    expect(config.win.verifyUpdateCodeSignature).toBe(true);
    expect(config.win.signtoolOptions.publisherName).toBe('Callside test publisher');
    expect(config.extraMetadata.callsideWindowsPreview).toBe(false);
    expect(
      config.extraResources.some((r: { to: string }) => r.to === 'models/ggml-small-q5_1.bin'),
    ).toBe(true);
    expect(config.extraResources.some((r: { to: string }) => r.to === 'models/speakers')).toBe(
      true,
    );
    expect(config.afterAllArtifactBuild).toBeUndefined();
  });

  it('rejects an arbitrary signing endpoint before credentials can be transmitted', () => {
    vi.stubEnv('WINDOWS_PUBLISHER_NAME', 'Callside test publisher');
    vi.stubEnv('WINDOWS_SIGNING_PROVIDER', 'azure');
    vi.stubEnv('AZURE_SIGNING_ACCOUNT', 'test-account');
    vi.stubEnv('AZURE_SIGNING_PROFILE', 'test-profile');
    vi.stubEnv('AZURE_SIGNING_ENDPOINT', 'https://unrelated.example');
    expect(load).toThrow('official HTTPS Azure');
    vi.stubEnv('AZURE_SIGNING_ENDPOINT', 'https://weu.codesigning.azure.net/');
    expect(load().win.azureSignOptions.certificateProfileName).toBe('test-profile');
  });
});
