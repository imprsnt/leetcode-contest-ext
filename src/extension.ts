import * as vscode from "vscode";
import * as https from "https";
import * as fs from "fs";
import * as path from "path";

interface ContestQuestion {
  questionId: string;
  title: string;
  titleSlug: string;
}

interface ContestInfo {
  title: string;
  titleSlug: string;
  questions: ContestQuestion[];
}

interface QuestionData {
  snippet: string | null;
  content: string | null;
  difficulty: string;
  exampleTestcases: string | null;
}

interface Auth {
  csrfToken: string;
  sessionCookie: string;
  cookieHeader: string;
}

let out: vscode.OutputChannel;

// ── HTML → Markdown ───────────────────────────────────────────────────────────

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&le;/g, "≤")
    .replace(/&ge;/g, "≥")
    .replace(/&times;/g, "×")
    .replace(/&divide;/g, "÷")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

function htmlToMarkdown(html: string): string {
  if (!html) {
    return "";
  }

  let md = html;

  // <pre> blocks → fenced code (strip inner tags, keep text)
  md = md.replace(/<pre>([\s\S]*?)<\/pre>/gi, (_, inner) => {
    const text = decodeEntities(stripTags(inner)).trim();
    return "\n```\n" + text + "\n```\n\n";
  });

  // Superscript: 10<sup>4</sup> → 10^4
  md = md.replace(/<sup>([\s\S]*?)<\/sup>/gi, (_, c) => "^" + stripTags(c));

  // Subscript
  md = md.replace(/<sub>([\s\S]*?)<\/sub>/gi, (_, c) => "_" + stripTags(c) + "_");

  // Bold
  md = md.replace(/<strong>([\s\S]*?)<\/strong>/gi, "**$1**");
  md = md.replace(/<b>([\s\S]*?)<\/b>/gi, "**$1**");

  // Italic
  md = md.replace(/<em>([\s\S]*?)<\/em>/gi, "*$1*");
  md = md.replace(/<i>([\s\S]*?)<\/i>/gi, "*$1*");

  // Inline code
  md = md.replace(/<code>([\s\S]*?)<\/code>/gi, "`$1`");

  // Links
  md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");

  // List items
  md = md.replace(/<li>([\s\S]*?)<\/li>/gi, (_, c) => "- " + c.trim() + "\n");
  md = md.replace(/<\/?[uo]l[^>]*>/gi, "\n");

  // Paragraphs and headers
  md = md.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lvl, c) =>
    "#".repeat(parseInt(lvl, 10)) + " " + c.trim() + "\n\n"
  );
  md = md.replace(/<p>([\s\S]*?)<\/p>/gi, "$1\n\n");

  // Line breaks
  md = md.replace(/<br\s*\/?>/gi, "\n");

  // Strip any remaining tags
  md = md.replace(/<[^>]+>/g, "");

  // Decode entities last (after tag removal, so < > inside code blocks survive)
  md = decodeEntities(md);

  // Collapse 3+ newlines → 2
  md = md.replace(/\n{3,}/g, "\n\n").trim();

  return md;
}

// ── Fallback .cpp template ────────────────────────────────────────────────────

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-");
}

const FALLBACK_CPP = (title: string, questionId: string, label: string) => `/*
 * ${questionId}. ${title}
 * https://leetcode.com/problems/${slugify(title)}/
 *
 * Sample input: ${label}_input.txt
 * Run: g++ -O2 -o sol ${label}_${sanitizeFilename(title)}.cpp && ./sol < ${label}_input.txt
 */

#include <bits/stdc++.h>
using namespace std;

class Solution {
public:

};

int main() {
    ios_base::sync_with_stdio(false);
    cin.tie(NULL);
    // freopen("${label}_input.txt", "r", stdin);

    return 0;
}
`;

function wrapSnippet(
  snippet: string,
  title: string,
  questionSlug: string,
  label: string
): string {
  const baseName = `${label}_${sanitizeFilename(title)}`;
  return `/*
 * ${title}
 * https://leetcode.com/problems/${questionSlug}/
 *
 * Sample input: ${label}_input.txt
 * Run: g++ -O2 -o sol ${baseName}.cpp && ./sol < ${label}_input.txt
 */

#include <bits/stdc++.h>
using namespace std;

${snippet}
`;
}

