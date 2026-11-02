# summary

Replace an org's note.

# description

Names the org like -o does: an alias, a username or an org id. The note replaces the old one; an empty note clears it. Prints the org's tags and note afterwards.

# args.org.description

Alias, username or org id of the org.

# args.text.description

The new note, up to 500 characters.

# examples

- Set a note:

  <%= config.bin %> <%= command.id %> my-scratch "Demo data loaded"

- Clear the note:

  <%= config.bin %> <%= command.id %> my-scratch ""
