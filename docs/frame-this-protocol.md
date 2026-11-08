# Frame This device protocol (v1)

How a Web Frame bridge in connected mode talks to Frame This. This document is the only coupling between the two repos. Change it together with `api/src/routes/devices.ts` and `api/src/display/device-config.ts` in frame-this.

The bridge only makes outgoing HTTPS requests. Frame This can't reach the LAN, so the bridge polls.

## Basics

- **Origin:** `https://framethis.link`. The device API lives on `https://api.framethis.link`, and display pages on `https://framethis.link/@…`. The bridge hard-codes both. It never takes an origin from a response.
- **Auth:** `Authorization: Bearer <token>`. A token looks like `ftd_` + 43 base64url characters. The user creates it in the dashboard ("Add bridge") and sees it once. Frame This stores only its SHA-256.
- **User-Agent:** `web-frame/<version> (<platform>)`, for example `web-frame/1.2.3 (docker)` or `web-frame/1.2.3 (electron-win)`. `<version>` is semver.
- **Versioning:** the major version is in the path (`/api/device/v1`). Changes within v1 only add fields. The bridge ignores fields it doesn't know (zod `strip`).
- **Rate limit:** 30 requests a minute per token. A `429` comes with `Retry-After: 60`.
- **Errors:** JSON `{ "error": "…" }`. A `401` means the token is missing, malformed, unknown, replaced by a new connect code, or the bridge was removed. Show "Link this bridge again" and stop polling until the token changes.
- **Local development:** `wrangler dev` serves the device API and the display pages from one origin, and signs display URLs with `BETTER_AUTH_URL`. Start the bridge with `FRAME_THIS_DEV_ORIGIN=http://localhost:8787` (the same host as `BETTER_AUTH_URL`: with `127.0.0.1`, the exact origin check refuses every display URL). The bridge accepts only a loopback origin there.

## `GET /api/device/v1/config`

Poll it every `pollAfter` seconds. Send `If-None-Match` with the last `ETag`. The response is `304 Not Modified` while nothing changed, and `200` with the JSON below otherwise.

