import { object } from "./config";
import type { Body } from "./protocol";

/**
 * Coding agents (Claude Code, Codex, Cline, opencode…) keep their memory, but only of what was said.
 * Each tool step is its own request, and what it carries is about the code, not the relationship.
 * So for a coding request the gateway records:
 *  - the person's words with code blocks replaced by [code];
 *  - a reply that touched no code tool, with code blocks replaced the same way;
 *  - from a step that read, ran or edited code, only its other tool calls (a message sent through a
 *    tool, say). A step left with nothing is not recorded at all, so it costs no D1 writes.
 * Recall is unchanged: it runs on the person's turns only, as for any client.
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
/** Tools whose calls are about the code; a step that calls one is not conversation. */
const CODE_TOOLS = new Set([...SHELL_TOOLS, ...EDIT_TOOLS, "read", "readfile", "view", "viewfile", "glob", "grep",
  "grepsearch", "ls", "list", "listfiles", "listdir", "listdirectory", "searchfiles", "filesearch", "findfiles",
  "codebasesearch", "notebookread", "bashoutput", "killbash", "killshell", "todowrite", "todoread", "updateplan",
  "task", "lsp", "diagnostics"]);

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

export function isCodeTool(name: string): boolean {
  return CODE_TOOLS.has(normalize(name));
}

/** Fenced code blocks (``` or ~~~, closed or running to the end) become [code]; code alone leaves "". */
export function stripCodeBlocks(text: string): string {
  const said = text
    .replace(/(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*(?:(?:\n[\s\S]*?)?\n[ \t]*\2[ \t]*(?=\n|$)|[\s\S]*$)/g, "$1[code]")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return said.replaceAll("[code]", "").trim() ? said : "";
}

/** What a coding agent's reply said, for the record (see the header). */
export function codingSpeech(out: { text: string; tools: Array<{ name: string; line: string }> }): string {
  if (out.tools.some(tool => isCodeTool(tool.name))) {
    return out.tools.filter(tool => !isCodeTool(tool.name)).map(tool => tool.line).join("\n");
  }
  return stripCodeBlocks(out.text);
}
