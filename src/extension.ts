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

const CPP_TEMPLATE = (title: string, questionId: string) => `/*
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

function httpsPost(
  url: string,
  body: string,
  headers: Record<string, string>
): Promise<string> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        ...headers,
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function fetchContestInfo(
  titleSlug: string
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
    });

    const json = JSON.parse(raw);
    if (json?.data?.contest) {
      return json.data.contest as ContestInfo;
    }
    return null;
  } catch {
    return null;
  }
}

function extractContestSlug(input: string): string | null {
  // Handle full URL: https://leetcode.com/contest/weekly-contest-425/
  const urlMatch = input.match(/leetcode\.com\/contest\/([\w-]+)/);
  if (urlMatch) {
    return urlMatch[1];
  }
  // Handle bare slug: weekly-contest-425
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

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand(
    "leetcode-contest.joinContest",
    async () => {
      // 1. Ask for contest URL or slug
      const input = await vscode.window.showInputBox({
        prompt: "Enter LeetCode contest URL or slug",
        placeHolder:
          "https://leetcode.com/contest/weekly-contest-425/ or weekly-contest-425",
        validateInput: (val) => {
          if (!val || !val.trim()) {
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

      const titleSlug = extractContestSlug(input);
      if (!titleSlug) {
        vscode.window.showErrorMessage("Could not parse contest URL/slug.");
        return;
      }

      // 2. Determine workspace root
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage(
          "No workspace folder open. Please open a folder first."
        );
        return;
      }
      const workspaceRoot = workspaceFolders[0].uri.fsPath;

      // 3. Fetch contest data with progress indicator
      const contest = await vscode.window.withProgress<ContestInfo | null>(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Fetching contest: ${titleSlug}`,
          cancellable: false,
        },
        async () => {
          return fetchContestInfo(titleSlug);
        }
      );

      if (!contest) {
        vscode.window.showErrorMessage(
          `Could not fetch contest "${titleSlug}". Make sure the contest exists and is accessible.`
        );
        return;
      }

      const contestNumber = extractContestNumber(titleSlug);
      const folderName = `LeetCode_Contest_${contestNumber}`;
      const contestDir = path.join(workspaceRoot, folderName);

      // 4. Create contest directory
      if (!fs.existsSync(contestDir)) {
        fs.mkdirSync(contestDir, { recursive: true });
      }

      if (!contest.questions || contest.questions.length === 0) {
        vscode.window.showWarningMessage(
          `Contest "${contest.title}" found but has no questions yet. The folder "${folderName}" was created.`
        );
        return;
      }

      // 5. Create a .cpp file for each question
      const createdFiles: string[] = [];
      const sortedQuestions = [...contest.questions].sort(
        (a, b) => parseInt(a.questionId) - parseInt(b.questionId)
      );

      for (let i = 0; i < sortedQuestions.length; i++) {
        const q = sortedQuestions[i];
        const label = String.fromCharCode(65 + i); // A, B, C, D
        const filename = `${label}_${sanitizeFilename(q.title)}.cpp`;
        const filepath = path.join(contestDir, filename);

        if (!fs.existsSync(filepath)) {
          fs.writeFileSync(filepath, CPP_TEMPLATE(q.title, q.questionId));
        }
        createdFiles.push(filepath);
      }

      // 6. Open all files in VS Code
      for (const filepath of createdFiles) {
        const doc = await vscode.workspace.openTextDocument(filepath);
        await vscode.window.showTextDocument(doc, {
          preview: false,
          viewColumn: vscode.ViewColumn.Active,
        });
      }

      vscode.window.showInformationMessage(
        `Contest "${contest.title}" ready! Created ${createdFiles.length} files in "${folderName}".`
      );
    }
  );

  context.subscriptions.push(disposable);
}

export function deactivate() {}
