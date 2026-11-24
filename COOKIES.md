# Save Video — Background sessions (cookies)

The site's screen stays just the downloader. Sessions run in the
background on the server only: the owner's own logged-in cookies for
YouTube / TikTok / Facebook / Instagram, passed to yt-dlp as `--cookies`.
Downloads then go out as the logged-in session instead of anonymous,
which is what lets a blocked datacenter IP sometimes read YouTube/TikTok
again. No login UI, no cookie UI, no visitor data involved — a website
can never read a visitor's browser cookies, and a Google sign-in hands
over no cookies at all. Sessions always come from the owner.

## How to add your cookies (2 minutes per platform)

1. On your PC, in Chrome, log in to the platform (YouTube, TikTok,
   Facebook, Instagram) as usual.
2. Install the free extension **"Get cookies.txt LOCALLY"** (Chrome Web
   Store) and export the cookies for that site. It downloads a
   `cookies.txt` file (Netscape format — tab-separated lines starting
   with `# Netscape HTTP Cookie File`).
3. In the Render dashboard, open the savevideo service → **Environment**
   → add a variable and paste the whole file contents as its value:
   - `COOKIES_YOUTUBE` — your YouTube cookies
   - `COOKIES_TIKTOK` — your TikTok cookies
   - `COOKIES_FACEBOOK` — your Facebook cookies
   - `COOKIES_INSTAGRAM` — your Instagram cookies
   - or one combined file as `COOKIES_TXT` (used for every platform)
4. Save — Render redeploys automatically. Check
   `https://savevideo.onrender.com/api/health` — it reports
   `cookies: { youtube: true, ... }` (true/false only, never contents).

Local dev: put the file next to `server.js` as `cookies-youtube.txt`
(or `cookies.txt` for all platforms). Never commit these files —
`.gitignore` blocks them, and the repo is public.

## Warnings — read before you paste

- **A cookies file IS your login.** Anyone who has it can act as you on
  that platform. Keep it in Render env vars only. Never paste it in
  chat, email, or any repo.
- **Use a spare account if you can, NOT your main/channel account.**
  Automated downloads under your own account can get that account
  flagged. (The channel's Google account already got a "Suspicious
  activity" flag once.)
- **Cookies expire.** When a platform starts failing again, export fresh
  cookies and replace the env var. The server logs only
  `cookies loaded for <platform> (N cookies)` — never the contents.
- **No cookies = old behaviour.** Without them the site works exactly
  as before (anonymous direct, then WARP proxy). A platform with no
  cookies simply falls back; nothing breaks.
- Cookies do not guarantee YouTube/TikTok will work — if the IP block
  is absolute, even a logged-in session fails. Test after adding them.
