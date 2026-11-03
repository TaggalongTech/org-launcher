# Changelog

## 0.1.2 (2026-11-03)

- A scratch org with a second user logged in now shows the login that created it. Salesforce Labs' Revenue Cloud launchpad logs in a sales rep next to the admin, and the row used to pick the sales rep: wrong username, and a check that said "can't reach". The main login is now the one whose auth file names the Dev Hub, then one with an alias.
- A check that fails because the main login lacks permission now says "limited access" in amber, with how to fix it, instead of "can't reach". The org isn't treated as dead.

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