function buildMarkdown(
  q: ContestQuestion,
  label: string,
  difficulty: string,
  content: string | null
): string {
  const url = `https://leetcode.com/problems/${q.titleSlug}/`;
  const header = [
    `# ${label}. ${q.title}`,
    "",
    `**Difficulty:** ${difficulty || "Unknown"} · [Open on LeetCode](${url})`,
    "",
    "---",
    "",
  ].join("\n");

  const body = content
    ? htmlToMarkdown(content)
    : "*Problem statement not available yet.*";

  return header + body + "\n";
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function httpsGet(
  url: string,
  headers: Record<string, string>
): Promise<{ body: string; cookies: string[] }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.request(
      {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: "GET",
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () =>
          resolve({
            body: data,
            cookies: (res.headers["set-cookie"] as string[]) ?? [],
          })
        );
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function httpsPost(
  url: string,
  body: string,
  headers: Record<string, string>
): Promise<string> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.request(
      {
        hostname: urlObj.hostname,
        path: urlObj.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Auth ──────────────────────────────────────────────────────────────────────

async function fetchCsrfToken(): Promise<string | null> {
  // Fetch WITHOUT session cookie — LeetCode only sets csrftoken for fresh requests
  for (const url of ["https://leetcode.com/", "https://leetcode.com/accounts/login/"]) {
    try {
      const { cookies } = await httpsGet(url, {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      });
      for (const c of cookies) {
        const m = c.match(/csrftoken=([^;]+)/);
        if (m) {
          out.appendLine(`[auth] csrftoken from ${url}: ${m[1].slice(0, 8)}…`);
          return m[1];
        }
      }
      out.appendLine(`[auth] No csrftoken from ${url}. Cookies: ${cookies.join(" | ")}`);
    } catch (e) {
      out.appendLine(`[auth] GET ${url} failed: ${e}`);
    }
  }
  return null;
}

async function buildAuth(sessionCookie: string): Promise<Auth | null> {
  const csrfToken = await fetchCsrfToken();
  if (!csrfToken) {
    out.appendLine("[auth] Could not obtain CSRF token from leetcode.com");
    return null;
  }
  return {
    csrfToken,
    sessionCookie,
    cookieHeader: `LEETCODE_SESSION=${sessionCookie}; csrftoken=${csrfToken}`,
  };
}

// ── LeetCode API ──────────────────────────────────────────────────────────────

async function fetchContestInfo(
  titleSlug: string,
  auth: Auth
): Promise<ContestInfo | null> {
  const query = `
    query contestInfo($titleSlug: String!) {
      contest(titleSlug: $titleSlug) {
        title
        titleSlug
        questions { questionId title titleSlug }
      }
    }
  `;

  try {
    const raw = await httpsPost(
      "https://leetcode.com/graphql",
      JSON.stringify({ query, variables: { titleSlug } }),
      {
        Referer: `https://leetcode.com/contest/${titleSlug}/`,
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "x-csrftoken": auth.csrfToken,
        Cookie: auth.cookieHeader,
      }
    );

    out.appendLine(`[contest] ${raw.slice(0, 400)}`);
    const json = JSON.parse(raw);
    return (json?.data?.contest as ContestInfo) ?? null;
  } catch (e) {
    out.appendLine(`[contest] Error: ${e}`);
    return null;
  }
}

async function fetchQuestionData(
  questionSlug: string,
  contestSlug: string,
  auth: Auth
): Promise<QuestionData> {
  const query = `
    query questionData($titleSlug: String!) {
      question(titleSlug: $titleSlug) {
        difficulty
        content
        exampleTestcases
        codeSnippets { lang langSlug code }
      }
    }
  `;

  try {
    const raw = await httpsPost(
      "https://leetcode.com/graphql",
      JSON.stringify({ query, variables: { titleSlug: questionSlug } }),
      {
        Referer: `https://leetcode.com/contest/${contestSlug}/problems/${questionSlug}/`,
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "x-csrftoken": auth.csrfToken,
        Cookie: auth.cookieHeader,
      }
    );

    out.appendLine(`[question:${questionSlug}] ${raw.slice(0, 300)}`);
    const json = JSON.parse(raw);
    const q = json?.data?.question;
    if (!q) {
      return { snippet: null, content: null, difficulty: "", exampleTestcases: null };
    }

    const snippets: { lang: string; langSlug: string; code: string }[] =
      q.codeSnippets ?? [];
    const cpp = snippets.find((s) => s.langSlug === "cpp");
    out.appendLine(
      `[question:${questionSlug}] langs: ${snippets.map((s) => s.langSlug).join(", ") || "none"}`
    );

    return {
      snippet: cpp?.code ?? null,
      content: q.content ?? null,
      difficulty: q.difficulty ?? "",
      exampleTestcases: q.exampleTestcases ?? null,
    };
  } catch (e) {
    out.appendLine(`[question:${questionSlug}] Error: ${e}`);
    return { snippet: null, content: null, difficulty: "", exampleTestcases: null };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractContestSlug(input: string): string | null {
  const urlMatch = input.match(/leetcode\.com\/contest\/([\w-]+)/);
  if (urlMatch) {
    return urlMatch[1];
  }
  if (/^[\w-]+$/.test(input.trim())) {
    return input.trim();
  }
  return null;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\-. ]/g, "").replace(/\s+/g, "_");
}

async function getSessionCookie(
  context: vscode.ExtensionContext
): Promise<string | undefined> {
  const stored = context.globalState.get<string>("leetcodeSession");
  if (stored) {
    return stored;
  }

  const value = await vscode.window.showInputBox({
    prompt:
      "Enter your LeetCode session cookie (LEETCODE_SESSION). " +
      "Get it: browser DevTools → Application → Cookies → leetcode.com → LEETCODE_SESSION",
    placeHolder: "eyJ0eXAiOiJKV1QiLCJhbGci…",
    password: true,
    ignoreFocusOut: true,
  });

  if (value?.trim()) {
    await context.globalState.update("leetcodeSession", value.trim());
    return value.trim();
  }

  return undefined;
}

// ── Extension entry point ─────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  out = vscode.window.createOutputChannel("LeetCode Contest");

  context.subscriptions.push(
    vscode.commands.registerCommand("leetcode-contest.clearSession", async () => {
      await context.globalState.update("leetcodeSession", undefined);
      vscode.window.showInformationMessage(
        "LeetCode session cleared. You will be prompted on the next join."
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "leetcode-contest.joinContest",
      async () => {
        out.clear();
        out.show(true);

        // 1. Session cookie
        const sessionCookie = await getSessionCookie(context);
        if (!sessionCookie) {
          vscode.window.showErrorMessage(
            "Session cookie is required. Run the command again to enter it."
          );
          return;
        }

        // 2. Contest URL / slug
        const input = await vscode.window.showInputBox({
          prompt: "Enter LeetCode contest URL or slug",
          placeHolder:
            "https://leetcode.com/contest/weekly-contest-425/ or weekly-contest-425",
          validateInput: (val) => {
            if (!val?.trim()) {
              return "Please enter a contest URL or slug";
            }
            if (!extractContestSlug(val)) {
              return "Invalid URL or slug format";
            }
            return undefined;
          },
        });

        if (!input) {
          return;
        }

        const titleSlug = extractContestSlug(input)!;

        // 3. Workspace root
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders?.length) {
          vscode.window.showErrorMessage(
            "No workspace folder open. Please open a folder first."
          );
          return;
        }
        const workspaceRoot = workspaceFolders[0].uri.fsPath;

        // 4. Fetch everything
        type FetchResult = {
          contest: ContestInfo;
          questionData: QuestionData[];
        };

        const result = await vscode.window.withProgress<FetchResult | null>(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Fetching contest: ${titleSlug}`,
            cancellable: false,
          },
          async (progress) => {
            progress.report({ message: "Authenticating…" });
            const auth = await buildAuth(sessionCookie);
            if (!auth) {
              out.appendLine("[error] Auth failed — session cookie may be expired.");
              return null;
            }

            progress.report({ message: "Loading contest questions…" });
            const contest = await fetchContestInfo(titleSlug, auth);
            if (!contest) {
              return null;
            }
            if (!contest.questions?.length) {
              return { contest, questionData: [] };
            }

            progress.report({
              message: `Fetching ${contest.questions.length} problems…`,
            });
            const questionData = await Promise.all(
              contest.questions.map((q) =>
                fetchQuestionData(q.titleSlug, titleSlug, auth)
              )
            );

            return { contest, questionData };
          }
        );

        if (!result) {
          const action = await vscode.window.showErrorMessage(
            `Could not fetch contest "${titleSlug}". Session cookie may be expired.`,
            "Re-enter Session Cookie"
          );
          if (action === "Re-enter Session Cookie") {
            await context.globalState.update("leetcodeSession", undefined);
          }
          return;
        }

        const { contest, questionData } = result;
        const folderName = sanitizeFilename(contest.title).replace(/\s+/g, "_");
        const contestDir = path.join(workspaceRoot, folderName);

        if (!fs.existsSync(contestDir)) {
          fs.mkdirSync(contestDir, { recursive: true });
        }

        if (!contest.questions?.length) {
          vscode.window.showWarningMessage(
            `Contest "${contest.title}" found but has no questions yet. Folder "${folderName}" was created.`
          );
          return;
        }

        // 5. Write files
        const cppFiles: string[] = [];
        const mdFiles: string[] = [];

        for (let i = 0; i < contest.questions.length; i++) {
          const q = contest.questions[i];
          const { snippet, content, difficulty, exampleTestcases } = questionData[i];
          const label = String.fromCharCode(65 + i);
          const baseName = `${label}_${sanitizeFilename(q.title)}`;

          // .cpp
          const cppPath = path.join(contestDir, baseName + ".cpp");
          if (!fs.existsSync(cppPath)) {
            const cppContent = snippet
              ? wrapSnippet(snippet, q.title, q.titleSlug, label)
              : FALLBACK_CPP(q.title, q.questionId, label);
            fs.writeFileSync(cppPath, cppContent);
            out.appendLine(
              `[cpp] ${baseName}.cpp — ${snippet ? "LeetCode template" : "fallback"}`
            );
          } else {
            out.appendLine(`[cpp] ${baseName}.cpp — already exists, skipped`);
          }
          cppFiles.push(cppPath);

          // _input.txt
          const inputPath = path.join(contestDir, `${label}_input.txt`);
          if (!fs.existsSync(inputPath)) {
            const inputContent = exampleTestcases
              ? exampleTestcases.trim() + "\n"
              : "# No sample input available yet\n";
            fs.writeFileSync(inputPath, inputContent);
            out.appendLine(
              `[txt] ${label}_input.txt — ${exampleTestcases ? "sample test cases" : "placeholder"}`
            );
          } else {
            out.appendLine(`[txt] ${label}_input.txt — already exists, skipped`);
          }

          // .md
          const mdPath = path.join(contestDir, baseName + ".md");
          if (!fs.existsSync(mdPath)) {
            fs.writeFileSync(
              mdPath,
              buildMarkdown(q, label, difficulty, content)
            );
            out.appendLine(
              `[md]  ${baseName}.md — ${content ? "problem statement" : "placeholder"}`
            );
          } else {
            out.appendLine(`[md]  ${baseName}.md — already exists, skipped`);
          }
          mdFiles.push(mdPath);
        }

        // 6. Open files: .cpp editors + .md previews side-by-side
        for (const cppPath of cppFiles) {
          const doc = await vscode.workspace.openTextDocument(cppPath);
          await vscode.window.showTextDocument(doc, {
            preview: false,
            viewColumn: vscode.ViewColumn.One,
          });
        }

        for (const mdPath of mdFiles) {
          await vscode.commands.executeCommand(
            "markdown.showPreviewToSide",
            vscode.Uri.file(mdPath)
          );
        }

        vscode.window.showInformationMessage(
          `Contest "${contest.title}" ready! ${cppFiles.length} problems in "${folderName}".`
        );
      }
    )
  );
}

export function deactivate() {}
