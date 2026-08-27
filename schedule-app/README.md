# Weekly Schedule

Upload a photo of a class schedule (receipt, enrollment form, screenshot) and get
back a clean, editable weekly timetable. Drag classes between days, edit any
detail, and export the result as a PNG or JPG.

This is a small React app (built with Vite) plus one serverless function that
calls the Anthropic API on your behalf, so your API key never reaches the
browser.

## Important: deploy on Vercel, not GitHub Pages

GitHub Pages only serves static files — it can't run the `/api/extract`
serverless function that keeps your API key secret. **Use Vercel** (it's free
for personal projects). You can still keep your code on GitHub; Vercel just
deploys straight from the repo.

## Deploy in 3 steps

1. **Push this folder to a GitHub repo.**
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
   git push -u origin main
   ```

2. **Import the repo into Vercel.**
   - Go to https://vercel.com/new
   - Select your GitHub repo
   - Vercel auto-detects Vite — leave the default build settings

3. **Add your API key.**
   - In the Vercel project: Settings → Environment Variables
   - Add `ANTHROPIC_API_KEY` with a key from https://console.anthropic.com/settings/keys
   - Redeploy (Vercel will prompt you, or trigger it from the Deployments tab)

That's it — your live URL will be something like `your-project.vercel.app`.

## Running locally

```bash
npm install
npm run dev
```

The `/api/extract` function needs Vercel's dev server to run locally too:

```bash
npm install -g vercel
vercel dev
```

Create a `.env` file (copy `.env.example`) with your real key before running
`vercel dev` — see `.env.example` for the format. Never commit `.env`.

## Notes

- **Storage:** schedules are saved in the browser's `localStorage`, per
  device/browser — there's no shared database. Clearing browser data or
  switching devices means starting fresh.
- **Cost:** each "Extract schedule" click makes one Anthropic API call,
  billed to your key. Check current pricing at
  https://docs.claude.com/en/docs/about-claude/pricing before sharing the
  link widely.
- **Security:** if you make the repo public, double-check `.env` is not
  committed (it's in `.gitignore` by default). The API key only ever lives
  in Vercel's environment variables and the serverless function — never in
  client-side code.
