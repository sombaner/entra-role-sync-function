const { app } = require("@azure/functions");

const { syncUsers } = require("./roleSyncTimer");

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getDryRunSelection(dryRun) {
  return {
    trueSelected: dryRun ? "selected" : "",
    falseSelected: dryRun ? "" : "selected"
  };
}

function renderImpactedUsers(result) {
  if (!result) {
    return "";
  }

  if (result.impactedUsers.length === 0) {
    return "<p class=\"empty-state\">No user changes were required for this run.</p>";
  }

  const rows = result.impactedUsers
    .map(
      (user) => `
        <tr>
          <td>${escapeHtml(user.userPrincipalName)}</td>
          <td>${escapeHtml(user.currentExtensionAttribute2 || "(empty)")}</td>
          <td>${escapeHtml(user.newExtensionAttribute2)}</td>
          <td>${escapeHtml(user.action === "wouldUpdate" ? "Will change when dry run is off" : "Updated")}</td>
        </tr>`
    )
    .join("");

  return `
    <table>
      <thead>
        <tr>
          <th>User</th>
          <th>Current extensionAttribute2</th>
          <th>New extensionAttribute2</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderResult(result, errorMessage) {
  if (errorMessage) {
    return `<section class=\"panel error\"><h2>Run failed</h2><p>${escapeHtml(errorMessage)}</p></section>`;
  }

  if (!result) {
    return "";
  }

  const heading = result.dryRun ? "Dry run preview" : "Execution results";
  const description = result.dryRun
    ? "These users would be updated when dry run is turned off."
    : "These users were updated during the run.";

  return `
    <section class=\"panel\">
      <h2>${heading}</h2>
      <p>${description}</p>
      <div class=\"stats\">
        <div class=\"stat\"><span>Scoped users</span><strong>${result.scopedUserCount}</strong></div>
        <div class=\"stat\"><span>Target-role users</span><strong>${result.targetRoleUserCount}</strong></div>
        <div class=\"stat\"><span>Impacted users</span><strong>${result.updatedCount}</strong></div>
        <div class=\"stat\"><span>Skipped users</span><strong>${result.skippedCount}</strong></div>
      </div>
      ${renderImpactedUsers(result)}
    </section>`;
}

function renderPage(options = {}) {
  const dryRun = options.dryRun !== undefined ? options.dryRun : true;
  const selection = getDryRunSelection(dryRun);
  const resultMarkup = renderResult(options.result, options.errorMessage);

  return `<!doctype html>
  <html lang=\"en\">
    <head>
      <meta charset=\"utf-8\" />
      <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />
      <title>Duplicate User Sync</title>
      <style>
        :root {
          color-scheme: light;
          --bg: #f4efe6;
          --panel: #fffaf4;
          --ink: #1f2a2e;
          --muted: #5a666b;
          --accent: #0f6a73;
          --accent-strong: #0b4f56;
          --border: #d8ccbb;
          --error: #8a2f2b;
        }

        * {
          box-sizing: border-box;
        }

        body {
          margin: 0;
          font-family: Georgia, serif;
          background: radial-gradient(circle at top, #fffdf8 0, var(--bg) 60%);
          color: var(--ink);
        }

        main {
          max-width: 960px;
          margin: 0 auto;
          padding: 40px 20px 64px;
        }

        h1,
        h2 {
          margin: 0 0 12px;
          font-weight: 600;
        }

        p {
          color: var(--muted);
          line-height: 1.5;
        }

        .panel {
          background: var(--panel);
          border: 1px solid var(--border);
          border-radius: 18px;
          padding: 24px;
          box-shadow: 0 18px 40px rgba(31, 42, 46, 0.08);
          margin-top: 24px;
        }

        .error {
          border-color: rgba(138, 47, 43, 0.35);
        }

        form {
          display: grid;
          gap: 16px;
        }

        label {
          display: block;
          font-weight: 600;
          margin-bottom: 8px;
        }

        select,
        button {
          width: 100%;
          max-width: 320px;
          border-radius: 999px;
          border: 1px solid var(--border);
          font-size: 16px;
          padding: 12px 16px;
          background: #fff;
        }

        button {
          background: linear-gradient(135deg, var(--accent), var(--accent-strong));
          color: #fff;
          border: 0;
          cursor: pointer;
          font-weight: 700;
        }

        .stats {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
          gap: 12px;
          margin: 20px 0;
        }

        .stat {
          border: 1px solid var(--border);
          border-radius: 14px;
          padding: 14px;
          background: #fff;
        }

        .stat span {
          display: block;
          color: var(--muted);
          font-size: 13px;
          margin-bottom: 6px;
        }

        .stat strong {
          font-size: 24px;
        }

        table {
          width: 100%;
          border-collapse: collapse;
          margin-top: 20px;
          background: #fff;
          border-radius: 14px;
          overflow: hidden;
        }

        th,
        td {
          text-align: left;
          padding: 14px 12px;
          border-bottom: 1px solid var(--border);
          vertical-align: top;
        }

        th {
          font-size: 13px;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          color: var(--muted);
          background: #f6efe3;
        }

        .empty-state {
          margin: 0;
          padding: 12px 0 0;
        }
      </style>
    </head>
    <body>
      <main>
        <section class=\"panel\">
          <h1>Duplicate User Sync</h1>
          <p>Run the Entra role sync on demand from your browser. Use dry run mode to preview which users would change before applying updates.</p>
          <form method=\"post\">
            <div>
              <label for=\"dryRun\">Execution mode</label>
              <select id=\"dryRun\" name=\"dryRun\">
                <option value=\"true\" ${selection.trueSelected}>Dry run: preview impacted users</option>
                <option value=\"false\" ${selection.falseSelected}>Apply changes now</option>
              </select>
            </div>
            <button type=\"submit\">Run sync</button>
          </form>
        </section>
        ${resultMarkup}
      </main>
    </body>
  </html>`;
}

async function parseDryRun(request) {
  const body = await request.text();
  const params = new URLSearchParams(body);
  return params.get("dryRun") !== "false";
}

app.http("roleSyncDashboard", {
  route: "role-sync",
  methods: ["GET", "POST"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    if (request.method === "GET") {
      return {
        headers: {
          "content-type": "text/html; charset=utf-8"
        },
        body: renderPage()
      };
    }

    const dryRun = await parseDryRun(request);

    try {
      const result = await syncUsers(context, { dryRun });
      return {
        headers: {
          "content-type": "text/html; charset=utf-8"
        },
        body: renderPage({ dryRun, result })
      };
    } catch (error) {
      context.error("Manual role sync failed", { message: error.message, stack: error.stack, dryRun });
      return {
        status: 500,
        headers: {
          "content-type": "text/html; charset=utf-8"
        },
        body: renderPage({ dryRun, errorMessage: error.message })
      };
    }
  }
});