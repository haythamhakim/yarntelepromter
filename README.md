# AI Teleprompter MVP

Low-latency script readback teleprompter built with Next.js and OpenAI Realtime API.

## Features

- Script editor with a `Read back Script` flow.
- Teleprompter viewport tuned for readability:
  - around 5 words per line
  - max 4 lines visible
  - large text and active line emphasis
- Browser microphone capture streamed to OpenAI Realtime over WebRTC.
- Rolling transcript window (~10 seconds) for alignment.
- Semantic alignment loop:
  - compares transcript window with current/next script chunks
  - advances when confidence is high
  - freezes when confidence drops (off-script/ad-lib)
  - resumes when confidence recovers

## Requirements

- Node.js 20+
- Chromium-based browser for MVP testing (Chrome/Edge)
- OpenAI API key with Realtime access

## Environment Variables

Create `.env.local`:

```bash
OPENAI_API_KEY=your_openai_key
# Optional override:
OPENAI_REALTIME_MODEL=gpt-realtime
```

## Run Locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## How It Works

1. Frontend requests an ephemeral Realtime client secret from `app/api/realtime/session/route.ts`.
2. Browser connects directly to OpenAI Realtime using WebRTC + mic input.
3. A server sideband bootstrap call applies guardrails and truncation over `call_id`.
4. Transcript updates are captured in a rolling window.
5. Client requests semantic chunk matching as out-of-band responses to control token growth.
6. Teleprompter advances or freezes based on confidence thresholds.

## Failure Handling

- **Mic permission denied**: connection fails with visible error message.
- **Session creation errors**: backend returns provider error details.
- **Realtime disconnects**: user can pause/resume readback.
- **Alignment uncertainty**: scroll freezes instead of jumping blindly.

## Tuning Notes

- Alignment cadence currently runs at about 500ms.
- Rolling transcript window defaults to 10 seconds.
- Freeze threshold and confidence behavior live in `lib/teleprompter/semanticAligner.ts`.
