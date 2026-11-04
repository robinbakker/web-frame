// Signs a desktop release with the offline update key, then publishes it. See docs/releasing.md.
//
//   npm run release:keygen               create the key pair (once)
//   npm run release:sign [-- v1.2.3]     sign and publish that draft release (default: package.json version)
//
// The private key never leaves this machine. Keep the key file and its passphrase backed up: without them,
// installed apps can't be updated any more. Set WEB_FRAME_UPDATE_KEY to keep the key somewhere else.
// Needs the GitHub CLI (gh), signed in to an account that can edit the repository's releases.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'robinbakker/web-frame';
const KEY_FILE = process.env.WEB_FRAME_UPDATE_KEY || join(homedir(), '.web-frame', 'update-signing-key.pem');
const PUBLIC_KEY_SOURCE = join(ROOT, 'src', 'electron', 'update-public-key.ts');

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

function gh(args) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  } catch (error) {
    if (error.code === 'ENOENT') fail('Install the GitHub CLI (https://cli.github.com/) and run gh auth login first.');
    fail(`gh ${args.slice(0, 2).join(' ')} failed (see above).`);
  }
}

/** Reads a line from the terminal without echoing it. */
function askHidden(question) {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) fail('Run this in an interactive terminal: it asks for the key passphrase.');
  stdout.write(question);
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  return new Promise((resolve) => {
    let value = '';
    const onData = (text) => {
      for (const char of text) {
        if (char === '\u0003') {
          stdout.write('\n');
          process.exit(130);
        } else if (char === '\r' || char === '\n') {
          stdin.off('data', onData);
          stdin.setRawMode(false);
          stdin.pause();
          stdout.write('\n');
          resolve(value);
          return;
        } else if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
        } else {
          value += char;
        }
      }
    };
    stdin.on('data', onData);
  });
}

async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

async function keygen() {
  if (existsSync(KEY_FILE)) {
    fail(`${KEY_FILE} already exists. Installed apps only accept updates signed with it, so it is never replaced here.`);
  }
  const passphrase = await askHidden('New passphrase for the update key (at least 16 characters): ');
  if (passphrase.length < 16) fail('Use at least 16 characters.');
  if ((await askHidden('Repeat the passphrase: ')) !== passphrase) fail('The passphrases differ.');

  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase },
  });
  mkdirSync(dirname(KEY_FILE), { recursive: true });
  writeFileSync(KEY_FILE, privateKey, { mode: 0o600, flag: 'wx' });

  const source = readFileSync(PUBLIC_KEY_SOURCE, 'utf8');
  const updated = source.replace(
    /^export const UPDATE_PUBLIC_KEY = '[^']*';/m,
    `export const UPDATE_PUBLIC_KEY = '${publicKey.toString('base64')}';`,
  );
  if (updated === source) fail(`Could not find UPDATE_PUBLIC_KEY in ${PUBLIC_KEY_SOURCE}.`);
  writeFileSync(PUBLIC_KEY_SOURCE, updated);

  console.log(`
Private key: ${KEY_FILE} (encrypted with your passphrase)
Public key:  written to src/electron/update-public-key.ts; commit that file.

Back up the key file and the passphrase now, separately (for example a USB stick and a password manager).
If either is lost, installed apps can't receive updates any more and everyone has to reinstall by hand.`);
}

