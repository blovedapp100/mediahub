# Save Video — paste a link, preview the clip, pick a quality, save it.

Save Video is a small, fast web app: paste a video link from TikTok,
Facebook, Instagram, YouTube, X, Reddit, Vimeo or Dailymotion, see a
preview with every available quality, and save the clip in the quality
you choose.

## How it works

- **Frontend:** one page (`public/`), no frameworks, no heavy libraries.
  Paste a link → `POST /api/info` → preview player + quality cards →
  pick one → `GET /api/save` streams the file.
- **Backend:** Node.js + Express (`server.js`).
  - TikTok links first try the free tikwm API, with yt-dlp as fallback.
  - Everything else uses `yt-dlp` (`-J` for info, `-f` for the file).
  - When a quality is separate video + audio streams (YouTube), the
    server joins them with ffmpeg into a temp file, streams it, and
    deletes it immediately — nothing builds up on disk. Single-file
    qualities stream straight through with nothing stored at all.
  - Info responses are cached in memory for 10 minutes (keyed by a
    hash of the link, so no link is stored) — a repeat paste answers
    in ~2 ms.
- **Design:** premium, modern UI — dark/light mode (saved choice +
  system preference), real in-page video preview player with still
  fallback, quality options as cards, paste detection with instant
  feedback, progress indicator while fetching, micro-interactions,
  mobile-first and accessible (labels, focus rings, reduced-motion
  support).
- **SEO:** per-platform pages (`/youtube`, `/tiktok`, `/facebook`,
  `/instagram`, `/twitter`) with keyword-targeted titles, meta
  descriptions, intro text and FAQ; FAQ schema (JSON-LD) on every
  page; dynamic `sitemap.xml` and `robots.txt`; semantic HTML;
  Open Graph + Twitter cards; tiny page weight (~25 KB total).
- **Safety:** only known video hosts are accepted (SSRF blocklist by
  allowlist); per-IP rate limits; timeouts on every external call;
  no open redirects; all output is escaped; URLs are never logged;
  no accounts, no logins, nothing stored about users.
- **Ads:** two clearly labelled `Advertisement` placeholder slots on
  the page (one above, one below the result). They are empty on
  purpose — paste your ad network code there when you are ready.
  The site works fully with the slots empty.

## Run locally

```bash
npm install
npm start
# open http://localhost:3000
```

Requires `yt-dlp` and `ffmpeg` on your machine for the backend to work
(the Docker image installs both). Set `YTDLP_PATH` if `yt-dlp` is not
on your `PATH`.

## Files

- `server.js` — Express app: `/api/info`, `/api/save`, `/api/health`,
  per-platform pages, `sitemap.xml`, `robots.txt`
- `public/index.html`, `public/landing.html`, `public/app.js`,
  `public/style.css` — the pages, logic and styling
- `Dockerfile` — Node + python/yt-dlp + ffmpeg image
- `render.yaml` — Render blueprint (free plan)
- `DEPLOY.md` — free hosting steps
