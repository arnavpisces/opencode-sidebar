# Contributing

Thanks for your interest in contributing. Contributions, issues, and suggestions are welcome.

## How to contribute

1. Fork the repository
2. Create a new branch (`feature/your-feature-name` or `fix/your-bug-name`)
3. Make your changes
4. Commit with a clear message
5. Push to your fork
6. Open a Pull Request

## Guidelines

* Keep pull requests small and focused
* Write clear, descriptive commit messages
* Add comments where necessary for readability
* Ensure your code runs and does not break existing functionality

## Local LLM + Bun setup

If you want to fork this repo and work with an LLM locally, set up the same basics the project expects first.

### Prerequisites

* Node.js 20+
* `bun`
* `tmux`
* `opencode`

Check that they are available:

```bash
node --version
bun --version
tmux -V
opencode --version
```

### Clone and install

```bash
git clone https://github.com/your-username/opencode-sidebar.git
cd opencode-sidebar
bun install
```

### How to run locally

Use these commands while developing:

```bash
./node_modules/.bin/tsc --noEmit
bun test
npm run build
```

To launch the sidebar locally inside tmux:

```bash
./bin/opencode-sidebar-tmux
```

You can also run the built CLI directly:

```bash
node ./bin/opencode-sidebar.js
```

### How to test feature changes locally

1. Start the sidebar with `./bin/opencode-sidebar-tmux`
2. Open or create sessions from the sidebar UI
3. Verify the behavior you changed in the left sidebar and the right OpenCode pane
4. Re-run the checks before opening a PR:

```bash
./node_modules/.bin/tsc --noEmit
bun test
npm run build
```

If your change touches tmux/session lifecycle behavior, also run:

```bash
./test/run-tmux-flow.sh
./test/run-tmux-cleanup.sh
./test/run-sidebar-sigint-cleanup.sh
```

### Using an LLM locally

If you are using an LLM coding assistant on your fork, give it this repo context:

* Runtime is tmux-only
* Main UI entrypoint is `src/index.tsx` and `src/app.tsx`
* Session and snapshot orchestration lives in `src/lib/opencode.ts`
* tmux behavior lives in `src/lib/tmux.ts`
* The main verification flow is typecheck, tests, and build in that order

That is usually enough for the LLM to install with `bun install`, understand how to run the repo locally, and suggest valid local test commands.

## Reporting issues

If you find a bug or have a suggestion:

* Check if an issue already exists
* If not, open a new issue with clear details and steps to reproduce

---

Your contributions help improve the project. Appreciate your time and effort.
