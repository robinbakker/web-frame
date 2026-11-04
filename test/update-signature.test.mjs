import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installerFileName,
  isReleaseVersion,
  loadUpdatePublicKey,
  sha512File,
  sha512FileSync,
  signatureMessage,
  verifyUpdateSignature,
} from '../dist/electron/update-signature.js';

// The same key formats scripts/release-sign.mjs keygen produces.
function keyPair() {
  const passphrase = 'correct horse battery staple';
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase },
  });
  return {
    publicKey: loadUpdatePublicKey(publicKey.toString('base64')),
    privateKey: createPrivateKey({ key: privateKey, format: 'pem', passphrase }),
  };
}

async function signedInstaller(version, privateKey, contents = 'installer bytes') {
  const dir = await mkdtemp(join(tmpdir(), 'web-frame-update-'));
  const file = join(dir, installerFileName(version));
  await writeFile(file, contents);
  const sha512 = await sha512File(file);
  const signature = sign(null, signatureMessage(installerFileName(version), sha512), privateKey).toString('base64');
  return { dir, file, sha512, signature };
}

test('a signed installer verifies', async () => {
  const { publicKey, privateKey } = keyPair();
  const { dir, sha512, signature } = await signedInstaller('1.2.3', privateKey);
  try {
    assert.equal(verifyUpdateSignature('Web-Frame-Setup-1.2.3.exe', sha512, signature, publicKey), true);
    assert.equal(verifyUpdateSignature('Web-Frame-Setup-1.2.3.exe', sha512, `${signature}\n`, publicKey), true);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('an old signed installer cannot be served as a newer version', async () => {
  const { publicKey, privateKey } = keyPair();
  const { dir, sha512, signature } = await signedInstaller('1.2.3', privateKey);
  try {
    assert.equal(verifyUpdateSignature(installerFileName('1.2.4'), sha512, signature, publicKey), false);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('a modified installer, another key or a malformed signature is rejected', async () => {
  const { publicKey, privateKey } = keyPair();
  const { dir, file, signature } = await signedInstaller('1.2.3', privateKey);
  try {
    await writeFile(file, 'tampered installer bytes');
    const name = installerFileName('1.2.3');
    assert.equal(verifyUpdateSignature(name, await sha512File(file), signature, publicKey), false);

    const current = await sha512File(file);
    const other = keyPair();
    const foreign = sign(null, signatureMessage(name, current), other.privateKey).toString('base64');
    assert.equal(verifyUpdateSignature(name, current, foreign, publicKey), false);

    for (const malformed of ['', 'not base64', 'AAAA', Buffer.alloc(63).toString('base64'), `${signature}x`]) {
      assert.equal(verifyUpdateSignature(name, current, malformed, publicKey), false);
    }
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('the install-time hash matches the verified hash until the installer changes', async () => {
  const { privateKey } = keyPair();
  // Larger than the 1 MiB read buffer, so the chunked loop is exercised.
  const { dir, file, sha512 } = await signedInstaller('1.2.3', privateKey, Buffer.alloc(3 * 1024 * 1024 + 7, 1));
  try {
    assert.equal(sha512FileSync(file), sha512);
    await writeFile(file, 'tampered installer bytes');
    assert.notEqual(sha512FileSync(file), sha512);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('the update key must be present and Ed25519', () => {
  assert.throws(() => loadUpdatePublicKey(''), /No update signing key/);
  const { publicKey: rsa } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
  });
  assert.throws(() => loadUpdatePublicKey(rsa.toString('base64')), /Ed25519/);
});

test('only plain release versions are accepted from the update feed', () => {
  for (const version of ['1.2.3', '10.0.0', '1.2.3-beta.1']) assert.equal(isReleaseVersion(version), true, version);
  for (const version of ['v1.2.3', '1.2', '1.2.3/../../x', '1.2.3-../x', '1.2.3 ', '']) {
    assert.equal(isReleaseVersion(version), false, version);
  }
});

test('the installer name matches electron-builder.yml', async () => {
  const config = await readFile(new URL('../electron-builder.yml', import.meta.url), 'utf8');
  const pattern = config.match(/^\s*artifactName: (.+)$/m)?.[1].trim();
  assert.equal(pattern?.replace('${version}', '1.2.3').replace('${ext}', 'exe'), installerFileName('1.2.3'));
});
