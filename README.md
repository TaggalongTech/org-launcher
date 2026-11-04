# Org Launcher

**Every Salesforce org on your computer, on one page.** Open any of them in one click, see which packages they hold, and know how many days each scratch org has left.

Org Launcher is a free, open-source plugin for the Salesforce CLI (`sf`). It finds every org you've logged in to by itself, so there's nothing to set up or add by hand.

![Org Launcher: a table of orgs with their type, tags, packages, days left and a note, each with an Open button](https://cdn.jsdelivr.net/npm/@taggalongtech/org-launcher@0.1.2/docs/images/table-light.png)

- **One click to open an org,** already logged in, in the browser and profile you choose.
- **Days left for every scratch org.** The count turns red at 3 days or fewer, so an org never expires halfway through your work.
- **Packages at a glance,** with versions, plus a flag when an org holds Apex that isn't in any package.
- **Tags and notes** so you can group orgs by client or project and remember what each one is for.
- **Keyboard first:** press `/`, type a few letters, press Enter.
- **Private by design:** it runs only on your computer and talks to nothing but your own orgs.

## Get started

You need the [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) with Node.js 22 or later. If `sf --version` prints a version, you're set.

**1. Install the plugin**

```sh
sf plugins install @taggalongtech/org-launcher
```

The Salesforce CLI says the plugin isn't signed by Salesforce and asks whether to continue. Answer `y`. Only Salesforce can sign CLI plugins, so every plugin from anyone else asks this.

**2. Open the page**

```sh
sf launcher
```

Your browser opens http://localhost:4242 with every org your Salesforce CLI knows: scratch orgs, sandboxes, Dev Hubs, production and developer orgs.

The first time, it asks two questions: start Org Launcher every time you log in, and, on a Mac, add it to the Dock. Either answer is fine. You can change your mind later (see [Start at login and the Dock app](#start-at-login-and-the-dock-app)).

**3. Open an org**

Click **Open** on a row, or press `/`, type part of the org's name, use the arrow keys to pick it, and press Enter. You're logged in already.

> **Tip:** to install updates without the "not signed" question, add the plugin to the Salesforce CLI's allow list. Create `~/.config/sf/unsignedPluginAllowList.json` with `["@taggalongtech/org-launcher"]` in it, or add the name to the list if the file is there.

## What each column means

| Column | What it shows |
|---|---|
| **Name** | The org's alias. Hover over it to see the username, any other aliases and its Dev Hub. |
| **Type** | Scratch, sandbox, Dev Hub, production or developer. |
| **Tags** | Your own labels. Hover over a row and click **+** to add one. Click a tag to see only orgs with it. |
| **Packages** | Installed packages and their versions. Packages Salesforce installs itself are left out. `src · 38 Apex` in amber means the org holds Apex outside any package; if you ran `sf launcher` from the project that deployed it, the project's name follows. |
| **Expires** | Days left for a scratch org. Red at 3 days or fewer. |
| **Note** | A short note. Click it to edit. |

The page shows what it knew last time right away, then checks each org in the background: 6 at a time, and again every 10 minutes. Each check is three read-only queries. Click **refresh** to check now.

**When something's wrong with an org,** the Expires column says so:

- **expired:** the scratch org is gone. Click **Remove** to forget its login.
- **can't reach:** the org didn't answer, with a one-line reason, like an expired login.
- **limited access:** the org answered, but the login Org Launcher used isn't allowed to see everything. Pick an admin login as the main one (see [When an org has more than one login](#when-an-org-has-more-than-one-login)).

## Group orgs with tags

![The client-a tab selected: only the four orgs tagged client-a show](https://cdn.jsdelivr.net/npm/@taggalongtech/org-launcher@0.1.2/docs/images/tag-tab.png)

Tags show up as tabs across the top of the page. Click one to see only those orgs, or **All** to see everything again.

You can also set tags and notes from the command line, which is handy right after you create a scratch org. The page doesn't need to be open.

```sh
sf org create scratch --alias feature-billing --definition-file config/project-scratch-def.json
sf launcher tag feature-billing client-a billing    # add tags
sf launcher tag feature-billing --remove billing    # remove a tag
sf launcher tag feature-billing --set client-a      # keep only these tags
sf launcher tag feature-billing                     # print the org's tags and note
sf launcher note feature-billing "Invoice PDF rework"
sf launcher note feature-billing ""                 # clear the note
```

Name the org the way `-o` does: an alias, a username or an org id. A tag is lowercase letters, numbers, dots, dashes or underscores, up to 32 characters, and an org can have up to 10. A note is up to 500 characters. Add `--json` for output a script can read.

## When an org has more than one login

![A row's ⋯ menu: open as another login, make it the main login, choose a browser, hide the row, or remove the login](https://cdn.jsdelivr.net/npm/@taggalongtech/org-launcher@0.1.2/docs/images/row-menu.png)

Some orgs have several users logged in to the Salesforce CLI. Salesforce Labs' Revenue Cloud launchpad, for example, logs in a sales rep next to the admin. Org Launcher shows each org once and picks a main login for it: the one you chose, or else the login that created the scratch org.

Open a row's `⋯` menu to:

- **Open as** another login, just this once.
- **Make** another login **the main login** for the row.
- **Open in…** a particular browser and profile, for this org only.
- **Hide** the row. Hidden orgs are listed at the bottom of the page, where you can unhide them.
- **Remove the login from this computer.** This runs `sf org logout`. The org itself isn't deleted, but a scratch org can't be logged back in to.

## Choose a browser and profile

![The settings dialog: open orgs in a chosen browser and profile, and by tag](https://cdn.jsdelivr.net/npm/@taggalongtech/org-launcher@0.1.2/docs/images/settings.png)

Orgs open in your default browser until you click **settings** and pick another:

- **Open orgs in:** one browser and profile for every org.
- **By tag:** orgs with a tag open in their own browser and profile. Keep client orgs in that client's profile, for example.
- **Open in…** in a row's `⋯` menu: a browser for that org only.

An org's own choice wins, then the first of its tags with a rule, then the choice for every org.

Org Launcher knows Chrome, Edge, Brave and Firefox. Chrome, Edge and Brave call their profiles "Default" or "Profile" and a number, like "Profile 3". To find yours, open `chrome://version` in that profile and look at the last part of **Profile Path**. For Firefox, use the profile's name.

## Light or dark

![The same table in the dark theme](https://cdn.jsdelivr.net/npm/@taggalongtech/org-launcher@0.1.2/docs/images/table-dark.png)

The page follows your computer's light or dark setting. To pick one yourself, click **theme** at the top right: it goes from auto to light to dark and back. Your browser remembers the choice.

## Start at login and the Dock app

```sh
sf launcher start --at-login   # start now, and every time you log in
sf launcher dock               # Mac: add Org Launcher to the Dock
sf launcher dock --remove      # take it out of the Dock and delete it
sf launcher status             # is it running, and where
sf launcher stop               # stop it
```

Nothing starts at login unless you say yes at the first `sf launcher` or run `start --at-login`.

- **Mac:** a LaunchAgent in `~/Library/LaunchAgents`.
- **Linux:** a systemd user service, `~/.config/systemd/user/org-launcher.service`.
- **Windows:** a Task Scheduler task named "Org Launcher". Creating it may need a terminal run as administrator, and a console window may show when it starts.

The login service restarts Org Launcher if it fails, but not after you stop it. When the Salesforce CLI updates itself, the next `sf launcher` points the login service at the new version without asking again.

The Dock app lives in the Applications folder in your home folder. It opens the page in its own window if your browser for every org is Chrome, Edge or Brave, and in a tab of your default browser otherwise. If Org Launcher isn't running, the Dock app starts it through the login service, or tells you to run `sf launcher`.

The page uses port 4242. If another program has it, pick another port; Org Launcher remembers it:

```sh
sf launcher start --port 4343
```

The login service belongs to the folder it was set up from. With `ORG_LAUNCHER_HOME` set to another folder, the commands leave it alone. On Windows the task can't record its folder, so every folder treats it as its own.

## Privacy

- **Your logins stay where the Salesforce CLI keeps them.** Org Launcher reads them in memory through `@salesforce/core`, the CLI's own library. It never writes a token or login link to disk, never logs one, and never sends one to the page.
- **The page only answers this computer.** The server listens on 127.0.0.1 only. It refuses requests addressed to any other host name, and changes sent from any other web page.
- **No tracking.** No telemetry, analytics or update checks. The only network calls go to your own orgs.

Org Launcher saves its own data in `~/.sf/org-launcher`: your tags, notes and settings, the project folders you ran `sf launcher` from, the last check of each org (its type, packages and Apex count), and a log with the method and path of each request. The log is kept under 1 MB, plus one older copy. Set `ORG_LAUNCHER_HOME` to use another folder.

## Platforms

Org Launcher is fully supported on macOS. Windows and Linux are early: the tests pass there, but they've had less use.

## Questions and problems

Something not working, or an idea for what it should do next? [Tell us at taggalong.com](https://taggalong.com/contact/).

## Uninstall

Remove the login service and the Dock app first, then the plugin:

```sh
sf launcher uninstall
sf plugins uninstall @taggalongtech/org-launcher
```

`sf launcher uninstall` keeps your tags, notes and settings. Add `--purge` to delete them too. Your orgs and their logins aren't touched.

## License

[MIT](https://cdn.jsdelivr.net/npm/@taggalongtech/org-launcher@0.1.2/LICENSE). Built by [Taggalong](https://taggalong.com/accelerators).
