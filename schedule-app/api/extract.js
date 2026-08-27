// Vercel serverless function. Runs on the server, so the API key never
// reaches the browser. Deploy this project on Vercel and set the
// ANTHROPIC_API_KEY environment variable in the project settings.

const PROMPT = `You are reading a document that contains a student's class schedule (an official receipt, enrollment form, registration confirmation, or a photo/screenshot of a timetable).

Extract every class/course meeting into a JSON array. Each element must have exactly these fields:
- "day": one of "Mon","Tue","Wed","Thu","Fri","Sat","Sun" (if a course meets multiple days, output one entry per day)
- "start": start time as a string like "9:00 AM"
- "end": end time as a string like "10:30 AM"
- "course": course name or code (keep it short, e.g. "CS 101 - Intro to Programming")
- "room": room/building if present, else ""
- "instructor": instructor name if present, else ""

Respond with ONLY the JSON array. No preamble, no markdown fences, no explanation. If you truly cannot find any schedule information, respond with [].`;

// Best-effort per-IP cap. This resets whenever the serverless function
// cold-starts (Vercel doesn't guarantee the same instance handles every
// request), so it's a backstop against casual abuse, not a strict guarantee.
// The real per-browser limit lives in the frontend (localStorage).
const MAX_PER_IP = 20;
const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const hits = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now - entry.start > WINDOW_MS) {
    hits.set(ip, { start: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_PER_IP;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const ip = (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
  if (isRateLimited(ip)) {
    res.status(429).json({ error: "Too many requests. Please try again later." });
    return;
  }

  const { base64, mediaType } = req.body || {};
  if (!base64 || !mediaType) {
    res.status(400).json({ error: "Missing image data" });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY. Set it in your Vercel project's environment variables." });
    return;
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 4096,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
              { type: "text", text: PROMPT },
            ],
          },
        ],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      res.status(response.status).json({ error: data?.error?.message || "Anthropic API error" });
      return;
    }

    const textBlock = (data.content || []).find((b) => b.type === "text");
    res.status(200).json({ text: textBlock ? textBlock.text : "" });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: "Failed to reach Anthropic API" });
  }
}
