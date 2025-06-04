#!/usr/bin/env fish

function main
    while true
        set user_input (read)

        if test -z "$user_input"
            # Skip empty input
            continue
        end

        complete -C "$user_input"
    end
end

main
