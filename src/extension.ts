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

interface CodeSnippet {
  lang: string;
  langSlug: string;
  code: string;
}

interface Auth {
  csrfToken: string;
  sessionCookie: string;
  cookieHeader: string;
}

let out: vscode.OutputChannel;

const FALLBACK_TEMPLATE = (title: string, questionId: string) => `/*
 * ${questionId}. ${title}
 * https://leetcode.com/problems/${slugify(title)}/
 */

#include <bits/stdc++.h>
using namespace std;

class Solution {
public:

};

int main() {
    ios_base::sync_with_stdio(false);
    cin.tie(NULL);

    return 0;
}
`;

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-");
}

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

async function buildAuth(sessionCookie: string): Promise<Auth | null> {
  try {
    const { cookies } = await httpsGet("https://leetcode.com/", {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      Cookie: `LEETCODE_SESSION=${sessionCookie}`,
    });

    let csrfToken = "";
    for (const c of cookies) {
      const m = c.match(/csrftoken=([^;]+)/);
      if (m) {
        csrfToken = m[1];
        break;
      }
    }

    if (!csrfToken) {
      out.appendLine("[auth] No csrftoken in Set-Cookie. Response cookies: " + cookies.join(" | "));
      return null;
    }

    out.appendLine(`[auth] csrftoken obtained: ${csrfToken.slice(0, 8)}…`);
    return {
      csrfToken,
      sessionCookie,
      cookieHeader: `LEETCODE_SESSION=${sessionCookie}; csrftoken=${csrfToken}`,
    };
  } catch (e) {
    out.appendLine(`[auth] Error: ${e}`);
    return null;
  }
}

async function fetchContestInfo(
  titleSlug: string,
  auth: Auth
): Promise<ContestInfo | null> {
  const query = `
    query contestInfo($titleSlug: String!) {
      contest(titleSlug: $titleSlug) {
        title
        titleSlug
        questions {
          questionId
          title
          titleSlug
        }
      }
    }
  `;

  const body = JSON.stringify({ query, variables: { titleSlug } });

  try {
    const raw = await httpsPost("https://leetcode.com/graphql", body, {
      Referer: `https://leetcode.com/contest/${titleSlug}/`,
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      "x-csrftoken": auth.csrfToken,
      Cookie: auth.cookieHeader,
    });

    out.appendLine(`[contest] ${raw.slice(0, 400)}`);
    const json = JSON.parse(raw);
    if (json?.data?.contest) {
      return json.data.contest as ContestInfo;
    }
    return null;
  } catch (e) {
    out.appendLine(`[contest] Error: ${e}`);
    return null;
  }
}

async function fetchCppSnippet(
  questionSlug: string,
  contestSlug: string,
  auth: Auth
): Promise<string | null> {
  const query = `
    query questionEditorData($titleSlug: String!) {
      question(titleSlug: $titleSlug) {
        codeSnippets {
          lang
          langSlug
          code
        }
      }
    }
  `;

  const body = JSON.stringify({ query, variables: { titleSlug: questionSlug } });

  try {
    const raw = await httpsPost("https://leetcode.com/graphql", body, {
      Referer: `https://leetcode.com/contest/${contestSlug}/problems/${questionSlug}/`,
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      "x-csrftoken": auth.csrfToken,
      Cookie: auth.cookieHeader,
    });

    out.appendLine(`[snippet:${questionSlug}] ${raw.slice(0, 300)}`);
    const json = JSON.parse(raw);
    const snippets: CodeSnippet[] = json?.data?.question?.codeSnippets ?? [];
    out.appendLine(
      `[snippet:${questionSlug}] langs: ${snippets.map((s) => s.langSlug).join(", ") || "none"}`
    );
    return snippets.find((s) => s.langSlug === "cpp")?.code ?? null;
  } catch (e) {
    out.appendLine(`[snippet:${questionSlug}] Error: ${e}`);
    return null;
  }
}

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

