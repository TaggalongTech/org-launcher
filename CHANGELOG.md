# Changelog

## 0.1.1 (2026-11-02)

- A new icon: rows of orgs, in Taggalong's line style, for the page, the browser tab and the Dock app.

## 0.1.0 (2026-11-02)

First release.

- `sf launcher` opens one page with every org your sf CLI knows: type, tags, packages, days left and a note.
- Checks each org in the background and shows the last results right away.
- `sf launcher tag` and `sf launcher note` set tags and notes from scripts.
- Opens orgs in a chosen browser and profile, per org, per tag or for every org.
- Starts at login on macOS (Linux and Windows are early), and adds a Dock app on macOS, only when you say yes.
- `sf launcher uninstall` removes the login service and the Dock app. `--purge` deletes saved data too.
