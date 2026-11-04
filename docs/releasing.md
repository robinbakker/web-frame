# Releasing

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
2. Tag and push: `git tag v1.2.3 && git push origin v1.2.3`.
3. The `check` job runs the tests. The publishing jobs then wait in **Actions → the run → Review deployments**.
   Approve `release` to push the Docker images and build the Windows installer.
4. When the run is green, sign and publish the desktop release from your own machine:

   ```bash
   npm run release:sign            # or: npm run release:sign -- v1.2.3
   ```

   It downloads the installer from the draft release, checks that `latest.yml` describes it and that `release.yml` built
   it from this tag (`gh attestation verify`), asks for the key passphrase, uploads `Web-Frame-Setup-<version>.exe.sig`
   and publishes the release after you confirm. Until then the release is a draft, which installed apps can't see.

The Docker images are live as soon as you approve step 3; only the desktop release waits for step 4.

## Why releases are locked down

A web-frame release runs on people's home networks: the Docker image usually runs with `network_mode: host`, and the
desktop app runs as the user and installs updates by itself. Anyone who can publish a release can therefore run code
inside every user's LAN. The setup below makes that hard:

- **Signed updates:** the desktop app only installs an update whose `.sig` file verifies against the Ed25519 public key
  built into it (`src/electron/update-public-key.ts`). The private key never touches GitHub, so a stolen GitHub login or
  token can publish a release but can't make installed apps run it. The signature covers the installer's file name,
  which includes the version, so an old installer can't be passed off as a new one.
- **`release` environment:** publishing waits for a reviewer, and only `v*` tags can use it.
- **Provenance:** images are signed with cosign and have a provenance attestation, as does the installer. Anyone can
  check that they were built by `release.yml` from a tag in this repository (see the README), and `release:sign` checks
  it before signing.
- **Pinned actions and a dependency cooldown:** see `.github/dependabot.yml`.

What this does not stop: someone with your GitHub login, or a token with `repo` scope (including the `gh` CLI's), can
approve the deployment, or push a workflow that publishes images with the repository's own token. Docker users are only
protected by the account settings below, and by checking the image themselves.

The installer isn't Authenticode-signed, so Windows SmartScreen shows "unknown publisher" on first install (users choose
**More info → Run anyway**). electron-updater's own publisher check only runs for Authenticode-signed builds, which is
why the app checks the offline signature itself.

## Update signing key

Create it once, before the first release that contains the signature check:

```bash
npm run release:keygen
```

- The private key goes to `~/.web-frame/update-signing-key.pem`, encrypted with the passphrase you choose. Set
  `WEB_FRAME_UPDATE_KEY` to keep it elsewhere (for example on a USB stick); both scripts read that variable.
- The public key is written into `src/electron/update-public-key.ts`. Commit that file. The release workflow refuses to
  build the installer while it's empty.
- Never put the private key in the repository or in GitHub secrets.
- **Back up the key file and the passphrase**, separately. If either is lost, installed apps can't receive updates any
  more, and everyone has to download a new installer by hand.

Apps installed before the first release with the check (1.0.1 and older) still install whatever the next release is,
without checking. From that release on, every update must be signed.

To replace the key: run `release:keygen` with `WEB_FRAME_UPDATE_KEY` pointing at a new file, commit the new public key,
and tag a release. Sign that one release with the **old** key, by running `release:sign` from a checkout of the previous
release tag (the script checks the key against the public key in the checkout). Sign later releases with the new key.

Later, free Authenticode signing through the [SignPath Foundation](https://signpath.org/) (open-source projects; the
publisher then shows as "SignPath Foundation") would remove the SmartScreen prompt. Keep the offline signature check
even then: it doesn't depend on any third party.

## One-time GitHub setup

1. **Account:** sign in with a passkey or security key. Remove classic personal access tokens you don't need; prefer
   fine-grained tokens with an expiry.
2. **Environment** (Settings → Environments → New environment → `release`):
   - Required reviewers: yourself. Leave "Prevent self-review" off while you're the only maintainer.
   - Deployment branches and tags: "Selected branches and tags" → add a **tag** rule `v*`.
3. **Tag rulesets** (Settings → Rules → Rulesets → New tag ruleset), both with enforcement Active and target `v*`.
   A ruleset's bypass list applies to all its rules, so this takes two:
   - `release tags`: Restrict updates and Restrict deletions, with an empty bypass list. A published tag can't be
     moved to another commit, not even by you.
   - `release tag creation`: Restrict creations, with Repository admin on the bypass list. Only admins can start a
     release.
4. **Immutable releases** (Settings → General → Releases → Enable release immutability): published releases can't
   have their assets or tag changed. The `.sig` file is uploaded while the release is still a draft, so this works.
5. **Actions** (Settings → Actions → General):
   - Workflow permissions: "Read repository contents and packages permissions" (jobs request what they need).
   - "Allow GitHub Actions to create and approve pull requests": off.
   - Fork pull request workflows: require approval for all external contributors.
