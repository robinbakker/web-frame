// Ed25519 public key (base64 SPKI) that desktop updates must be signed with. `npm run release:keygen`
// writes it; the private key stays offline with the maintainer (docs/releasing.md).
// While this is empty the app installs no updates, and the release workflow won't build the installer.
export const UPDATE_PUBLIC_KEY = 'MCowBQYDK2VwAyEA7CFLiVRabUVaWpyFdRyDPWKdvLULNiKMjiJvYyQXkS0=';
