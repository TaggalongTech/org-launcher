# summary

Add, remove or set an org's tags.

# description

Names the org like -o does: an alias, a username or an org id. Tags are lowercase letters, numbers, dot, dash or underscore. Prints the org's tags and note afterwards; with no tags or flags, just prints them.

# args.org.description

Alias, username or org id of the org.

# flags.remove.summary

Tags to remove.

# flags.set.summary

Tags to keep; every other tag is removed.

# examples

- Add two tags:

  <%= config.bin %> <%= command.id %> my-scratch demo qa

- Remove a tag:

  <%= config.bin %> <%= command.id %> my-scratch --remove qa

- Replace every tag:

  <%= config.bin %> <%= command.id %> my-scratch --set demo --set release

# error.setWithTags

Use --set on its own, or add tags without it.
