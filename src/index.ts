import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response } from "express";
import { z } from "zod";
import chalk from "chalk";
import { hello, echo } from "./tools.js";
import { Octokit } from "@octokit/rest";


// ============================================================================
// MCP Server Setup
// ============================================================================

const server = new McpServer({
  name: "github-issue-tracker",
  version: "1.0.0",
});

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

// 1. Tool: View Issue List
server.registerTool(
  "list_issues",
  {
    title: "List Issues",
    description: "Fetch a list of issues from a GitHub repository",
    inputSchema: {
      owner: z.string().describe("Repository owner"),
      repo: z.string().describe("Repository name"),
      state: z
        .enum(["open", "closed", "all"])
        .default("open")
        .describe("Status of issues"),
    },
  },
  async ({ owner, repo, state }) => {
    const { data: issues } = await octokit.issues.listForRepo({
      owner,
      repo,
      state,
      per_page: 10,
    });
    const list = issues
      .filter((i) => !i.pull_request)
      .map((i) => `#${i.number}: ${i.title}`)
      .join("\n");
    const output = { issues: list || "No issues found." };
    return {
      content: [{ type: "text", text: output.issues }],
      structuredContent: output,
    };
  },
);

// 2. Tool: Issue Triage
server.registerTool(
  "triage_issue",
  {
    title: "Triage Issue",
    description: "Automatically label an issue as 'bug' or 'enhancement'",
    inputSchema: {
      owner: z.string(),
      repo: z.string(),
      issue_number: z.number().describe("The issue number to triage"),
    },
  },
  async ({ owner, repo, issue_number }) => {
    const { data: issue } = await octokit.issues.get({
      owner,
      repo,
      issue_number,
    });
    const label = (issue.title + (issue.body || ""))
      .toLowerCase()
      .includes("bug")
      ? "bug"
      : "enhancement";
    await octokit.issues.addLabels({
      owner,
      repo,
      issue_number,
      labels: [label],
    });

    const output = {
      message: `Issue #${issue_number} labeled as: ${label}`,
      label,
    };
    return {
      content: [{ type: "text", text: output.message }],
      structuredContent: output,
    };
  },
);

// 3. Tool: Weekly Digest
server.registerTool(
  "weekly_digest",
  {
    title: "Weekly Digest",
    description:
      "Get a summary of repository activity from the last 7 days",
    inputSchema: {
      owner: z.string(),
      repo: z.string(),
    },
  },
  async ({ owner, repo }) => {
    const sevenDaysAgo = new Date(
      Date.now() - 7 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const { data: issues } = await octokit.issues.listForRepo({
      owner,
      repo,
      state: "all",
      since: sevenDaysAgo,
    });

    const output = {
      count: issues.length,
      summary: `Last 7 days: ${issues.length} updates in ${owner}/${repo}.`,
    };
    return {
      content: [{ type: "text", text: output.summary }],
      structuredContent: output,
    };
  },
);

// 4. Tool: Automatic Release Notes
server.registerTool(
  "release_notes",
  {
    title: "Release Notes Generator",
    description:
      "Generate markdown release notes from recently merged pull requests",
    inputSchema: {
      owner: z.string(),
      repo: z.string(),
    },
  },
  async ({ owner, repo }) => {
    const { data: prs } = await octokit.pulls.list({
      owner,
      repo,
      state: "closed",
      per_page: 10,
    });
    const notes = prs
      .filter((pr) => pr.merged_at)
      .map((pr) => `- ${pr.title} (#${pr.number}) by @${pr.user?.login}`)
      .join("\n");

    const output = { notes: notes || "No recent merged PRs found." };
    return {
      content: [
        {
          type: "text",
          text: `## Proposed Release Notes\n${output.notes}`,
        },
      ],
      structuredContent: output,
    };
  },
);

// 5. Tool: Commenting
server.registerTool(
  "add_comment",
  {
    title: "Add Comment",
    description: "Post a comment on a GitHub issue or pull request",
    inputSchema: {
      owner: z.string(),
      repo: z.string(),
      issue_number: z.number(),
      body: z.string().describe("The text of the comment"),
    },
  },
  async ({ owner, repo, issue_number, body }) => {
    await octokit.issues.createComment({ owner, repo, issue_number, body });
    const output = {
      status: "success",
      message: `Comment added to #${issue_number}`,
    };
    return {
      content: [{ type: "text", text: output.message }],
      structuredContent: output,
    };
  },
);

// ============================================================================
// Express App Setup
// ============================================================================

const app = express();
app.use(express.json());

// Health check endpoint (required for Cloud Run)
app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "healthy" });
});

// MCP endpoint with dev logging
app.post("/mcp", async (req: Request, res: Response) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on("close", () => {
    transport.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// JSON error handler (Express defaults to HTML errors)
app.use((_err: unknown, _req: Request, res: Response, _next: Function) => {
  res.status(500).json({ error: "Internal server error" });
});

// ============================================================================
// Start Server
// ============================================================================

const port = parseInt(process.env.PORT || "8080");
const httpServer = app.listen(port, () => {
  console.log();
  console.log(chalk.bold("MCP Server running on"), chalk.cyan(`http://localhost:${port}`));
  console.log(`  ${chalk.gray("Health:")} http://localhost:${port}/health`);
  console.log(`  ${chalk.gray("MCP:")}    http://localhost:${port}/mcp`);

});

// Graceful shutdown for Cloud Run (SIGTERM before kill)
process.on("SIGTERM", () => {
  console.log("Received SIGTERM, shutting down...");
  httpServer.close(() => {
    process.exit(0);
  });
});
