# Contributing

Pull requests are welcome. For a bigger change, open an issue first so we can agree on the shape.

## Set up

You need Node.js 22 or later and the Salesforce CLI (`sf`). The project uses npm.

```sh
npm ci
npm run build   # compiles to lib/ and runs the linter
npm test
```

## Try it locally

Run the commands from your checkout with `./bin/run.js`. Point `ORG_LAUNCHER_HOME` at a scratch folder, so your saved tags, notes and settings stay out of it. Pick a port other than 4242 if you already run Org Launcher.

The first `launcher` run in a terminal asks two questions. Answer no to both, or add `--json`, which asks nothing. A yes would set up the login service and the Dock app for your scratch folder, and that Dock app would replace your everyday one.

```sh
npm run build
export ORG_LAUNCHER_HOME="$(mktemp -d)"
./bin/run.js launcher start --port 4343
./bin/run.js launcher
./bin/run.js launcher tag my-scratch demo
./bin/run.js launcher stop
```

The page lists the orgs your own sf CLI knows. You can also run `sf plugins link .` to use your checkout as the installed plugin. Run `sf plugins unlink @taggalongtech/org-launcher` when you're done.

## Rules every change keeps

- **The page never builds HTML from strings.** No `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write`. Use `textContent` and `createElement`. The hygiene test checks this.
- **No outside calls.** No telemetry, analytics, update checks or files from a CDN. The only network calls go to the user's own orgs. The page loads everything from the local server.
- **Login tokens and login links stay secret.** Never write one to disk, log it, send it to the page or put it in an error message.
- **Nothing is registered without a yes.** The login service and the Dock app are only added when someone asks for them.
- **Plain words.** Messages say what happened and what to do next, in short sentences.

Add a test with each change. The suite runs on macOS, Windows and Linux in CI.
