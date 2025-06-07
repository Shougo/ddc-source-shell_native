#!/usr/bin/env zsh

zmodload zsh/zpty || { echo 'error: missing module zsh/zpty' >&2; exit 1 }

local zpty_rcfile=${0:h}/zptyrc.zsh
[[ -r $zpty_rcfile ]] || { echo "error: rcfile not found: $zpty_rcfile" >&2; exit 1; }

# Main loop to read from stdin and process completion
while true; do
    # Spawn shell
    zpty z zsh -f -i

    # Line buffer for pty output
    local line

    # Initialize shell settings before processing
    zpty -w z "source ${(qq)zpty_rcfile}"
    () {
        repeat 4; do
            zpty -r z line
            [[ $line == ok* ]] && return
        done
        echo 'error: initialization failure' >&2
        exit 2
    }

    # Read input from stdin
    local input
    IFS= read -r input || break

    # Trigger completion and send it to the pty
    zpty -w z "$input"$'\t'

    integer tog=0
    # Read and parse output from the pty
    while zpty -r z; do :; done | while IFS= read -r line; do
        if [[ $line == *$'\0\r' ]]; then
            (( tog++ )) && break || continue
        fi
        # Display completion output between toggles
        (( tog )) && echo -E - $line
    done

    echo "EOF" >&2

    # Clean up the zpty process after the loop exits
    zpty -d z
done
