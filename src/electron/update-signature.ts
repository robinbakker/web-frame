/**
 * Desktop update signatures. The maintainer signs each installer offline with an Ed25519 key
 * (scripts/release-sign.mjs), and the app only installs an update whose signature matches the public
 * key built into it. Publishing a GitHub release is therefore not enough to push an update.
 *
 * Shared by the app, the signing script and the tests, so the signed message can't drift between them.
 * No Electron imports: plain Node loads this too.
 */
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { closeSync, createReadStream, openSync, readSync } from 'node:fs';
import { UPDATE_PUBLIC_KEY } from './update-public-key.js';

// Must match nsis.artifactName in electron-builder.yml (test/update-signature.test.mjs checks this).
export const installerFileName = (version: string): string => `Web-Frame-Setup-${version}.exe`;
export const signatureFileName = (version: string): string => `${installerFileName(version)}.sig`;

/** Versions come from the release feed, so only plain semver may be used in a file name or URL. */
export const isReleaseVersion = (version: string): boolean => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(version);

/**
 * The signed bytes. The installer's file name carries its version, so a signed old installer can't be
 * served as a newer release: the app builds the expected name from the version it's updating to.
 */
export function signatureMessage(fileName: string, sha512: string): Buffer {
  return Buffer.from(`web-frame-update-signature-v1\n${fileName}\n${sha512}\n`, 'utf8');
}

/** SHA-512 of a file as base64, the same encoding electron-builder uses in latest.yml. */
export async function sha512File(path: string): Promise<string> {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('base64');
}

/** Same as sha512File, for the app's quit handler, which can't wait for a promise. */
export function sha512FileSync(path: string): string {
  const hash = createHash('sha512');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = openSync(path, 'r');
  try {
    for (let read; (read = readSync(fd, buffer, 0, buffer.length, null)) > 0; ) hash.update(buffer.subarray(0, read));
  } finally {
    closeSync(fd);
  }
  return hash.digest('base64');
}

export function loadUpdatePublicKey(base64Spki: string = UPDATE_PUBLIC_KEY): KeyObject {
  if (!base64Spki.trim()) {
    throw new Error('No update signing key is built in; run npm run release:keygen (docs/releasing.md)');
  }
  const key = createPublicKey({ key: Buffer.from(base64Spki, 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('The update signing key must be an Ed25519 public key');
  return key;
}

/** True only for a valid Ed25519 signature (base64) over this file name and hash. Never throws. */
export function verifyUpdateSignature(
  fileName: string,
  sha512: string,
  signatureBase64: string,
  publicKey: KeyObject,
): boolean {
  const encoded = signatureBase64.trim();
  // A 64-byte Ed25519 signature is exactly 86 base64 characters plus "==".
  if (!/^[A-Za-z0-9+/]{86}==$/.test(encoded)) return false;
  try {
    return verify(null, signatureMessage(fileName, sha512), publicKey, Buffer.from(encoded, 'base64'));
  } catch {
    return false;
  }
}
