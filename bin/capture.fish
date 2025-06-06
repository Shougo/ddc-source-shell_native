#!/usr/bin/env fish

function main
    while true
        set user_input (read)

        if test -n "$user_input"
            # Only procss non-empty input
            complete -C "$user_input"
        end

        echo "EOF" >&2
    end
end

main
