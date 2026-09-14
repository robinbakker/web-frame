<img src="./public/logo.png" alt="Web Frame logo" />

**Web Frame** screenshots a 🌍 webpage or downloads a png image and uploads it to a **Samsung The Frame TV** as 🖼️ Art Mode artwork. Run it on your local network, ideally on a NAS. It can be set to run on a schedule, so your Frame Art Mode updates automatically throughout the day!

This is designed as the "tv upload half" of a two-project setup. You can use a URL from my other web project 🔗[Frame This](https://framethis.link), where you can choose from different dynamic art background sources and place widgets.  
But of course you can get screenshots from any website you want! 😎

Web Frame is a TypeScript/Node.js project. By default, it takes website screenshots
using Playwright. An admin UI is included, but not required.

The default source is `website-screenshot` (also when `IMAGE_SOURCE` is missing or empty):

```dotenv
IMAGE_SOURCE=website-screenshot
CONTENT_URL=https://framethis.link/@demo/canvas
```

For working with an existing png, choose `png-image-url`; see the optional "slim" setup below.

<details><summary>Quick start with Docker</summary>

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

The container starts both the scheduler and the admin UI by default (http://localhost:33636). It runs on the schedule set by `SCHEDULE_INTERVAL` (default: `10m`), and the TV pairing token is persisted in a Docker volume so it survives restarts.

**Linux permissions:** the container runs as UID/GID 1000. Ensure `.env`, `output/`, and the token volume are writable by that user so settings saves and image generation work. The Synology Compose files repair these permissions automatically at startup.

Keep `seccomp_profile.json` alongside the Compose file when its entry is enabled in Compose. It is the [Playwright v1.63.0 sandbox profile](https://github.com/microsoft/playwright/blob/v1.63.0/utils/docker/seccomp_profile.json). Sandboxed browser startup requires host support for unprivileged user namespaces.

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

**Synology docker deployment:**

First you have to create the image file locally.

```bash
docker build -t web-frame:latest .
docker image save -o web-frame.tar web-frame:latest
```

1. On the NAS, choose a project folder (for example `/volume1/docker/web-frame/`).
2. Copy `docker-compose.synology.yml` as `docker-compose.yml` to this folder. Also add the `.env` file and create an `output/` folder.
3. Import `web-frame.tar` through Container Manager → Image → Add → Import.
4. Then in Container Manager, you can go to Project → Create. Set a project name and browse for the project folder path/location. It should pick up the compose file directly. Next and skip the web portal settings.
5. Now it should run right away. If needed, you can set up a reverse proxy for the Admin UI via Control Panel → Login Portal → Advanced → Reverse Proxy. Create a new rule, set a source (the outside accessible port) and destination e.g. 127.0.0.1 with port 33636 if you kept the default settings. This allows you to access the Admin UI via nas-name and port number in your browser within the local network.

</details>

---

<details><summary>Manual/local setup</summary>

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

<details><summary>About the Admin UI</summary>
  
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
`SERVER_TLS_KEY`, `PLAYWRIGHT_BROWSERS_PATH`, and `NODE_ENV`), values explicitly
supplied in the process environment at startup take precedence over `.env`.
TV, image, schedule, and admin credential settings continue to use `.env` and UI updates. No Docker detection or extra flag is needed. The scheduler reads `SCHEDULE_INTERVAL` once at startup, so you need to restart after a change.

</details>

---

<details><summary>CLI</summary>
  
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

<details><summary>Browser-free image URLs and slim deployment</summary>

🌄 To download a png instead of taking a website screenshot, set:

```dotenv
IMAGE_SOURCE=png-image-url
IMAGE_URL=https://images.example.com/current-frame.png
```

The URL must return a complete static png over HTTPS GET.

**Standard Docker slim deployment:**

```bash
docker compose -f docker-compose.slim.yml up -d --build
```

This standalone Compose file builds the local `web-frame:slim` image with
`--target slim`. Use the same project directory/name to retain the token
volume, `.env`, and `output/`.

**Synology slim deployment:**

```bash
docker build --target slim -t web-frame:slim .
docker save -o web-frame-slim.tar web-frame:slim
```

1. On the NAS, choose a project folder (for example `/volume1/docker/web-frame/`).
2. Copy `docker-compose.synology.slim.yml` as `docker-compose.yml` to this folder. Also add the `.env` file and create an `output/` folder.
3. Import `web-frame-slim.tar` through Container Manager → Image → Add → Import.
4. Then in Container Manager, you can go to Project → Create. Set a project name and browse for the project folder path/location. It should pick up the compose file directly. Next and skip the web portal settings.
5. Now it should run right away. If needed, you can set up a reverse proxy for the Admin UI via Control Panel → Login Portal → Advanced → Reverse Proxy. Create a new rule, set a source (the outside accessible port) and destination e.g. 127.0.0.1 with port 33636 if you kept the default settings. This allows you to access the Admin UI via nas-name and port number in your browser within the local network.

</details>

---

<details><summary>Configuration</summary>

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
| `PLAYWRIGHT_NETWORK_CACHE_DIR`         | Playwright image cache directory               | `output/.playwright-network-cache`  |
| `PLAYWRIGHT_NETWORK_CACHE_TTL_SECONDS` | Cached image TTL in seconds (0 = never expire) | `86400`                             |
| `SERVER_PORT`                          | Admin UI web server port                       | `33636`                             |
| `AUTH_USER`                            | Admin UI username                              | `webframe`                          |
| `AUTH_PASS`                            | Required unique admin password, minimum 16 characters | None                         |
| `SERVER_HOST`                          | Admin listen address (Compose overrides this)  | `127.0.0.1`                       |
| `SERVER_TLS_CERT` / `SERVER_TLS_KEY`    | Optional PEM certificate/key paths for HTTPS   | None                               |
| `WEB_FRAME_ENV_FILE`                   | Optional configuration file path override     | Root `.env` (`/app/.env` in Docker) |

### Find your TV's IP

\*) On the TV: **Settings → General → Network → Network Status**.

### Image cache and upload dedupe

- In Playwright mode, cached image GET responses are stored in `PLAYWRIGHT_NETWORK_CACHE_DIR` (default `output/.playwright-network-cache`).
- `PLAYWRIGHT_NETWORK_CACHE_TTL_SECONDS` controls expiry. Set `0` to keep forever.
- Successful upload and selection are recorded per TV in `output/.tv-state/`. Failed uploads or selections remain eligible for retry; scheduler failures retry on the next check.
- If the acquired image hash matches the last successfully selected image on that TV, upload is skipped automatically.
- Cleanup only deletes IDs recorded as uploaded by this installation to that TV. Personal artwork and other untracked images are preserved. Keep `output/.tv-state/` with your application data so cleanup can identify its uploads. Scheduler cleanup retains five tracked images.

</details>

---

<details><summary>Troubleshooting</summary>

**TV not responding / connection hangs**

- Ensure the TV is in Art Mode or turned on (not deep standby)
- Check `http://TV_IP:8001/api/v2/` returns JSON in your browser
- On Linux with Docker, uncomment `network_mode: host` in `docker-compose.yml`

**Pairing prompt doesn't appear**

- Most same-LAN connections are accepted automatically without a prompt
- If stuck, delete `$TMPDIR/.samsung-frame-connect-com.samsung.art-app-token` and reconnect

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

Made using LLM's, mostly used Claude (chat) and ChatGPT/Codex.

📺 Confirmed working on The Frame 65" LS03B (2023)  
Works on my machine!™️

Web Frame is created by [Robin Bakker](https://robinbakker.nl) 👋.
