# Bergensers Commons — build-your-commons tool

Single self-contained HTML file. No build step, no dependencies.
Live: deployed via EdgeOne Makers, Git-connected to this repo.
Repo: https://github.com/kaffeconway/Bergensers-commons

See `CLAUDE.md` for the technical detail Claude Code needs to edit this safely
(encoding quirks, code format, deploy flow). Short version below.

## One-time setup, if not already done

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
