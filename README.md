# PTEXAM 550 Study Companion

Mobile-friendly physiotherapy MCQ study app with hidden answer keys, confidence marking, review timers, weak-spot drills, and saved progress.

**Read aloud:** each question card has a 🔊 Read Aloud button that speaks the stem and options, plus the correct answer and rationales once the key is revealed. A voice picker next to the exam filter defaults to Microsoft's **en-GB-SoniaNeural** voice, lists Microsoft voices first (Edge's online/natural voices rank highest), and falls back to whatever the browser provides; the choice is remembered on that device.

## Telegram voice notes

`scripts/send-telegram-voice.js` reads the question bank and sends each question to a Telegram bot as a voice note spoken by Microsoft's **en-GB-SoniaNeural** voice.

```bash
pip install edge-tts            # plus ffmpeg on PATH
export TELEGRAM_BOT_TOKEN=...   # never commit this
node scripts/send-telegram-voice.js --list-chats      # find the chat that started the bot
node scripts/send-telegram-voice.js --exam "PTEXAM ONE" --from 1 --to 10
```

The bot can only message a chat that has started it, so open the bot in Telegram and press Start first. Options: `--limit`, `--reveal` (include the answer and rationales), `--dry-run` (generate audio only, in `.telegram-voice/`), and `TELEGRAM_CHAT_ID` to skip chat discovery. Sent questions are tracked in `.telegram-sent.json`; both paths are git-ignored.

## Run locally or on your server

Requires [Bun](https://bun.sh/). An 8 GB RAM server is more than sufficient.

```bash
bun run server.js
```

For production, set an admin token so visitors cannot change the shared question set:

```bash
NODE_ENV=production ADMIN_TOKEN='replace-with-a-long-random-secret' PORT=3000 bun run server.js
```

## Phone + PC sync

Create an account in the app, then sign in with the same username and password on your phone and PC. Each account has an independent study record in `data/users/<account-id>.json`. Passwords are bcrypt-hashed, and login sessions use random HTTP-only cookies; passwords and session tokens are never stored in browser local storage.

Back up these runtime files on the VPS:

- `data/accounts.json` — account IDs and password hashes
- `data/users/` — each account's answers, marks, and notes
- `data/sessions/` — persistent sign-in sessions

These private files are excluded from Git. Progress can also be exported/restored from **Add / Backup Qs → Progress Backup**.

Use HTTPS through your reverse proxy before sharing the server URL publicly.

After editing the Markdown source in `questions/`, regenerate the app dataset with `bun run build:questions`. The generated `data/questions.json` currently contains 538 questions from three exams.

## GitHub Pages

The included workflow publishes the static app from the repository's default branch. In **Repository → Settings → Pages**, select **GitHub Actions** as the source. The expected project URL is:

`https://yasmeenmsa.github.io/QuestionsPT/`

GitHub Pages hosts only static HTML/CSS/JavaScript. On Pages, each user's progress is saved privately in their own browser's local storage, with JSON export/import for backup or moving devices. Server-side cross-device sync requires running `server.js` on your VPS.

Publishing Pages from a private repository requires a GitHub plan that supports it. Otherwise, make the repository public before enabling Pages; never store secrets or private progress files in the repository.

## Full question bank in Markdown

The complete answer key from the four source PDFs (288 scanned pages) is in [`questions/`](questions/):

| File | Questions |
| --- | --- |
| [pt-exam-one.md](questions/pt-exam-one.md) | 180 |
| [pt-exam-two.md](questions/pt-exam-two.md) | 179 |
| [pt-exam-three.md](questions/pt-exam-three.md) | 179 |

Each entry has the stem, four options, the correct answer, and the full explanation. See [`questions/README.md`](questions/README.md) for notes and a two-day study plan.

Two questions are absent from the source scans: PT Exam Two Q82 and PT Exam Three Q180. The text was recovered by OCR, so a few words may be imperfect.
