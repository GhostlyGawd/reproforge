type WidgetToolResult = {
  _meta?: Record<string, unknown>;
  content?: unknown[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

export function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function createReproForgeWidgetHtml(
  initialResult: WidgetToolResult | null = null,
): string {
  const initialJson = safeJsonForScript(initialResult);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>ReproForge proof</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f7f7f5;
      --card: rgba(255, 255, 255, 0.96);
      --ink: #171717;
      --muted: #64645f;
      --line: #deded8;
      --soft: #f0f0ec;
      --accent: #167a53;
      --accent-soft: #e6f5ee;
      --accent-ink: #095d3c;
      --warning: #a15c12;
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      --sans: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #171817;
        --card: rgba(33, 35, 33, 0.98);
        --ink: #f3f4ef;
        --muted: #acafa8;
        --line: #3d403b;
        --soft: #292c28;
        --accent: #6dd7aa;
        --accent-soft: #153c2c;
        --accent-ink: #9ae7c4;
        --warning: #f1b56f;
      }
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-width: 0; background: transparent; color: var(--ink); font-family: var(--sans); }
    body { padding: 10px; }
    button { font: inherit; }
    .shell {
      width: min(100%, 760px);
      margin: 0 auto;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 18px;
      background: var(--card);
      box-shadow: 0 16px 44px rgba(24, 32, 27, 0.08);
    }
    .topline { height: 4px; background: linear-gradient(90deg, #167a53, #62c69d 62%, #c9f0de); }
    .content { padding: clamp(16px, 4vw, 28px); }
    .brand-row, .title-row, .actions, .section-heading, .run-row, .hypothesis-row {
      display: flex;
      align-items: center;
    }
    .brand-row { justify-content: space-between; gap: 12px; margin-bottom: 22px; }
    .brand { display: flex; align-items: center; gap: 9px; font-size: 13px; font-weight: 760; letter-spacing: .01em; }
    .mark { display: grid; grid-template-columns: repeat(2, 6px); gap: 2px; padding: 6px; border-radius: 8px; background: var(--ink); }
    .mark i { width: 6px; height: 6px; border-radius: 2px; background: var(--card); }
    .eyebrow { color: var(--muted); font-family: var(--mono); font-size: 11px; }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      border: 1px solid color-mix(in srgb, var(--accent) 32%, transparent);
      border-radius: 999px;
      padding: 6px 10px;
      background: var(--accent-soft);
      color: var(--accent-ink);
      font-size: 11px;
      font-weight: 760;
      letter-spacing: .07em;
      text-transform: uppercase;
    }
    .status::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 16%, transparent); }
    .title-row { align-items: flex-start; justify-content: space-between; gap: 16px; }
    h1 { margin: 0; font-size: clamp(22px, 5vw, 32px); line-height: 1.06; letter-spacing: -.035em; }
    .case-id { margin: 8px 0 0; color: var(--muted); font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; }
    .proof-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 9px; margin: 22px 0; }
    .metric { min-width: 0; padding: 13px; border: 1px solid var(--line); border-radius: 12px; background: var(--soft); }
    .metric strong { display: block; font-size: clamp(15px, 3.5vw, 20px); line-height: 1.15; letter-spacing: -.02em; }
    .metric span { display: block; margin-top: 5px; color: var(--muted); font-size: 11px; line-height: 1.3; }
    .section { padding: 18px 0; border-top: 1px solid var(--line); }
    .section-heading { justify-content: space-between; gap: 10px; margin-bottom: 11px; }
    h2 { margin: 0; font-size: 13px; letter-spacing: .01em; }
    .count { color: var(--muted); font-family: var(--mono); font-size: 11px; }
    .evidence-lanes { display: grid; grid-template-columns: repeat(4, 1fr); gap: 7px; }
    .lane { padding: 9px; border-radius: 10px; background: var(--soft); }
    .lane b { display: block; font-size: 16px; }
    .lane span { color: var(--muted); font-size: 10px; text-transform: capitalize; }
    .hypothesis-list, .run-list, .file-list { display: grid; gap: 7px; margin: 0; padding: 0; list-style: none; }
    .hypothesis-row { align-items: flex-start; gap: 10px; padding: 10px 11px; border: 1px solid var(--line); border-radius: 10px; }
    .priority { flex: 0 0 auto; width: 23px; height: 23px; display: grid; place-items: center; border-radius: 7px; background: var(--soft); color: var(--muted); font-family: var(--mono); font-size: 10px; }
    .hypothesis-copy { min-width: 0; flex: 1; }
    .hypothesis-copy p { margin: 0; font-size: 12px; line-height: 1.45; }
    .hypothesis-copy span { display: block; margin-top: 4px; color: var(--accent-ink); font-size: 10px; font-weight: 700; text-transform: uppercase; }
    .run-row { justify-content: space-between; gap: 10px; padding: 8px 10px; border-radius: 9px; background: var(--soft); font-family: var(--mono); font-size: 11px; }
    .run-id { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .run-role { color: var(--muted); }
    .exit { color: var(--accent-ink); font-weight: 750; }
    .file-list { display: flex; flex-wrap: wrap; gap: 6px; }
    .file { max-width: 100%; overflow-wrap: anywhere; padding: 6px 8px; border: 1px solid var(--line); border-radius: 8px; color: var(--muted); font-family: var(--mono); font-size: 10px; }
    .reason { margin: 11px 0 0; color: var(--muted); font-size: 11px; line-height: 1.5; }
    .actions { flex-wrap: wrap; gap: 8px; padding-top: 18px; border-top: 1px solid var(--line); }
    .button { min-height: 40px; border: 1px solid var(--line); border-radius: 10px; padding: 9px 13px; background: var(--card); color: var(--ink); cursor: pointer; font-weight: 680; }
    .button.primary { border-color: var(--ink); background: var(--ink); color: var(--card); }
    .button:hover { transform: translateY(-1px); }
    .button:disabled { cursor: wait; opacity: .58; transform: none; }
    .button:focus-visible { outline: 3px solid color-mix(in srgb, var(--accent) 62%, transparent); outline-offset: 2px; }
    .action-status { flex: 1 1 180px; min-height: 18px; margin: 0; color: var(--muted); font-size: 11px; text-align: right; }
    .empty { color: var(--muted); font-size: 12px; }
    @media (max-width: 520px) {
      body { padding: 4px; }
      .shell { border-radius: 14px; }
      .brand-row { margin-bottom: 17px; }
      .title-row { display: block; }
      .title-row .status { margin-top: 13px; }
      .proof-grid { grid-template-columns: 1fr; }
      .metric { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
      .metric span { margin-top: 0; text-align: right; }
      .evidence-lanes { grid-template-columns: repeat(2, 1fr); }
      .button { flex: 1 1 130px; }
      .action-status { flex-basis: 100%; text-align: left; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; animation: none !important; }
    }
  </style>
</head>
<body>
  <main class="shell" aria-labelledby="proof-title">
    <div class="topline" aria-hidden="true"></div>
    <div class="content">
      <div class="brand-row">
        <div class="brand"><span class="mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span>ReproForge</div>
        <span class="eyebrow">proof, not a guess</span>
      </div>
      <div class="title-row">
        <div>
          <h1 id="proof-title">Reproduction case</h1>
          <p class="case-id" id="case-id">case / waiting for tool result</p>
        </div>
        <span class="status" id="status">Waiting</span>
      </div>
      <section class="proof-grid" aria-label="Verification proof">
        <div class="metric"><strong id="repeatability">—</strong><span>repeatability</span></div>
        <div class="metric"><strong id="candidate-runs">—</strong><span>candidate runs</span></div>
        <div class="metric"><strong id="control">—</strong><span>negative control</span></div>
      </section>
      <section class="section" aria-labelledby="evidence-heading">
        <div class="section-heading"><h2 id="evidence-heading">Evidence lanes</h2><span class="count" id="evidence-total">0 items</span></div>
        <div class="evidence-lanes" id="evidence-lanes"></div>
      </section>
      <section class="section" aria-labelledby="hypotheses-heading">
        <div class="section-heading"><h2 id="hypotheses-heading">Hypothesis ledger</h2><span class="count" id="hypothesis-count">0 hypotheses</span></div>
        <ol class="hypothesis-list" id="hypotheses"></ol>
      </section>
      <section class="section" aria-labelledby="runs-heading">
        <div class="section-heading"><h2 id="runs-heading">Clean-room runs</h2><span class="count" id="run-count">0 runs</span></div>
        <div class="run-list" id="runs"></div>
      </section>
      <section class="section" aria-labelledby="bundle-heading">
        <div class="section-heading"><h2 id="bundle-heading">Portable Repro Bundle</h2><span class="count" id="bundle-state">not ready</span></div>
        <div class="file-list" id="files"></div>
        <p class="reason" id="reason"></p>
      </section>
      <div class="actions">
        <button class="button" id="refresh" type="button">Refresh proof</button>
        <button class="button primary" id="export" type="button">Export bundle</button>
        <p class="action-status" id="action-status" role="status" aria-live="polite"></p>
      </div>
    </div>
  </main>
  <script>
    (() => {
      "use strict";
      const INITIAL_RESULT = ${initialJson};
      const PROTOCOL_VERSION = "2026-01-26";
      const pending = new Map();
      let nextId = 1;
      let currentResult = null;
      let hostContext = null;

      const byId = (id) => document.getElementById(id);
      const setText = (id, value) => { byId(id).textContent = String(value); };
      const clear = (element) => { while (element.firstChild) element.removeChild(element.firstChild); };
      const plural = (count, word) => count + " " + word + (count === 1 ? "" : "s");
      const resultMeta = (result) => {
        const root = result && result._meta && result._meta.reproforge;
        return root && typeof root === "object" ? root : {};
      };

      function render(result) {
        if (!result || typeof result !== "object") return;
        if (result.isError) {
          setText("action-status", "ReproForge could not complete that action.");
          return;
        }
        const view = result.structuredContent;
        if (!view || view.kind !== "reproduction") return;
        currentResult = result;
        const meta = resultMeta(result);
        const proof = view.proof || {};
        const progress = view.progress || {};
        const status = proof.status || progress.phase || view.caseState || "Waiting";
        setText("proof-title", status === "VERIFIED" ? "Verified reproduction" : "Reproduction case");
        setText("status", status);
        setText("case-id", "case / " + view.caseId);
        setText("repeatability", Math.round((proof.repeatability || 0) * 100) + "% repeatable");
        setText("candidate-runs", (proof.candidateMatches || 0) + " / " + (proof.requiredRuns || 0) + " matched");
        setText("control", proof.controlMatched ? "Control matched" : "Control clear");
        setText(
          "action-status",
          progress.terminal
            ? "Durable job " + (progress.state || view.jobState || "complete").toLowerCase() + "."
            : (progress.phase || "Queued") + " phase · attempt " + (progress.attempt || 0) + "."
        );

        const counts = view.evidenceCounts || {};
        const lanes = byId("evidence-lanes");
        clear(lanes);
        let evidenceTotal = 0;
        ["reported", "observed", "inferred", "unknown"].forEach((classification) => {
          const count = Number(counts[classification] || 0);
          evidenceTotal += count;
          const lane = document.createElement("div");
          lane.className = "lane";
          const strong = document.createElement("b");
          strong.textContent = String(count);
          const label = document.createElement("span");
          label.textContent = classification;
          lane.append(strong, label);
          lanes.append(lane);
        });
        setText("evidence-total", plural(evidenceTotal, "item"));

        const hypotheses = Array.isArray(view.hypotheses) ? view.hypotheses : [];
        const hypothesisList = byId("hypotheses");
        clear(hypothesisList);
        hypotheses.forEach((hypothesis) => {
          const row = document.createElement("li");
          row.className = "hypothesis-row";
          const priority = document.createElement("span");
          priority.className = "priority";
          priority.textContent = "P" + hypothesis.priority;
          const copy = document.createElement("div");
          copy.className = "hypothesis-copy";
          const statement = document.createElement("p");
          statement.textContent = hypothesis.statement;
          const hypothesisStatus = document.createElement("span");
          hypothesisStatus.textContent = hypothesis.status;
          copy.append(statement, hypothesisStatus);
          row.append(priority, copy);
          hypothesisList.append(row);
        });
        if (hypotheses.length === 0) {
          const empty = document.createElement("li");
          empty.className = "empty";
          empty.textContent = "Hypotheses appear after inspection.";
          hypothesisList.append(empty);
        }
        setText("hypothesis-count", plural(hypotheses.length, "hypothesis"));

        const runs = Array.isArray(view.runs) ? view.runs : [];
        const runList = byId("runs");
        clear(runList);
        runs.forEach((run) => {
          const row = document.createElement("div");
          row.className = "run-row";
          const id = document.createElement("span");
          id.className = "run-id";
          id.textContent = run.id;
          const role = document.createElement("span");
          role.className = "run-role";
          role.textContent = run.role;
          const exit = document.createElement("span");
          exit.className = "exit";
          exit.textContent = "exit " + run.exitCode;
          row.append(id, role, exit);
          runList.append(row);
        });
        setText("run-count", plural(runs.length, "run"));

        const fileNames = Array.isArray(meta.bundleFileNames) ? meta.bundleFileNames : [];
        const files = byId("files");
        clear(files);
        fileNames.forEach((fileName) => {
          const file = document.createElement("span");
          file.className = "file";
          file.textContent = fileName;
          files.append(file);
        });
        if (fileNames.length === 0) {
          const empty = document.createElement("span");
          empty.className = "empty";
          empty.textContent = "Bundle files appear after verification.";
          files.append(empty);
        }
        setText("bundle-state", proof.bundleReady ? "ready · SHA-256" : "not ready");
        setText("reason", meta.reason || "Awaiting machine-checked verification evidence.");
        byId("export").disabled = !proof.bundleReady;
      }

      function post(message) {
        window.parent.postMessage(message, "*");
      }

      function rpc(method, params) {
        const id = nextId++;
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          post({ jsonrpc: "2.0", id, method, params });
        });
      }

      function notify(method, params) {
        post({ jsonrpc: "2.0", method, params });
      }

      function setBusy(isBusy, message) {
        byId("refresh").disabled = isBusy;
        byId("export").disabled = isBusy || !(currentResult && currentResult.structuredContent && currentResult.structuredContent.proof.bundleReady);
        setText("action-status", message || "");
      }

      function utf8Base64(text) {
        const bytes = new TextEncoder().encode(text);
        let binary = "";
        bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
        return btoa(binary);
      }

      async function offerDownload(files, caseId) {
        const payload = JSON.stringify({ caseId, files, schemaVersion: "2.0" }, null, 2);
        const fileName = "reproforge-" + caseId + ".json";
        if (hostContext && hostContext.hostCapabilities && hostContext.hostCapabilities.downloadFile) {
          await rpc("ui/download-file", {
            contents: [{
              type: "resource",
              resource: {
                uri: "reproforge://bundle/" + fileName,
                mimeType: "application/json",
                blob: utf8Base64(payload)
              }
            }]
          });
          return;
        }
        const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = fileName;
        anchor.click();
        URL.revokeObjectURL(url);
      }

      byId("refresh").addEventListener("click", async () => {
        const view = currentResult && currentResult.structuredContent;
        if (!view) return setText("action-status", "Run start_reproduction in ChatGPT first.");
        if (window.parent === window) return setText("action-status", "Preview uses a fixed verified fixture.");
        try {
          setBusy(true, "Refreshing machine evidence…");
          const result = await rpc("tools/call", { name: "get_reproduction", arguments: { caseId: view.caseId } });
          render(result);
          setBusy(false, "Proof refreshed.");
        } catch {
          setBusy(false, "Refresh failed safely.");
        }
      });

      byId("export").addEventListener("click", async () => {
        const view = currentResult && currentResult.structuredContent;
        if (!view) return;
        try {
          setBusy(true, "Preparing content-addressed bundle…");
          if (window.parent === window) {
            const previewFiles = resultMeta(currentResult).files || {};
            await offerDownload(previewFiles, view.caseId);
          } else {
            const exported = await rpc("tools/call", { name: "export_repro_bundle", arguments: { caseId: view.caseId } });
            if (exported.isError) throw new Error("export failed");
            await offerDownload(resultMeta(exported).files || {}, view.caseId);
          }
          setBusy(false, "Bundle ready to download.");
        } catch {
          setBusy(false, "Export failed safely.");
        }
      });

      window.addEventListener("message", (event) => {
        if (event.source !== window.parent || !event.data || event.data.jsonrpc !== "2.0") return;
        const message = event.data;
        if (Object.prototype.hasOwnProperty.call(message, "id") && pending.has(message.id)) {
          const request = pending.get(message.id);
          pending.delete(message.id);
          if (message.error) request.reject(message.error);
          else request.resolve(message.result);
          return;
        }
        if (message.method === "ui/notifications/tool-result") render(message.params);
        if (message.method === "ui/notifications/host-context-changed") {
          hostContext = { ...(hostContext || {}), hostContext: message.params };
        }
      });

      if (INITIAL_RESULT) render(INITIAL_RESULT);
      if (window.parent !== window) {
        rpc("ui/initialize", {
          appCapabilities: {},
          appInfo: { name: "reproforge-proof", version: "0.2.0" },
          protocolVersion: PROTOCOL_VERSION
        }).then((result) => {
          hostContext = result;
          notify("ui/notifications/initialized");
        }).catch(() => setText("action-status", "The ChatGPT host handshake failed safely."));
      }
    })();
  </script>
</body>
</html>`;
}