async function signRelease(tagArgument) {
  const { installerFileName, isReleaseVersion, loadUpdatePublicKey, sha512File, signatureFileName, signatureMessage, verifyUpdateSignature } =
    await import('../dist/electron/update-signature.js');

  const tag = tagArgument ?? `v${JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version}`;
  const version = tag.replace(/^v/, '');
  if (!tag.startsWith('v') || !isReleaseVersion(version)) fail(`"${tag}" is not a release tag such as v1.2.3.`);
  const installer = installerFileName(version);
  const signatureName = signatureFileName(version);

  // The key must match the one built into the apps, or they reject the update. To rotate the key, run this
  // from a checkout of the previous release, so the old key signs the release that ships the new one.
  if (!existsSync(KEY_FILE)) fail(`No key at ${KEY_FILE}. Run npm run release:keygen first, or set WEB_FRAME_UPDATE_KEY.`);
  const embeddedKey = loadUpdatePublicKey();

  const release = JSON.parse(gh(['release', 'view', tag, '--repo', REPO, '--json', 'isDraft,assets']));
  if (!release.isDraft) fail(`${tag} is already published.`);
  const assets = release.assets.map((asset) => asset.name);
  for (const name of [installer, 'latest.yml']) {
    if (!assets.includes(name)) fail(`The ${tag} draft has no ${name} yet. Wait for the release workflow to finish.`);
  }
  if (assets.includes(signatureName)) fail(`The ${tag} draft already has ${signatureName}. Delete it on GitHub to sign again.`);

  const dir = mkdtempSync(join(tmpdir(), 'web-frame-release-'));
  try {
    console.log(`Downloading ${installer} and latest.yml from the ${tag} draft…`);
    gh(['release', 'download', tag, '--repo', REPO, '--dir', dir, '--pattern', installer, '--pattern', 'latest.yml']);
    const file = join(dir, installer);
    const sha512 = await sha512File(file);

    // The update feed must describe this exact file, or apps would download something other than what is signed.
    const feed = readFileSync(join(dir, 'latest.yml'), 'utf8');
    const field = (name) => feed.match(new RegExp(`^${name}: *'?([^'\\r\\n]*)'?\\r?$`, 'm'))?.[1];
    if (field('version') !== version || field('path') !== installer || field('sha512') !== sha512) {
      fail(`latest.yml in the ${tag} draft doesn't describe this installer (version, path or sha512 differ). Not signing.`);
    }

    // Only sign what release.yml built from this tag on GitHub's runners.
    console.log('Checking build provenance…');
    gh([
      'attestation', 'verify', file,
      '--repo', REPO,
      '--signer-workflow', `${REPO}/.github/workflows/release.yml`,
      '--source-ref', `refs/tags/${tag}`,
      '--deny-self-hosted-runners',
    ]);
    console.log('Provenance OK: built by release.yml from this tag.');

    let privateKey;
    try {
      privateKey = createPrivateKey({
        key: readFileSync(KEY_FILE),
        format: 'pem',
        passphrase: await askHidden(`Passphrase for ${KEY_FILE}: `),
      });
    } catch {
      fail('Could not open the key: wrong passphrase, or not a key made by release:keygen.');
    }
    if (!createPublicKey(privateKey).equals(embeddedKey)) {
      fail('This private key does not match UPDATE_PUBLIC_KEY in src/electron/update-public-key.ts. Not signing.');
    }
    const signature = sign(null, signatureMessage(installer, sha512), privateKey).toString('base64');
    if (!verifyUpdateSignature(installer, sha512, signature, embeddedKey)) fail('The new signature does not verify. Not uploading.');
    const signatureFile = join(dir, signatureName);
    writeFileSync(signatureFile, `${signature}\n`);

    console.log(`
Release:   ${tag} (draft)
Installer: ${installer}
SHA-512:   ${sha512}
Signed with the key at ${KEY_FILE}.`);
    if (!(await confirm(`\nUpload ${signatureName} and publish ${tag}? [y/N] `))) {
      console.log('Nothing uploaded. The release is still a draft.');
      return;
    }
    gh(['release', 'upload', tag, signatureFile, '--repo', REPO]);
    gh(['release', 'edit', tag, '--repo', REPO, '--draft=false']);
    console.log(`Published ${tag}. Installed apps pick it up within 6 hours.`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const [command, tag] = process.argv.slice(2);
if (command === 'keygen') await keygen();
else if (command === 'sign') await signRelease(tag);
else fail('Usage: node scripts/release-sign.mjs keygen | sign [vX.Y.Z]');
