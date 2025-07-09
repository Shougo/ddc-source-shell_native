#!/usr/bin/env fish

set --local MSG_CHDIR "chdir:"
set --local MSG_INPUT "input:"

set --local END_OF_COMPLETION "\n\x01EOC\x01\n"

set --local user_input
while true
    read --local message || break

    switch $message
        case "$MSG_CHDIR*"
            # Change the current working directory
            set --local new_cwd (string replace -r "^$MSG_CHDIR" "" "$message")
            cd "$new_cwd"
            continue
        case "$MSG_INPUT*"
            # Do completion
            set user_input (string replace -r "^$MSG_INPUT" "" "$message")
        case "*"
            echo "error: invalid message: $message" >&2
            exit 1
    end

    begin
        complete --do-complete "$user_input"
        echo -ne $END_OF_COMPLETION
    end >&1

    set user_input
end
