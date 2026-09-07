# Bergensers Commons — build-your-commons tool

Single self-contained HTML file. No build step, no dependencies.

**Live: https://kaffeconway.github.io/Bergensers-commons/**
Repo: https://github.com/kaffeconway/Bergensers-commons

Hosted on GitHub Pages, served straight from `main`. The address above is the permanent
one and always serves the latest commit — that's the one to share.

See `CLAUDE.md` for the technical detail Claude Code needs to edit this safely
(encoding quirks, code format, deploy flow). Short version below.

## Share that address and no other

GitHub Pages gives this project exactly one URL. There are no per-deployment or
per-branch preview addresses to mix it up with, which removes a whole category of
mistake. Two look-alikes are still worth knowing about, because both point at this same
repo and neither one works as a link to the app:

- `github.com/kaffeconway/Bergensers-commons/blob/main/index.html` — GitHub's source
  viewer. Shows the code, doesn't run it.
- `raw.githubusercontent.com/.../index.html` — served as plain text. The recipient sees
  markup, not a questionnaire.

And the retired address, `bergensers-commons.edgeone.dev`, is still circulating in older
messages. See below.

## Superseded: EdgeOne (Tencent)

The site was previously hosted on EdgeOne Makers at `bergensers-commons.edgeone.dev`,
wired up the same way — Git-connected, push to `main` to redeploy. Don't share that
address any more.

Why it was dropped: the host served two different certificates for that domain,
depending on how the browser negotiated the connection. One was a valid DigiCert
certificate for `*.edgeone.dev`. The other was Tencent's generic `*.cdn.myqcloud.com`
certificate — wrong hostname for this site, and issued by WoTrus, which is trusted by no
major root store (Mozilla, Apple, Android, Java or Windows). Whether a given person
could open the link came down to which certificate their browser happened to be handed.

Firefox is where this surfaced, because it ships its own root store instead of deferring
to the operating system's, and because `.dev` is HSTS-preloaded there was no "proceed
anyway" to click through. Several people simply could not open the site at all.

None of it was fixable from the EdgeOne console: the default `.edgeone.dev` domain
exposes no HTTPS configuration, and the certificate is served by Tencent's own
infrastructure.

## One-time setup — already done

Kept here as a record of how it was wired, and in case it ever needs redoing.

1. The repo is **public**. GitHub Pages requires either a public repo or a paid plan,
   and public was the deliberate choice. Nothing sensitive lives here — the
   questionnaire is generic, and every submission stays in the collector's browser
   `localStorage`, never in this repo. Don't commit anything you wouldn't publish.

2. Repository **Settings → Pages**:
   - Source: **Deploy from a branch**
   - Branch: **main**, folder: **/ (root)**
   - Save

   **Enforce HTTPS** switches itself on and can't be turned off on the default
   `github.io` domain, which is exactly what we want.

3. Serving from the repo root means every file here is on the public web, this README
   and `CLAUDE.md` included.

Once enabled, every push to `main` rebuilds and republishes automatically. No manual
upload step, ever.

## Every future update

```
git add index.html
git commit -m "describe the change"
git push
```

That's the whole pipeline. If you're using Claude Code in this folder, just ask it to
make the change and push — it has full context in `CLAUDE.md` and will use your own
local git credentials, so nothing needs to be handed to anyone.

A push takes a minute or so to go live.

There is an empty `.nojekyll` file at the repo root, which turns off Jekyll processing
entirely, so files are served exactly as committed. It is there because Jekyll otherwise
runs its Liquid template parser over everything in the repo — Markdown included — and a
stray double-brace anywhere fails the build. When that happens the deploy step is simply
skipped: nothing breaks visibly, the previous build stays live, and the site just looks
like it did not update. Leave `.nojekyll` in place and that whole failure mode is gone.
