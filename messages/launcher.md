# summary

Open Org Launcher: one page with every org your sf CLI knows.

# description

Starts Org Launcher's background server if it isn't running, then opens the page. The first time you run it in a terminal, it asks whether to keep Org Launcher running at login and, on macOS, whether to add it to the Dock.

# examples

- Open the page:

  <%= config.bin %> <%= command.id %>

# prompt.atLogin

Keep Org Launcher running at login? (Y/n)

# prompt.dock

Add Org Launcher to the Dock? (Y/n)

# info.started

Started Org Launcher. It's at %s.

# info.opened

Org Launcher is at %s.

# info.atLogin

Org Launcher now starts at login.

# info.dock

Added Org Launcher to the Dock.

# warn.open

Couldn't open the page. Open %s in your browser.

# warn.atLogin

Couldn't set Org Launcher to start at login. Try again with sf launcher start --at-login.

# warn.dock

Couldn't add Org Launcher to the Dock. Try again with sf launcher dock.

# error.didNotStart

Org Launcher didn't start. Check %s, then try again.
