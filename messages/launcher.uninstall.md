# summary

Remove Org Launcher's login service and Dock app, and stop it.

# description

Removes what sf plugins uninstall can't: the login service and, on macOS, the Dock app. Stops the server. Keeps your tags, notes and settings unless you add --purge.

# flags.purge.summary

Delete your tags, notes and settings too.

# examples

- Remove the login service and Dock app:

  <%= config.bin %> <%= command.id %>

- Remove everything, saved data included:

  <%= config.bin %> <%= command.id %> --purge

# info.removed

Stopped Org Launcher. It no longer starts at login.

# info.removedDock

Stopped Org Launcher. It no longer starts at login, and the Dock app is removed.

# info.kept

Your tags, notes and settings are kept in %s. To delete them too, run sf launcher uninstall --purge.

# info.purged

Deleted your tags, notes and settings.

# info.plugin

To remove the plugin itself, run sf plugins uninstall @taggalong/org-launcher.

# warn.atLogin

Couldn't remove the login service. Run sf launcher uninstall again.

# warn.stop

Couldn't stop the server. Run sf launcher stop.

# warn.dock

Couldn't remove the Dock app. Delete Org Launcher from the Applications folder in your home folder, and unpin it from the Dock.

# warn.purge

Couldn't delete everything in %s. Delete what's left by hand.

# error.incomplete

Some parts of Org Launcher are still here. See the warnings above.