function extractContestNumber(titleSlug: string): string {
  const match = titleSlug.match(/(\d+)$/);
  return match ? match[1] : titleSlug;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\-. ]/g, "").replace(/\s+/g, "_");
}

function wrapSnippet(
  snippet: string,
  title: string,
  questionSlug: string
): string {
  return `/*
 * ${title}
 * https://leetcode.com/problems/${questionSlug}/
 */

#include <bits/stdc++.h>
using namespace std;

${snippet}
`;
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
      "Get it from browser DevTools → Application → Cookies → leetcode.com → LEETCODE_SESSION",
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

export function activate(context: vscode.ExtensionContext) {
  out = vscode.window.createOutputChannel("LeetCode Contest");

  // Command to clear saved session (re-login)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "leetcode-contest.clearSession",
      async () => {
        await context.globalState.update("leetcodeSession", undefined);
        vscode.window.showInformationMessage(
          "LeetCode session cleared. You will be prompted on the next join."
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "leetcode-contest.joinContest",
      async () => {
        out.clear();
        out.show(true);

        // 1. Get session cookie
        const sessionCookie = await getSessionCookie(context);
        if (!sessionCookie) {
          vscode.window.showErrorMessage(
            "Session cookie is required. Run the command again to enter it."
          );
          return;
        }

        // 2. Ask for contest URL or slug
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

        // 3. Determine workspace root
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders?.length) {
          vscode.window.showErrorMessage(
            "No workspace folder open. Please open a folder first."
          );
          return;
        }
        const workspaceRoot = workspaceFolders[0].uri.fsPath;

        // 4. Auth + fetch contest + fetch snippets
        type FetchResult = { contest: ContestInfo; snippets: (string | null)[] };

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
              out.appendLine(
                "[error] Could not build auth — session cookie may be expired."
              );
              return null;
            }

            progress.report({ message: "Loading contest questions…" });
            const contest = await fetchContestInfo(titleSlug, auth);
            if (!contest) {
              return null;
            }
            if (!contest.questions?.length) {
              return { contest, snippets: [] };
            }

            progress.report({
              message: `Fetching ${contest.questions.length} C++ templates…`,
            });
            const snippets = await Promise.all(
              contest.questions.map((q) =>
                fetchCppSnippet(q.titleSlug, titleSlug, auth)
              )
            );

            return { contest, snippets };
          }
        );

        if (!result) {
          // Offer to re-enter session in case it was stale
          const action = await vscode.window.showErrorMessage(
            `Could not fetch contest "${titleSlug}". Session cookie may be expired.`,
            "Re-enter Session Cookie"
          );
          if (action === "Re-enter Session Cookie") {
            await context.globalState.update("leetcodeSession", undefined);
          }
          return;
        }

        const { contest, snippets } = result;
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

        // 5. Create .cpp files
        const createdFiles: string[] = [];
        for (let i = 0; i < contest.questions.length; i++) {
          const q = contest.questions[i];
          const label = String.fromCharCode(65 + i);
          const filename = `${label}_${sanitizeFilename(q.title)}.cpp`;
          const filepath = path.join(contestDir, filename);

          if (!fs.existsSync(filepath)) {
            const snippet = snippets[i];
            out.appendLine(
              `[file] ${filename} — ${snippet ? "LeetCode template" : "fallback"}`
            );
            const content = snippet
              ? wrapSnippet(snippet, q.title, q.titleSlug)
              : FALLBACK_TEMPLATE(q.title, q.questionId);
            fs.writeFileSync(filepath, content);
          } else {
            out.appendLine(`[file] ${filename} — already exists, skipped`);
          }
          createdFiles.push(filepath);
        }

        // 6. Open all files
        for (const filepath of createdFiles) {
          const doc = await vscode.workspace.openTextDocument(filepath);
          await vscode.window.showTextDocument(doc, {
            preview: false,
            viewColumn: vscode.ViewColumn.Active,
          });
        }

        vscode.window.showInformationMessage(
          `Contest "${contest.title}" ready! ${createdFiles.length} files in "${folderName}".`
        );
      }
    )
  );
}

export function deactivate() {}
