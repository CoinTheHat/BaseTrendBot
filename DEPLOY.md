# SCANDEX Deployment Guide

## Option 1: Docker (Recommended)
This is the most reliable way to run the bot on any server (VPS like DigitalOcean, AWS, Hetzner, or platforms like Railway).

### 1. Build the Image
```bash
docker build -t scandex-bot .
```

### 2. Run the Container
```bash
docker run -d --env-file .env --name scandex scandex-bot
```

---

## Option 2: Easy Cloud (Railway/Render)
Since we use Puppeteer (Headless Chrome), standard Node.js hosting often fails. You must use a Dockerfile.

1. Push your code to GitHub.
2. Connect to [Railway.app](https://railway.app/).
3. Railway will automatically detect the `Dockerfile` and build it.
4. Add your variables in the "Variables" tab.

---

## VPS Requirements (DigitalOcean / Hetzner)
- **RAM**: At least 1GB (Puppeteer is memory hungry).
- **OS**: Ubuntu 22.04 LTS (recommended).
