# Deploy Save Video for free on Render

No paid plan is needed for this first version. Render's free web service
sleeps after ~15 minutes without traffic, so the first visit after a
quiet period can take up to ~50 seconds to wake up. That is normal on
the free plan.

## 1. Put the code in a GitHub repo (free)

1. Create a free account at github.com (if you do not have one).
2. Create a new repository, e.g. `mediahub`.
3. Upload the contents of this folder (`server.js`, `public/`,
   `package.json`, `Dockerfile`, `render.yaml`, `README.md`) to it.

## 2. Create a free Render account

1. Go to render.com and sign up (free — email or GitHub sign-in).
2. No card is needed for the free plan.

## 3. Create the web service

1. In Render, click **New +** → **Web Service**.
2. Choose **Build and deploy from a Git repository** and pick your repo.
3. Render finds `render.yaml` and fills in the settings:
   - Runtime: **Docker**
   - Plan: **Free**
   - Health check path: `/api/health`
4. Click **Create Web Service**. The first build takes a few minutes
   (it installs Node, python/yt-dlp and ffmpeg).
5. When the build says **Live**, open the URL Render gives you
   (like `https://savevideo-xxxx.onrender.com`).

## 4. Check it works

1. Open the site, paste a video link, press **Get video**.
2. You should see the preview and the quality list.
3. Pick a quality and press **Save** — the file should arrive.

## 5. Ads (later)

The page already has two empty slots labelled **Advertisement** (one
above, one below the result). When you have an ad network account,
paste its code into the two `.ad-slot` blocks in
`public/index.html`. Until then the site works fine with them empty.

## Later: paid hosting

If the free plan feels slow (sleep/wake) or traffic grows, move the
same code to a paid Render plan or a small VPS — no code changes are
needed, only the plan.
