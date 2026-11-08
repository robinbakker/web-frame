# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Connected mode: link Web Frame to Frame This with a connect code (`FRAME_THIS_TOKEN` in Docker), and Frame This
  decides what each TV shows.
- Web Frame reports TV state, its version and discovered Samsung TVs to Frame This.

### Security

- In connected mode, pages render without JavaScript and load only from Frame This and Google Fonts. Web Frame
  only connects to Samsung TVs at private addresses.

### Changed

- The Playwright image cache moves to `WEB_FRAME_DATA_DIR` when that variable is set.

### Fixed

- Pages that return an HTTP error (404, 5xx) are no longer sent to the TV; it keeps its last image.

## [1.0.2] - 2026-11-04

### Security

- The Docker containers run with minimal privileges and a read-only filesystem.
- The desktop app only installs updates that are signed by the maintainer.
- Docker images and the Windows installer can be verified as built from this repository (see the README).
- Releases need the maintainer's approval before they are published.

## [1.0.1] - 2026-11-01

### Fixed

- A TV connection that dropped (for example when the TV went to standby) no longer keeps reconnecting to the TV in
  the background every 3 seconds until the app restarts.
- The scheduler no longer logs "Deleted old images." when nothing was deleted.
- The release workflow now creates the GitHub Release before uploading the installer, so a release is no longer
  split in two with the blockmap left on the wrong one.

### Changed

- Updated Electron to 45.2.1, which includes upstream Chromium security fixes.

## [1.0.0] - 2026-10-24

Initial release.

[1.0.1]: https://github.com/robinbakker/web-frame/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/robinbakker/web-frame/releases/tag/v1.0.0
