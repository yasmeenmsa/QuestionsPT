# PTEXAM 550 Study Companion

Mobile-friendly physiotherapy MCQ study app with hidden answer keys, confidence marking, review timers, weak-spot drills, and saved progress.

## Run locally or on your server

Requires [Bun](https://bun.sh/). An 8 GB RAM server is more than sufficient.

```bash
bun run server.js
```

For production, set an admin token so visitors cannot change the shared question set:

```bash
NODE_ENV=production ADMIN_TOKEN='replace-with-a-long-random-secret' PORT=3000 bun run server.js
```

Each browser receives a random study-user ID. The server stores that user's record separately in `data/users/<id>.json`; users do not share one another's marks. Keep `data/users/` on persistent storage and back it up. Progress also remains in the browser and can be exported/restored from **Add / Backup Qs → Progress Backup**.

Use HTTPS through your reverse proxy before sharing the server URL publicly.

## GitHub Pages

The included workflow publishes the static app from the repository's default branch. In **Repository → Settings → Pages**, select **GitHub Actions** as the source. The expected project URL is:

`https://yasmeenmsa.github.io/QuestionsPT/`

GitHub Pages hosts only static HTML/CSS/JavaScript. On Pages, each user's progress is saved privately in their own browser's local storage, with JSON export/import for backup or moving devices. Server-side cross-device sync requires running `server.js` on your VPS.

Publishing Pages from a private repository requires a GitHub plan that supports it. Otherwise, make the repository public before enabling Pages; never store secrets or private progress files in the repository.
