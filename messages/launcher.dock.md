# summary

Add Org Launcher to the Dock (macOS).

# description

Makes Org Launcher.app in the Applications folder in your home folder and pins it to the Dock. Click it to open the page as its own window, in the browser you chose for every org. It's safe to run again. With --remove, it unpins the app and deletes it.

# flags.remove.summary

Unpin the Dock app and delete it.

# examples

- Add Org Launcher to the Dock:

  <%= config.bin %> <%= command.id %>

- Remove it from the Dock:

  <%= config.bin %> <%= command.id %> --remove

# info.added

Added Org Launcher to the Dock.

# info.removed

Removed Org Launcher from the Dock.

# error.notMac

The Dock app is for macOS.
