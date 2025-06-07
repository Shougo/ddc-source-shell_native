# zpty shell completion settings

typeset -gx CACHE_DIR=${XDG_CACHE_HOME:-"$HOME/.cache"}/ddc-source-shell_native

mkdir -p "$CACHE_DIR"

# No prompt!
PROMPT=

# Load completion system
autoload -U compinit; compinit -C
compinit -d "$CACHE_DIR/compdump"

# Never run commands
bindkey '^M' undefined
bindkey '^J' undefined
bindkey '^I' complete-word

# Send a line with null-byte at the end before and after completions are output
null-line () {
    echo -E - $'\0'
}
compprefuncs=( null-line )
comppostfuncs=( null-line exit )

# Never group stuff!
zstyle ':completion:*' list-grouped false
zstyle ':completion:*' force-list always
# Don't insert tab when attempting completion on empty line
zstyle ':completion:*' insert-tab false
# No list separator, this saves some stripping later on
zstyle ':completion:*' list-separator ''
# for list even if too many
zstyle ':completion:*' list-prompt   ''
zstyle ':completion:*' select-prompt ''
zstyle ':completion:*' menu true

# We use zparseopts
zmodload zsh/zutil

# Override compadd (this our hook)
compadd () {

    # Check if any of -O, -A or -D are given
    if [[ ${@[1,(i)(-|--)]} == *-(O|A|D)\ * ]]; then
        # If that is the case, just delegate and leave
        builtin compadd "$@"
        return $?
    fi

    # OK, this concerns us!
    # echo -E - got this: "$@"

    # Be careful with namespacing here, we don't want to mess with stuff
    # that should be passed to compadd!
    typeset -a __hits __dscr __tmp

    # Do we have a description parameter?
    # NOTE: we don't use zparseopts here because of combined option
    # parameters with arguments like -default- confuse it.
    if (( $@[(I)-d] )); then # kind of a hack, $+@[(r)-d] doesn't work because of line noise overload
        # next param after -d
        __tmp=${@[$[${@[(i)-d]}+1]]}
        # description can be given as an array parameter name, or inline () array
        if [[ $__tmp == \(* ]]; then
            eval "__dscr=$__tmp"
        else
            __dscr=( "${(@P)__tmp}" )
        fi
    fi

    # Capture completions by injecting -A parameter into the compadd call.
    # This takes care of matching for us.
    builtin compadd -A __hits -D __dscr "$@"

    # JESUS CHRIST IT TOOK ME FOREVER TO FIGURE OUT THIS OPTION WAS SET AND WAS MESSING WITH MY SHIT HERE
    setopt localoptions norcexpandparam extendedglob

    # Extract prefixes and suffixes from compadd call. we can't do zsh's cool
    # -r remove-func magic, but it's better than nothing.
    typeset -A apre hpre hsuf asuf
    zparseopts -E P:=apre p:=hpre S:=asuf s:=hsuf

    # Append / to directories? we are only emulating -f in a half-assed way
    # here, but it's better than nothing.
    integer dirsuf=0
    # don't be fooled by -default- >.>
    if [[ -z $hsuf && "${${@//-default-/}% -# *}" == *-[[:alnum:]]#f* ]]; then
        dirsuf=1
    fi

    # Just drop
    [[ -n $__hits ]] || return

    # This is the point where we have all matches in $__hits and all
    # descriptions in $__dscr!

    # Display all matches
    local dsuf dscr
    for i in {1..$#__hits}; do

        # Add a dir suffix?
        (( dirsuf )) && [[ -d $__hits[$i] ]] && dsuf=/ || dsuf=
        # Description to be displayed afterwards
        (( $#__dscr >= $i )) && dscr=" -- ${${__dscr[$i]}##$__hits[$i] #}" || dscr=

        echo -E - $IPREFIX$apre$hpre$__hits[$i]$dsuf$hsuf$asuf$dscr

    done
}

# signal success!
echo ok
