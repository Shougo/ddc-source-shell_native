#!/usr/bin/env zsh

zmodload zsh/zpty || { echo 'error: missing module zsh/zpty' >&2; exit 1 }

local zpty_rcfile=${0:h}/zptyrc.zsh
[[ -r $zpty_rcfile ]] || { echo "error: rcfile not found: $zpty_rcfile" >&2; exit 1; }

# Spawn shell with non-blocking (-b) output
zpty -b z zsh -f -i

# Line buffer for pty output
local line

# Initialize shell settings before processing
zpty -w z "source ${(qq)zpty_rcfile} && echo ok || exit 2"
zpty -r -m z line '*ok'$'\r' || { echo "error: pty initialization failure" >&2; exit 2 }

# Main loop to read from stdin and process completion
local input
while true; do
    # Read input from stdin
    IFS= read -r input || break

    zpty -t z || { echo "error: pty closed" >&2; exit 1 }

    # Trigger completion and send it to the pty
    zpty -w -n z $'\C-U'"$input"$'\t'

    # Drop before the first null byte
    zpty -r -m z line '*'$'\0' || { echo "error: pty read failure" >&2; exit 1 }

    # Output the completion result
    zpty -r -m z line '*'$'\0' || { echo "error: pty read failure" >&2; exit 1 }
    echo -E - ${line%$'\0'}

    echo "EOF" >&2
done
