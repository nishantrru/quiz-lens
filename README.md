# QuizLens AI

QuizLens AI is a privacy-first workspace for reviewing practice questions and authorized quiz content. It is designed to help a user capture questions from a screen, camera, or uploaded image; keep a durable local audit trail; look up sources independently; and export a review report.

> **Responsible use:** Use only with material you are authorized to review. QuizLens AI does not bypass proctoring, Safe Exam Browser, access controls, or third-party quiz systems, and it never submits answers on a user's behalf.

## What this build does

- Creates and resumes audit sessions in the browser.
- Requests screen or camera access only after a deliberate user action.
- Supports image upload and manual capture from an authorized stream.
- Uses lightweight local frame fingerprints to reduce duplicate captures during auto-capture.
- Stores sessions, captures, transcriptions, notes, verification state, and audit flags in the browser's IndexedDB. Data persists through refreshes and browser restarts on the same device/browser profile.
- Provides question navigation, keyword search, flagging, deletion, independent Google search, and JSON/CSV/print-to-PDF report export.
- Clearly labels AI output as an *AI suggestion*, never as an official or independently verified answer.
- Includes `api/analyze.js`, a Vercel serverless endpoint that keeps the OpenAI key on the server, applies basic size and rate checks, submits image/text inputs with a strict JSON schema, and validates the returned audit object.
- Shows a clear configuration state instead of inventing OCR or AI results when the secure server endpoint has not been configured.

## Run locally

This is a buildless static web application. Serve the `dist` directory from a local web server; browser camera and screen-capture APIs require a secure context (`https://`) or `localhost`.

```powershell
cd C:\Users\nkmar\Documents\Codex\2026-11-20\mak\quizlens-ai
npx serve dist
```

Then open the localhost URL reported by the server. No package installation is required for the application itself.

## Production deployment

The project contains a static-hosting manifest in `.openai/hosting.json`. The `dist` directory is the deployable asset root.

For Vercel, import this folder and deploy it with `vercel.json`; it serves `dist` as the static output and `api/analyze.js` as a serverless function. Add `OPENAI_API_KEY` and (optionally) `OPENAI_MODEL` in Vercel's encrypted environment-variable settings. Do **not** put an API key in the browser bundle.

## Secure AI and persistence integration

The current browser build intentionally does not contain an OpenAI API key or Supabase service key. The included `api/analyze.js` route is the server-side boundary for OpenAI analysis; it uses the Responses API with vision input and a strict JSON schema. The browser only calls its own `/api/analyze` route, never the OpenAI API directly.

Suggested production flow:

1. Browser sends an explicitly captured image to an authenticated server route.
2. The server applies size/type/rate-limit checks and stores the original in a private Supabase bucket.
3. The server invokes a vision-capable OpenAI model with a schema-constrained response.
4. The server validates and persists the returned question, choices, confidence, ambiguity flags, and concise explanation.
5. The browser receives only the user-owned record and labels it as AI-suggested until the user independently verifies it.

Copy `.env.example` to your deployment secret store. Environment variables must be configured in the hosting provider, never in `dist/app.js` or another client asset.

## Data model for a cloud implementation

- `profiles`: user identity and creation timestamp
- `audit_sessions`: owner, title, lifecycle, and timestamps
- `questions`: session, image path, transcription, choices, AI analysis, verification state, flags, and timestamps
- `verification_sources`: user-attached URL, outcome, and notes

Apply owner-scoped Row Level Security to every table and private object policy to all screenshots.

An initial, unapplied Supabase migration is included at `supabase/migrations/202611200001_initial_quizlens_schema.sql`. It creates the tables, ownership checks, indexes, authenticated-user RLS policies, and a private `question-captures` bucket. Run it only against the Supabase project you intend to use.

## Limitations and configuration state

- Browser capture must be started by the user and cannot silently continue after a permission is stopped or revoked.
- Frame comparison is a local heuristic, not OCR; it deliberately avoids sending every frame to an external service.
- The included AI route is disabled until `OPENAI_API_KEY` is configured. Cross-device persistence, authentication, and private cloud image storage still require Supabase configuration and database migrations.
- PDF export uses the browser's print-to-PDF capability so it works without a server. Results can vary by browser.
- The project is not presented as a configured OpenAI, Supabase, or Vercel production integration until those services and their secrets are supplied and tested.

## Verification checklist

- Screen/camera permission grant and denial
- Upload and manual capture
- Start, pause, resume, and stop auto-capture
- Duplicate suppression on unchanged frames
- Session/history persistence after refresh
- Search, flag, note, verify, and delete actions
- CSV, JSON, and print/PDF export
- Google search opening without marking a question verified
- Server-side missing-key guard for `/api/analyze`

