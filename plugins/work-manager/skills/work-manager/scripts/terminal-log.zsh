# Work Manager terminal log (optional; added to ~/.zshrc only when you ask).
# For each command typed in a terminal it writes one line when the command
# starts and one when it ends: the command, folder, terminal app, exit code
# and how long it took. It never records what the command printed.
# A command that starts with a space is not logged. Only the command words
# are kept (e.g. "npm run build"), not its arguments, so passwords and tokens
# are not recorded (redact.mjs; full text with secrets hidden is an opt-in
# setting). If node cannot be found, only the program name is kept.
# Only interactive shells are logged (not VS Code tasks or `zsh -c` scripts).
[[ -o interactive ]] || return 0
zmodload zsh/datetime 2>/dev/null || return 0
autoload -Uz add-zsh-hook

# The stable copy lives in <data>/runtime, so the log goes next to it in <data>.
typeset -g _wm_here="${${(%):-%x}:A:h}"
if [[ ${_wm_here:t} == runtime ]]; then
  # Stop logging once the Work Manager this copy came from has been removed.
  [[ -f $_wm_here/skill-dir && ! -d "$(<$_wm_here/skill-dir)" ]] && return 0
  typeset -g _wm_log="${WM_TERMINAL_LOG:-${_wm_here:h}/terminal-log.jsonl}"
else
  typeset -g _wm_log="${WM_TERMINAL_LOG:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/work-manager/terminal-log.jsonl}"
fi
# Sourcing this file again (source ~/.zshrc, exec zsh) must not reset a
# running command or reuse numbers: numbering starts from the clock.
(( ${+_wm_started} )) || typeset -g _wm_started=""
(( ${+_wm_seq} )) || typeset -gi _wm_seq=$(( EPOCHSECONDS * 1000 ))
# Secrets are hidden by redact.mjs, started in the background so typing is
# never slowed; the command reaches it through a pipe, never through a file.
typeset -g _wm_redact="$_wm_here/redact.mjs"
typeset -g _wm_node="${WM_NODE:-${commands[node]:-/usr/local/bin/node}}"
[[ -x $_wm_node && -f $_wm_redact ]] || _wm_node=""

_wm_json() {
  emulate -L zsh
  local s=$1
  s=${s//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\n'/\\n}; s=${s//$'\t'/\\t}
  s=${s//[[:cntrl:]]/ }
  print -rn -- "$s"
}

_wm_preexec() {
  [[ $1 == ' '* || -z ${1//[[:space:]]/} ]] && { _wm_started=""; return }
  [[ -d ${_wm_log:h} ]] || return
  _wm_started=$EPOCHREALTIME
  (( _wm_seq++ ))
  if [[ -n $_wm_node ]]; then
    print -r -- "$1" | "$_wm_node" "$_wm_redact" run "$EPOCHSECONDS" "$$" "${TTY:t}" "${TERM_PROGRAM:-}" "$PWD" "$_wm_seq" "$_wm_log" &>/dev/null &!
  else
    setopt localoptions extendedglob
    local -a w; w=(${(z)1})
    local -i i=1
    while (( i <= $#w )) && [[ ${w[i]} == [A-Za-z_][A-Za-z0-9_]#(|+)=* || ${w[i]} == (sudo|env|nohup|time|exec|command|nice|caffeinate|-*) ]]; do (( i++ )); done
    local cmd="…"
    (( i <= $#w )) && (( $+commands[${w[i]}] || $+builtins[${w[i]}] || $+aliases[${w[i]}] || $+functions[${w[i]}] )) && cmd=${w[i]:t}
    print -r -- "{\"ev\":\"run\",\"ts\":$EPOCHSECONDS,\"pid\":$$,\"seq\":$_wm_seq,\"tty\":\"${TTY:t}\",\"app\":\"$(_wm_json "${TERM_PROGRAM:-}")\",\"cwd\":\"$(_wm_json "$PWD")\",\"cmd\":\"$(_wm_json "$cmd")\"}" >>| "$_wm_log" 2>/dev/null
  fi
}

_wm_precmd() {
  local ec=$?
  [[ -n $_wm_started ]] || return
  local -i tenths
  (( tenths = (EPOCHREALTIME - _wm_started) * 10 ))
  (( tenths < 0 )) && tenths=0
  print -r -- "{\"ev\":\"end\",\"ts\":$EPOCHSECONDS,\"pid\":$$,\"seq\":$_wm_seq,\"exit\":$ec,\"secs\":$(( tenths / 10 )).$(( tenths % 10 ))}" >>| "$_wm_log" 2>/dev/null
  _wm_started=""
}

add-zsh-hook preexec _wm_preexec
add-zsh-hook precmd _wm_precmd
