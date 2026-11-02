# summary

Start Org Launcher's background server.

# description

Starts the server that serves the page at http://localhost:<port>. With --at-login, it also starts Org Launcher at every login, without asking.

# flags.port.summary

Port for the page. Saved for every later start.

# flags.at-login.summary

Start Org Launcher at every login too.

# examples

- Start the server:

  <%= config.bin %> <%= command.id %>

- Start on another port, and at every login:

  <%= config.bin %> <%= command.id %> --port 4343 --at-login

# info.running

Running at %s

# info.alreadyRunning

Org Launcher is already running at %s

# info.atLogin

Org Launcher now starts at login.