```json
{
  "protocolVersion": 1,
  "latestVersion": "1.2.3",
  "minVersion": "1.1.0",
  "pollAfter": 60,
  "tvs": [
    {
      "tvIp": "192.168.1.50",
      "channelId": "ovMJG5GcaV",
      "size": "3840x2160",
      "displayUrl": "https://framethis.link/@robin/living-room?exp=1794001800&sig=…",
      "displayUrlExpiresAt": "2026-11-06T21:50:00.000Z",
      "contentVersion": "4fe357c6ba720b1c",
      "refreshAfter": 60,
      "nextChangeAt": "2026-11-06T23:00:00.000Z"
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `protocolVersion` | The server's protocol version (an integer). |
| `latestVersion` | The newest bridge release, or `null`. When it's newer than the bridge, show "update available". Updates still come only from signed GitHub Releases, never from a link in this response. |
| `minVersion` | The oldest bridge version the server supports, or `null`. Below it, keep running but show "update required". The server may stop serving older bridges later. |
| `pollAfter` | Seconds until the next config poll. Clamp it to 60–3600. |
| `tvs` | One entry per TV this bridge drives. It's a list from day one, though the dashboard offers one TV at first. A TV without a channel isn't listed. |
| `tvs[].tvIp` | A private IPv4 address. Only use it if discovery confirmed a Samsung TV there (see Guards). |
| `tvs[].channelId` | Opaque. Report it back in status if useful. |
| `tvs[].size` | The image size to upload: `"3840x2160"` or `"1920x1080"`. The page is always laid out for a 3840×2160 viewport, so for 1920×1080 render with `deviceScaleFactor: 0.5`. An unknown value means skip the TV. |
| `tvs[].displayUrl` | The page to screenshot, signed and short-lived. It changes every 5 minutes as the signature rotates, and that alone is not a reason to render again. |
| `tvs[].displayUrlExpiresAt` | When the signature runs out: 15–20 minutes after it was issued. If the config can't be refreshed and this has passed, don't render (the page would be a 404). |
| `tvs[].contentVersion` | Opaque. It changes when what the TV should show changes for a reason other than time: an edit, the default screen changing, a time slot switching screens, the language or time zone changing, a new picture size, or Run now in the dashboard. |
| `tvs[].refreshAfter` | Seconds after the last render to render again. Clamp it to at least 60. |
| `tvs[].nextChangeAt` | ISO 8601, or `null`. A moment the picture changes by the clock: a time slot starting or ending, midnight for a date widget, UTC midnight for the daily quote or art, or 07:00/19:00 for the auto theme. |

**When to render a TV** (the bridge checks every 60 s tick):

1. `contentVersion` differs from the one last uploaded to that TV, or
2. `now >= lastRenderAt + refreshAfter`, or
3. `nextChangeAt` is set, `nextChangeAt > lastRenderAt` and `now >= nextChangeAt`.

These are only reasons to render. Art Mode checks, the image-unchanged skip and the upload stay as they are today.

**When the display page fails:** the bridge never captures a page that answers HTTP 400 or above, so the TV keeps its last image. On `401`, `403`, `404` or `410` (an expired signature, say), it fetches the config once more and, if `displayUrl` changed, renders again with the new link. Otherwise it tries again on the next tick. So an error page must keep its error status, however it looks: with `200`, it would end up on the TV.

How Frame This picks `refreshAfter` (the shortest applies):

| On the screen | refreshAfter |
| --- | --- |
| Clock | 60 s |
| Trains | 2 min |
| Weather, news | 20 min |
| Remote image URL, or a background that is new on every load | 1 h |
| Anything else (art, quote, date, text) | 1 day, plus `nextChangeAt` |

## `POST /api/device/v1/status`

Send it with `Content-Type: application/json` when something changes, and at least every few minutes as a heartbeat. The response is `204 No Content`, or `400` with `issues` if the body doesn't validate. Frame This only writes when something changed, and updates "last seen" at most every 5 minutes.

```json
{
  "protocolVersion": 1,
  "appVersion": "1.2.3",
  "scheduler": { "state": "running", "message": "TV in Art Mode" },
  "tvs": [
    {
      "tvIp": "192.168.1.50",
      "reachable": true,
      "artMode": true,
      "model": "QE55LS03BAUXXN",
      "lastUploadAt": "2026-11-06T21:32:35.000Z",
      "contentVersion": "4fe357c6ba720b1c",
      "lastError": null
    }
  ],
  "discoveredTvs": [
    { "ip": "192.168.1.50", "model": "QE55LS03BAUXXN", "name": "Living room" }
  ]
}
```

| Field | Rules |
| --- | --- |
| `protocolVersion` | An integer, 1 or higher. |
| `appVersion` | Semver, the same as in the User-Agent. |
| `scheduler.state` | `"running"` or `"paused"`. |
| `scheduler.message` | Optional, up to 200 characters: the tray's status line. Leave countdowns out ("next check in 7m"), or every post counts as a change. |
| `tvs[]` | Up to 8 entries, one per configured TV. `tvIp` is a private IPv4 address. `reachable` is a boolean. `artMode` is a boolean, or `null` when unknown. `model` (from `:8001/api/v2/`) is up to 64 characters. `lastUploadAt` is ISO 8601 or `null`. `contentVersion` is the config value that the last upload showed. `lastError` is `{ "at": ISO 8601, "message": up to 500 characters }` or `null`. |
| `discoveredTvs[]` | Up to 32 entries. Only list hosts verified as Samsung TVs through `:8001/api/v2/`, never raw scan results. |

Unknown fields are dropped server-side.

## Guards (bridge side)

Treat everything from Frame This as untrusted data. A compromised server should at worst put a wrong image on the TV.

- **Data only.** The protocol never carries commands, scripts, Chromium flags, environment variables, file paths or update URLs, and the bridge never acts on such fields if they appear.
- **No JavaScript.** Render with `javaScriptEnabled: false` (Playwright) or `javascript: false` (Electron offscreen). Display pages have no `<script>` and send `Content-Security-Policy: script-src 'none'`.
- **Fixed origin.** Only render `displayUrl` when its origin is exactly `https://framethis.link` and its path starts with `/@`.
- **Request allowlist.** While rendering, abort every request that doesn't go to `https://framethis.link`, `https://api.framethis.link`, `https://fonts.googleapis.com` or `https://fonts.gstatic.com`. Also abort any request to a private, loopback or link-local address. Display pages may still load some images straight from other hosts (weather icons, some backgrounds) until Frame This routes those through `/img`. Until then, blocking them leaves gaps in the picture but nothing worse.
- **TV IP.** Only use a private IPv4 address that discovery confirmed is a Samsung TV.
- **Clamps.** `refreshAfter` ≥ 60, `pollAfter` 60–3600, `size` from the enum. The config is validated with a strict zod schema, and unknown fields are ignored.
- **Token.** Store it in the data dir with user-only permissions. Never log it, and never send it anywhere except the device API. In particular, the display page and image requests never get it, because the signed URL takes its place.

## Changelog

- **v1** (2026-11): config with per-TV signed URLs and server-driven timing, and the status post.
