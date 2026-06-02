---
name: worktree-setup
description: Prepare a Review Assistant git worktree for local development by copying the main worktree data folder, writing LOCAL_PATH, and running the smallest startup validation.
---

# Worktree Setup

Goal: Prepare a Review Assistant worktree so the app opens with local sample projects.

Success means:
  - `data/` in the current worktree mirrors the main worktree `data/` folder.
  - `.env` in the current worktree sets `LOCAL_PATH` to the current worktree `data/` folder.
  - The app starts from the current worktree and lists the copied local projects.

Stop when: `LOCAL_PATH` points at the copied data folder and the app process starts from the current worktree.

## Workflow

1. Identify the current worktree root with `git rev-parse --show-toplevel`.
2. Identify the main worktree data source at `/Users/andrewvineyard/Engagements/ATT/review-assistant/data`.
3. Copy the main data folder into the current worktree with `rsync -a --delete "$MAIN_DATA/" "$WORKTREE_ROOT/data/"`.
4. Write the current worktree `.env` with `LOCAL_PATH=$WORKTREE_ROOT/data`.
5. Start the app with `npm run dev` for development or `npm run electron` for a production-like launch.
6. Check the running process and confirm Electron starts from the current worktree path.

## Commands

```bash
WORKTREE_ROOT="$(git rev-parse --show-toplevel)"
MAIN_DATA="/Users/andrewvineyard/Engagements/ATT/review-assistant/data"
rsync -a --delete "$MAIN_DATA/" "$WORKTREE_ROOT/data/"
printf 'LOCAL_PATH=%s\n' "$WORKTREE_ROOT/data" > "$WORKTREE_ROOT/.env"
npm run dev
```

