import { object } from "./config";
import type { Body } from "./protocol";

/**
 * Coding agents (Claude Code, Codex, Cline, opencode…) keep their memory, but only of what was said.
 * Each tool step is its own request, and what it carries is about the code, not the relationship.
 * So for a coding request the gateway records:
 *  - the person's words with code blocks replaced by [code];
 *  - a reply that called no work tool, with code blocks replaced the same way;
 *  - from a step that called a work tool, only its speech tool calls (a message sent through a
 *    tool). Work tools are every tool that is not speech, so tool names nobody listed stay out.
 *    Their arguments never enter the record, so they cannot crowd out or outgrow the 8,000-character
 *    cap. A finished step left with nothing is not recorded at all, so it costs no D1 writes; a
 *    failed one is still recorded as failed.
 * Recall still runs on the person's turns only, and searches without the code.
 * An assistant can switch this off with `codingFilter: false` to record everything as before.
 *
 * A request counts as coding when either signal is present:
 *  - the client names itself in its User-Agent or attribution headers;
 *  - the request offers both a shell tool and a file-editing tool.
 */
const CLIENT_HEADERS = ["user-agent", "x-title", "http-referer", "referer", "originator"];
const CLIENT_RE = /claude-cli|claude-code|codex|opencode|kilo[ -]?code|kilocode\.ai|\bcline\b|roo[ -]?code|\baider\b|charm-crush|qwen-?code/i;

// Names are compared lowercased with separators and trailing version dates removed,
// so "Bash", "bash_20250124" and "run-terminal-cmd" line up with the lists below.
const SHELL_TOOLS = new Set(["bash", "shell", "localshell", "executecommand", "runterminalcmd", "runcommand",
  "runshellcommand", "execcommand", "exec", "terminal"]);
const EDIT_TOOLS = new Set(["edit", "multiedit", "write", "applypatch", "strreplaceeditor", "strreplacebasededittool",
  "texteditor", "writetofile", "replaceinfile", "editfile", "applydiff", "createfile", "insertcontent",
  "searchandreplace", "notebookedit", "writefile", "patch"]);
// A speech tool says something to someone: its name has one of these words and none of the second set
// ("sendKeys" types into a terminal, "commit_message" writes to git).
const SPEECH_WORDS = new Set(["send", "reply", "message", "messages", "msg", "notify", "speak", "say", "voice", "tts", "sticker", "dm"]);
const NOT_SPEECH_WORDS = new Set(["key", "keys", "terminal", "shell", "bash", "exec", "command", "file", "files", "commit",
  "log", "logs", "code", "pr", "pull", "issue", "input"]);

function normalize(name: unknown): string {
  return typeof name === "string" ? name.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/\d+$/, "") : "";
}

/** Every name a tool definition answers to, across Chat Completions, Messages and Responses shapes. */
function toolNames(tool: unknown): string[] {
  if (!object(tool)) return [];
  return [tool.name, tool.type, object(tool.function) ? tool.function.name : undefined].map(normalize).filter(Boolean);
}

/** Why this request looks like a coding agent, or null. */
export function codingClient(headers: Headers, body: Body): string | null {
  for (const name of CLIENT_HEADERS) {
    const match = headers.get(name)?.match(CLIENT_RE);
    if (match) return `client:${match[0].toLowerCase()}`;
  }
  const names = new Set((Array.isArray(body.tools) ? body.tools : []).flatMap(toolNames));
  const shell = [...names].find(name => SHELL_TOOLS.has(name));
  const edit = [...names].find(name => EDIT_TOOLS.has(name));
  return shell && edit ? `tools:${shell}+${edit}` : null;
}

export function isSpeechTool(name: string): boolean {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.some(word => SPEECH_WORDS.has(word)) && !words.some(word => NOT_SPEECH_WORDS.has(word));
}

/**
 * Fenced code blocks become [code]; code alone leaves "". As in CommonMark, a block closes at a line
 * of the same fence character at least as long as the opening one, or runs to the end.
 */
export function stripCodeBlocks(text: string): string {
  const said = text
    .replace(/(^|\n)[ \t]*((`|~)\3{2,})[^\n]*(?:(?:\n[\s\S]*?)?\n[ \t]*\2\3*[ \t]*(?=\n|$)|[\s\S]*$)/g, "$1[code]")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return said.replaceAll("[code]", "").trim() ? said : "";
}

/** The words to search memories with: no code, no placeholders. */
export function recallWords(text: string): string {
  return stripCodeBlocks(text).replaceAll("[code]", " ").replace(/\s+/g, " ").trim();
}

/** What a coding agent's reply said, for the record (see the header), and whether it hit the cap. */
export function codingSpeech(out: { text: string; truncated: boolean; overflow: boolean; workCalls: number;
  spoken: string; spokenTruncated: boolean }): { text: string; truncated: boolean } {
  if (out.workCalls) return { text: out.spoken, truncated: out.overflow || out.spokenTruncated };
  return { text: stripCodeBlocks(out.text), truncated: out.truncated };
}
