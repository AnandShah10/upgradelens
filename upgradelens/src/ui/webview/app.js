// Client-side script for the UpgradeLens impact report webview.
// Runs inside the webview sandbox only - no Node/VS Code API access except
// through the injected `vscode` object (acquireVsCodeApi()).
(function () {
  const vscode = acquireVsCodeApi();
  /** @type {any} */
  const report = window.__UPGRADELENS_REPORT__;

  const root = document.getElementById("root");

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function riskLabel(level) {
    return level.toUpperCase();
  }

  function certaintyLabel(certainty) {
    switch (certainty) {
      case "confirmed":
        return "Confirmed";
      case "likely":
        return "Likely";
      case "potential":
        return "Potential";
      default:
        return "Unknown";
    }
  }

  function openFile(filePath, line, column) {
    vscode.postMessage({ type: "open-file", filePath, line: line || 1, column: column || 1 });
  }

  function renderHeader() {
    return `
      <div class="header">
        <div>
          <p class="title">UpgradeLens · Dependency Impact Simulator</p>
          <p class="package-line">${escapeHtml(report.packageName)}</p>
          <p class="version-line">${escapeHtml(report.fromVersion)} → ${escapeHtml(report.toVersion)} · ${escapeHtml(report.versionChangeKind)} change</p>
        </div>
        <span class="risk-badge risk-${report.risk.level}">${riskLabel(report.risk.level)} RISK</span>
      </div>
    `;
  }

  function renderBanners() {
    if (!report.degraded && !report.offline) return "";
    const reasons = report.degradedReasons.map((r) => `<div>${escapeHtml(r)}</div>`).join("");
    return `<div class="banner"><strong>${report.offline ? "Offline analysis" : "Partial analysis"}</strong><div style="margin-top:4px">${reasons}</div></div>`;
  }

  function renderSummary() {
    const s = report.summary;
    const cards = [
      { value: s.affectedFileCount, label: "Affected Files" },
      { value: s.breakingChangeCount, label: "Breaking Changes" },
      { value: s.deprecatedUsageCount, label: "Deprecated Usages" },
      { value: s.peerDependencyIssueCount, label: "Peer Dependency Issues" },
    ];
    return `<div class="summary-cards">${cards
      .map((c) => `<div class="card"><div class="value">${c.value}</div><div class="label">${c.label}</div></div>`)
      .join("")}</div>`;
  }

  function renderImpactOverview() {
    const pct = report.risk.score;
    const reasons = report.risk.reasons
      .filter((r) => r.weight > 0)
      .map((r) => `<li>${escapeHtml(r.label)}</li>`)
      .join("");
    return `
      <div class="section-title">Impact Overview</div>
      <div class="impact-bar-track"><div class="impact-bar-fill risk-${report.risk.level}" style="width:${pct}%"></div></div>
      <div style="font-size:12.5px;color:var(--vscode-descriptionForeground);margin-bottom:8px;">
        ${report.summary.affectedFileCount} file${report.summary.affectedFileCount === 1 ? "" : "s"} potentially affected · risk score ${pct}/100
      </div>
      ${reasons ? `<ul class="risk-reasons">${reasons}</ul>` : ""}
    `;
  }

  function renderFindings() {
    if (report.findings.length === 0) {
      return `<div class="section-title">Findings</div><div class="empty-state">No direct breaking changes were detected in the APIs this project uses. This does not guarantee runtime compatibility.</div>`;
    }
    const items = report.findings
      .slice()
      .sort((a, b) => sevRank(b.severity) - sevRank(a.severity))
      .map((f, i) => {
        const loc = f.filePath
          ? `<div class="finding-location"><span class="link" data-open-file="${escapeHtml(f.filePath)}" data-line="${f.line || 1}" data-column="${f.column || 1}">${escapeHtml(f.filePath)}:${f.line || 1}</span></div>`
          : "";
        return `
        <div class="finding sev-${f.severity}" data-index="${i}">
          <div class="finding-head" data-toggle="${i}">
            <span class="chevron">▶</span>
            <span>${escapeHtml(f.title)}</span>
            <span class="badge">${escapeHtml(f.severity)}</span>
            <span class="badge">${escapeHtml(certaintyLabel(f.certainty))}</span>
          </div>
          ${loc}
          <div class="finding-body">
            <div>${escapeHtml(f.description)}</div>
            ${f.recommendation ? `<div class="recommendation"><strong>Recommendation:</strong> ${escapeHtml(f.recommendation)}</div>` : ""}
            <div class="confidence">Confidence: ${Math.round(f.confidence * 100)}%</div>
            ${f.sourceUrl ? `<div class="confidence"><a href="${escapeHtml(f.sourceUrl)}" target="_blank" rel="noopener">View source release</a></div>` : ""}
          </div>
        </div>
      `;
      })
      .join("");
    return `<div class="section-title">Findings (${report.findings.length})</div>${items}`;
  }

  function sevRank(sev) {
    return { critical: 4, high: 3, medium: 2, low: 1, info: 0 }[sev] ?? 0;
  }

  function renderAffectedFiles() {
    if (report.affectedFiles.length === 0) return "";
    const rows = report.affectedFiles
      .map(
        (f) => `
      <div class="file-row">
        <span class="path link" data-open-file="${escapeHtml(f.filePath)}" data-line="1" data-column="1">${escapeHtml(f.filePath)}</span>
        <span class="badge">${escapeHtml(f.severity)}</span>
      </div>`
      )
      .join("");
    return `<div class="section-title">Affected Files</div>${rows}`;
  }

  function renderChecklist() {
    if (report.migrationChecklist.length === 0) return "";
    const items = report.migrationChecklist.map((line) => `<li><input type="checkbox" />${escapeHtml(line)}</li>`).join("");
    return `
      <div class="section-title">Migration Checklist</div>
      <ul class="checklist">${items}</ul>
      <div class="toolbar">
        <button class="vscode-button secondary" id="copy-checklist">Copy checklist</button>
        <button class="vscode-button secondary" id="refresh-analysis">Refresh analysis</button>
      </div>
    `;
  }

  function render() {
    root.innerHTML = `
      ${renderHeader()}
      ${renderBanners()}
      ${renderSummary()}
      ${renderImpactOverview()}
      ${renderFindings()}
      ${renderAffectedFiles()}
      ${renderChecklist()}
      <div class="footer-note">Generated ${new Date(report.generatedAt).toLocaleString()} in ${(report.durationMs / 1000).toFixed(1)}s · Read-only simulation, no files were modified.</div>
    `;

    root.querySelectorAll("[data-open-file]").forEach((el) => {
      el.addEventListener("click", () => {
        openFile(el.getAttribute("data-open-file"), Number(el.getAttribute("data-line")), Number(el.getAttribute("data-column")));
      });
    });

    root.querySelectorAll("[data-toggle]").forEach((el) => {
      el.addEventListener("click", () => {
        el.closest(".finding").classList.toggle("open");
      });
    });

    const copyBtn = document.getElementById("copy-checklist");
    if (copyBtn) {
      copyBtn.addEventListener("click", () => {
        vscode.postMessage({ type: "copy-checklist", text: report.migrationChecklist.map((l) => `- ${l}`).join("\n") });
      });
    }

    const refreshBtn = document.getElementById("refresh-analysis");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", () => {
        vscode.postMessage({ type: "refresh" });
      });
    }
  }

  render();
})();
