import { execFileSync } from 'node:child_process';
const identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
  encoding: 'utf8',
});
if (!identities.includes('Developer ID Application:'))
  throw Error(
    'Public releases require a Developer ID Application certificate. For an explicitly requested local release, use npm run desktop:dist -- --version <version>.',
  );
const e = process.env;
if (!(
  e.APPLE_KEYCHAIN_PROFILE ||
  (e.APPLE_ID && e.APPLE_APP_SPECIFIC_PASSWORD && e.APPLE_TEAM_ID) ||
  (e.APPLE_API_KEY && e.APPLE_API_KEY_ID && e.APPLE_API_ISSUER)
))
  throw Error(
    'Configure notarization credentials in the keychain or protected environment before building a public release.',
  );
console.log(
  'Developer ID signing and notarization configuration found. The build will notarize before generating the installer.',
);
