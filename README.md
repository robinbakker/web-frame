<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/logo-white.svg">
  <img src="public/logo.svg" alt="Web Frame" width="308" height="72">
</picture>
  
###  

**Web Frame** screenshots a 🌍 webpage or downloads a png image and uploads it to a **Samsung The Frame TV** as 🖼️ Art Mode artwork. Run it on your local network, ideally on a NAS. It can be set to run on a schedule, so your Frame Art Mode updates automatically throughout the day!

This is designed as the "tv upload half" of a two-project setup. Link it to my other web project 🔗[Frame This](https://framethis.link), where you can choose from different dynamic art background sources and place widgets, and manage your TVs from there (see "Connected to Frame This" below).  
But of course you can get screenshots from any website you want! 😎

Web Frame is a TypeScript/Node.js project. By default, it takes website screenshots
using Playwright. An admin UI is included, but not required.

The default source is `website-screenshot` (also when `IMAGE_SOURCE` is missing or empty):

```dotenv
IMAGE_SOURCE=website-screenshot
CONTENT_URL=https://framethis.link/@demo/canvas
```

For working with an existing png, choose `png-image-url`; see the optional "slim" setup below.

<details><summary>🔗 Connected to Frame This</summary>

Link Web Frame to your [Frame This](https://framethis.link) account and manage everything there: which TV shows which channel, and when it updates. Web Frame then works as a bridge between Frame This and the TVs on your network. There's no `.env` to edit and no admin password.

1. In Frame This, open **TVs** and choose **Add bridge**. Copy the connect code (it starts with `ftd_`). Frame This shows it only once.
2. Install the bridge:
   - **Windows desktop app:** on first start, Web Frame asks for the connect code. After that it runs in the system tray. Its window shows the status of each TV, and **Unlink this computer** disconnects it.
   - **Docker (NAS, home server):** copy [`docker-compose.frame-this.yml`](docker-compose.frame-this.yml) and [`seccomp_profile.json`](seccomp_profile.json) into a folder, paste the connect code into `FRAME_THIS_TOKEN`, and run `docker compose -f docker-compose.frame-this.yml up -d`.
3. Back in Frame This, pick a TV the bridge found and choose a channel for it.

How it works:

- The bridge only makes outgoing requests. Every minute it asks Frame This what each TV should show. Frame This decides when a TV needs a new picture: right after you edit a screen, when a schedule switches, or as often as a clock or weather widget needs it.
- When a TV is in Art Mode and due, the bridge renders the channel's page and uploads it. It reports back whether each TV is reachable and in Art Mode, its model, and the last upload or error.
- It looks for Samsung TVs on your network and lists them in Frame This. On Docker this needs host networking (`network_mode: host`, as in the Compose file). Docker Desktop on Windows or macOS can reach a TV but not find it.

What Frame This can and can't do on your network: the bridge treats everything from Frame This as data. It only renders pages from `https://framethis.link`, with JavaScript off, and those pages can only load from Frame This and Google Fonts, never from your local network. It only connects to TVs at private addresses that answer as Samsung TVs. Frame This can't send it commands, scripts, settings or updates. [`docs/frame-this-protocol.md`](docs/frame-this-protocol.md) describes the protocol, and `npm run verify:connected` checks these limits in a real browser.

</details>

---

<details><summary>🖥️ Windows PC Desktop App (System Tray)</summary>

For personal Windows PCs, Web Frame can run as an always-running **taskbar system tray program**:
- **Connect to Frame This**: On first start, paste the connect code from Frame This and manage your TVs there (see "Connected to Frame This" above). Or choose **Use without Frame This** to set everything up in the dashboard below; the tray menu's "Connect to Frame This…" switches later.
- **Zero Docker / Zero Terminal Commands**: Runs quietly in the notification area and minimizes to the tray when the dashboard window is closed.
- **Native Embedded Dashboard**: Click the tray icon to configure URLs, TV IP, dimensions, and view artwork previews in a dedicated desktop window.
- **Built-in Offscreen Capture**: Uses Electron's internal Chromium engine to screenshot pages without needing Playwright or separate browser downloads.
- **Tray Quick Controls**: Right-click the tray icon to "Run Now" (instant screenshot & upload), pause/resume the scheduler, or toggle "Start with Windows".
- **Persistent Data & Pairing**: Stores user settings, output images, and TV authentication tokens in the app's folder under `%APPDATA%`, so Windows Disk Cleanup never wipes pairing keys.
- **Automatic Updates**: Checks for a new release at startup and every 6 hours, downloads it in the background, and installs it when you quit Web Frame (or right away via "Restart to Update" in the tray menu). An update is only installed when it carries the maintainer's signature, which is made offline and never stored on GitHub.

The PC must be on and on the same network as the TV for the artwork to update. The TV keeps showing the last image in the meantime. For clocks or other frequently changing content, an always-on machine such as a NAS works better.

### Install

Download `Web-Frame-Setup-<version>.exe` from the [latest release](https://github.com/robinbakker/web-frame/releases/latest) and run it.

ℹ️ The installer is not code-signed yet, so Windows SmartScreen may show "Windows protected your PC" (unknown publisher). Choose **More info → Run anyway**.

To check that an installer was built by this repository's release workflow (installers from the release after 1.0.1 onward), use the [GitHub CLI](https://cli.github.com/):

```bash
gh attestation verify Web-Frame-Setup-<version>.exe --repo robinbakker/web-frame
```

### Run Desktop App Locally
```bash
npm run electron:dev
```

### Package Installer
```bash
npm run electron:build
```
Builds `dist-app/Web-Frame-Setup-<version>.exe`, a standard Windows installer (creates Desktop and Start Menu shortcuts, with clean uninstaller). There is no portable build, because it could not update itself.

</details>

---

<details><summary>🐳 Quick start with Docker</summary>

ℹ️ If you don't have Docker installed, you can install 🐋[Docker Desktop](https://www.docker.com/products/docker-desktop/) first.

### 1. Configure

Create the root `.env` file:

```bash
cp .env.example .env
```

Set `TV_IP`, `CONTENT_URL`, and a unique `AUTH_PASS` of at least 16 characters in `.env`.
There is no default admin password. The admin server refuses to start with missing or weak credentials.

### 2. Start

```bash
docker compose up -d
```

This pulls the prebuilt image `ghcr.io/robinbakker/web-frame:latest` (amd64 and arm64). To build the image from your checkout instead, run `docker compose up -d --build`.

The container starts both the scheduler and the admin UI by default (http://localhost:33636). It runs on the schedule set by `SCHEDULE_INTERVAL` (default: `10m`), and the TV pairing token is persisted in a Docker volume so it survives restarts.

**Linux permissions:** the container runs as UID/GID 1000. Ensure `.env`, `output/`, and the token volume are writable by that user so settings saves and image generation work. The Synology Compose files repair these permissions automatically at startup.

Keep `seccomp_profile.json` alongside the Compose file when its entry is enabled in Compose. It is the [Playwright v1.64.1 sandbox profile](https://github.com/microsoft/playwright/blob/v1.64.1/utils/docker/seccomp_profile.json). Sandboxed browser startup requires host support for unprivileged user namespaces.

The Compose files run the container locked down: `no-new-privileges`, a read-only filesystem apart from the volumes and an in-memory `/tmp`, and as few Linux capabilities as possible. The app itself always runs as `node` without any. `docker-compose.yml` keeps only `SYS_CHROOT`, so the seccomp profile allows Chromium's sandbox. The Synology files start as root to repair folder permissions, so they keep the few capabilities that step, the switch to `node` and stopping the container need; the comments in those files list them. Keep these settings if you write your own Compose file, and never mount the Docker socket into this container.

> **Linux:** if the container can't reach the TV, uncomment `network_mode: host` in `docker-compose.yml` and change its `SERVER_HOST` environment override to `127.0.0.1`. Host networking bypasses Docker port publishing restrictions. The Synology configuration already uses loopback binding; access it through an HTTPS reverse proxy on the NAS or an SSH tunnel.

You can leave it running. As long as your TV is in Art Mode and the scheduler is running, the screen will be updated.

💡 A popup may appear on the TV asking to allow the connection → accept it. The token is saved automatically and reused on future connections.

### 3. Stop

If you want, you can stop the scheduler and admin UI by stopping the container (stop button in Docker Desktop).

```bash
docker compose stop
```

Or cleanup:

```bash
docker compose down
```

This will stop the service and remove the container plus the compose-created network.

### 4. Update

```bash
docker compose pull
docker compose up -d
```

Your `.env`, `output/` and the TV pairing token volume are kept. Releases are listed on the [releases page](https://github.com/robinbakker/web-frame/releases).

💡 Tools like Watchtower or What's Up Docker can pull new images automatically. They need access to the Docker socket, which gives full control over the host, so they are opt-in and not part of these Compose files.

**Verify an image** (images from the release after 1.0.1 onward): each image is signed with [cosign](https://docs.sigstore.dev/cosign/) and has a build provenance attestation. Either command checks that it was built by this repository's release workflow from a version tag:

```bash
gh attestation verify oci://ghcr.io/robinbakker/web-frame:latest --repo robinbakker/web-frame

cosign verify ghcr.io/robinbakker/web-frame:latest \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github\.com/robinbakker/web-frame/\.github/workflows/release\.yml@refs/tags/v'
```

**Synology docker deployment:**

1. On the NAS, choose a project folder (for example `/volume1/docker/web-frame/`).
2. Copy `docker-compose.synology.yml` as `docker-compose.yml` to this folder. Also add the `.env` file and create an `output/` folder.
3. Then in Container Manager, you can go to Project → Create. Set a project name and browse for the project folder path/location. It should pick up the compose file directly. Next and skip the web portal settings. Container Manager pulls `ghcr.io/robinbakker/web-frame:latest` on first start.
4. Now it should run right away. If needed, you can set up a reverse proxy for the Admin UI via Control Panel → Login Portal → Advanced → Reverse Proxy. Create a new rule, set a source (the outside accessible port) and destination e.g. 127.0.0.1 with port 33636 if you kept the default settings. This allows you to access the Admin UI via nas-name and port number in your browser within the local network.

To update on Synology, connect over SSH and run:

```bash
cd /volume1/docker/web-frame
sudo docker compose pull
sudo docker compose up -d
```

If you previously imported a `web-frame:latest` image from a `.tar` file, you can delete that image in Container Manager → Image after switching to the new Compose file.

DSM runs containers without seccomp, so check once that Chromium still starts with its sandbox. Copy [`scripts/check-sandbox.mjs`](scripts/check-sandbox.mjs) into the project folder and, with the container running, run:

```bash
cd /volume1/docker/web-frame
sudo docker compose exec -T -u node web-frame node --input-type=module < check-sandbox.mjs
```

It ends with `OK: Chromium is sandboxed.` when everything is in place. Don't set `CHROMIUM_SANDBOX=false` to get around a failure: that turns off the browser's protection against the pages it renders. Use the slim image instead, or open an issue with the script's output.

</details>

---

<details><summary>🏠 Manual/local setup</summary>

### Prerequisites

- Node.js 26+ (matches the Docker runtime and test environment)
- Samsung The Frame TV on the same local network

### 1. Install

```bash
npm ci
npx playwright install chromium-headless-shell
```

### 2. Configure

```bash
cp .env.example .env
# Edit .env — see Configuration below
```

### 3. Pair with the TV (first time only)

```bash
npx tsx src/cli.ts list
```

💡 A popup may appear on the TV asking to allow the connection → accept it. The token is saved automatically and reused on future connections.

</details>

---

<details><summary>ℹ️ About the Admin UI</summary>
  
Start the web interface:

```bash
npm run serve          # → http://127.0.0.1:33636
```

The UI lets you:

- Set `CONTENT_URL`, viewport/output dimensions, TV IP, and schedule interval
- **Scan for TVs** on your network and auto-fill the TV IP
- Preview the last generated screenshot
- Trigger screenshot, upload, or both
- Update admin credentials

**Credentials:** set `AUTH_USER` and a unique `AUTH_PASS` of at least 16 characters in `.env` before starting. Password changes in the Access section follow the same requirement.

Local execution binds to `127.0.0.1` by default. For direct HTTPS access, set `SERVER_HOST` to the desired interface and set both `SERVER_TLS_CERT` and `SERVER_TLS_KEY` to readable PEM files. In Docker, mount those files read-only and adjust the Compose host/port overrides deliberately. Binding a plain HTTP server to a network interface exposes Basic Auth credentials in transit.

The root `.env` file stores application settings for both local and Docker execution. UI changes are validated and saved directly to that file. Manual edits to the same file take effect on restart.

For deployment settings (`SERVER_HOST`, `SERVER_PORT`, `SERVER_TLS_CERT`,
`SERVER_TLS_KEY`, `PLAYWRIGHT_BROWSERS_PATH`, `NODE_ENV`, and `FRAME_THIS_TOKEN`), values explicitly
supplied in the process environment at startup take precedence over `.env`.
Connected to Frame This, `npm start` leaves the admin UI off: all settings come from Frame This.
TV, image, schedule, and admin credential settings continue to use `.env` and UI updates. No Docker detection or extra flag is needed. The scheduler reads `SCHEDULE_INTERVAL` once at startup, so you need to restart after a change.

</details>

---

<details><summary>🧑‍💻 CLI</summary>
  
Use command line interface (CLI) if you want to run individual tasks without the UI. Via npm scripts:

```bash
npm start                             # start scheduler and serve admin UI
npm run once                          # acquire selected image and upload (one-shot)
npm run generate                      # acquire selected image only
npm run screenshot                    # compatibility alias of generate
npm run upload                        # upload latest image to TV
npm run list                          # list artwork on TV
npm run cleanup                       # delete old uploads (keeps 10)
npm run scan                          # scan network for Samsung TVs
npm run serve                         # start admin UI
npm run electron:dev                  # run Windows desktop tray app in dev mode
npm run electron:build                # package Windows installer (.exe)
```

Or directly:

```bash
npx tsx src/cli.ts run
npx tsx src/cli.ts scan
npx tsx src/cli.ts generate
npx tsx src/cli.ts upload [path/to/image.png]
npx tsx src/cli.ts list
npx tsx src/cli.ts cleanup --keep 5   # delete old uploads (keeps 5)
npx tsx src/cli.ts scheduler          # run on SCHEDULE_INTERVAL loop
npx tsx src/cli.ts serve --port 3000  # start admin UI on port 3000
```

</details>

---

<details><summary>🌄 Browser-free image URLs and slim deployment</summary>

To download a png instead of taking a website screenshot, set:

```dotenv
IMAGE_SOURCE=png-image-url
IMAGE_URL=https://images.example.com/current-frame.png
```

The URL must return a complete static png over HTTPS GET.

**Standard Docker slim deployment:**

```bash
docker compose -f docker-compose.slim.yml up -d
```

This standalone Compose file pulls `ghcr.io/robinbakker/web-frame:slim`; add
`--build` to build it from your checkout with `--target slim` instead. Use the
same project directory/name to retain the token volume, `.env`, and `output/`.
Update with `docker compose -f docker-compose.slim.yml pull` followed by the
same `up -d` command.

**Synology slim deployment:**

1. On the NAS, choose a project folder (for example `/volume1/docker/web-frame/`).
2. Copy `docker-compose.synology.slim.yml` as `docker-compose.yml` to this folder. Also add the `.env` file and create an `output/` folder.
3. Then in Container Manager, you can go to Project → Create. Set a project name and browse for the project folder path/location. It should pick up the compose file directly. Next and skip the web portal settings. Container Manager pulls `ghcr.io/robinbakker/web-frame:slim` on first start.
4. Now it should run right away. If needed, you can set up a reverse proxy for the Admin UI via Control Panel → Login Portal → Advanced → Reverse Proxy. Create a new rule, set a source (the outside accessible port) and destination e.g. 127.0.0.1 with port 33636 if you kept the default settings. This allows you to access the Admin UI via nas-name and port number in your browser within the local network.

Update over SSH the same way as the full image: `sudo docker compose pull && sudo docker compose up -d` in the project folder.

</details>

---

<details><summary>⚙️ Configuration</summary>

Copy `.env.example` to `.env` and edit:

| Variable                               | Purpose                                        | Default                             |
| -------------------------------------- | ---------------------------------------------- | ----------------------------------- |
| `TV_IP`                                | Samsung Frame TV IP address\*                  | `192.168.1.100`                     |
| `IMAGE_SOURCE`                         | `website-screenshot` or `png-image-url`                            | `website-screenshot` (also when empty)       |
| `IMAGE_URL`                            | HTTPS static PNG URL; required in URL mode      | None                                |
| `CONTENT_URL`                          | HTTPS URL that Playwright screenshots          | https://framethis.link/@demo/canvas |
| `CONTENT_WIDTH`                        | Viewport width (CSS px)                        | `1920`                              |
| `CONTENT_HEIGHT`                       | Viewport height (CSS px)                       | `1080`                              |
| `OUTPUT_WIDTH`                         | Output image width (px)                        | `3840`                              |
| `OUTPUT_HEIGHT`                        | Retained screenshot setting; not independently applied                       | `2160`                              |
| `SCHEDULE_INTERVAL`                    | Scheduler interval (`10m`, `1h`, `6h`, `1d`)   | `10m`                               |
| `CHROMIUM_SANDBOX`                    | Browser sandbox; exact `false` opts out        | `true`                             |
| `PLAYWRIGHT_NETWORK_CACHE_DIR`         | Playwright image cache directory               | `.playwright-network-cache` in the data folder (`output/`) |
| `PLAYWRIGHT_NETWORK_CACHE_TTL_SECONDS` | Cached image TTL in seconds (0 = never expire) | `86400`                             |
| `SERVER_PORT`                          | Admin UI web server port                       | `33636`                             |
| `AUTH_USER`                            | Admin UI username                              | `webframe`                          |
| `AUTH_PASS`                            | Required unique admin password, minimum 16 characters | None                         |
| `SERVER_HOST`                          | Admin listen address (Compose overrides this)  | `127.0.0.1`                       |
| `SERVER_TLS_CERT` / `SERVER_TLS_KEY`    | Optional PEM certificate/key paths for HTTPS   | None                               |
| `WEB_FRAME_ENV_FILE`                   | Optional configuration file path override     | Root `.env` (`/app/.env` in Docker) |
| `WEB_FRAME_DATA_DIR`                   | Optional folder for generated images and TV state; also holds `.env` when `WEB_FRAME_ENV_FILE` is unset | `output/` |
| `WEB_FRAME_TOKEN_DIR`                  | Optional folder for the TV pairing token       | `data/` (`/app/data` in Docker); `<WEB_FRAME_DATA_DIR>/tokens` when that is set |
| `FRAME_THIS_TOKEN`                     | Connect code from Frame This; switches to connected mode, where the settings above (except the folders and `CHROMIUM_SANDBOX`) aren't used. Docker and the CLI only: the desktop app asks for the code in its own window | None |

### Find your TV's IP

\*) On the TV: **Settings → General → Network → Network Status**.

### Image cache and upload dedupe

- In Playwright mode, cached image GET responses are stored in `PLAYWRIGHT_NETWORK_CACHE_DIR` (default `output/.playwright-network-cache`, or `.playwright-network-cache` in `WEB_FRAME_DATA_DIR`).
- `PLAYWRIGHT_NETWORK_CACHE_TTL_SECONDS` controls expiry. Set `0` to keep forever.
- Successful upload and selection are recorded per TV in `output/.tv-state/`. Failed uploads or selections remain eligible for retry; scheduler failures retry on the next check.
- If the acquired image hash matches the last successfully selected image on that TV, upload is skipped automatically.
- Cleanup only deletes IDs recorded as uploaded by this installation to that TV. Personal artwork and other untracked images are preserved. Keep `output/.tv-state/` with your application data so cleanup can identify its uploads. Scheduler cleanup retains five tracked images.

</details>

---

<details><summary>⁉️ Troubleshooting</summary>

**TV not responding / connection hangs**

- Ensure the TV is in Art Mode or turned on (not deep standby)
- Check `http://TV_IP:8001/api/v2/` returns JSON in your browser
- On Linux with Docker, uncomment `network_mode: host` in `docker-compose.yml`

**Pairing prompt doesn't appear**

- Most same-LAN connections are accepted automatically without a prompt
- If stuck, delete `.samsung-frame-connect-com.samsung.art-app-token` from the token folder (`data/` locally, the `/app/data` volume in Docker, `tokens` in the desktop app's `%APPDATA%` folder) and reconnect

**Upload fails / TV rejected the image**

- The TV requires a minimum image size. Don't upload small test images
- Target 3840×2160 for best results on The Frame 43"+ (1920×1080 for the 32" model)

**Screenshot times out**

- If your content URL makes background requests that never settle, `networkidle` may time out (60s limit). Switch to a simpler page or one that stops polling after initial load.

</details>

---

## Credits

This project is running on a couple of fantastic projects:  
🛜 TV communication powered by [samsung-frame-connect](https://github.com/foxxyz/samsung-frame-connect) by [foxxyz](https://github.com/foxxyz).  
🎭 [Playwright](https://github.com/microsoft/playwright) creates the screenshot.

Made using LLM's, mostly used ChatGPT/Codex and Claude Code.

📺 Confirmed working on The Frame 65" LS03B (2023)  
Works on my machine!™️

Web Frame is created by [Robin Bakker](https://robinbakker.nl) 👋
