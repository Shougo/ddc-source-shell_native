#!/usr/bin/env fish

function main
    while true
        read --local user_input

        if test -n "$user_input"
            # Only procss non-empty input
            complete -C "$user_input"
        end

        echo "EOF" >&2
    end
end

main
