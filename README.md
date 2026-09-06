# Bergensers Commons — build-your-commons tool

Single self-contained HTML file. No build step, no dependencies.

**Live: https://bergensers-commons.edgeone.dev**
Repo: https://github.com/kaffeconway/Bergensers-commons

Deployed via EdgeOne Makers, Git-connected to this repo. The address above is the
permanent one and always serves the latest `main` — that's the one to share.

Each individual deploy *also* gets its own URL, of the form
`bergensers-commons-<deployment-id>.edgeone.dev`. Those stay pinned to that one build
forever, so they're useful for looking back at an old version, but don't hand them
round: the ID changes on every push and the link you shared quietly stops updating.

See `CLAUDE.md` for the technical detail Claude Code needs to edit this safely
(encoding quirks, code format, deploy flow). Short version below.

## One-time setup — already done

Kept here as a record of how it was wired, and in case it ever needs redoing.

1. This repo should already exist and be private on GitHub. If starting fresh:
   https://github.com/new — private, no README/gitignore (this zip has its own).

2. In the EdgeOne Makers console: **Create Project → Import Git Repository → GitHub**
   - Authorize EdgeOne to access this repo (GitHub's own screen)
   - Framework preset: **None / Static**
   - Build command: *(leave empty)*
   - Output directory: `/` (root)
   - Deploy

   Once connected, every push to `main` triggers an automatic redeploy. No manual
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
