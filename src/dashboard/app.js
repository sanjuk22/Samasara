(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const state = {
    view: "status",
    statusBusy: false,
    statusLoaded: false,
    telemetryBusy: false,
    telemetryLoaded: false,
    pages: [null],
    nextBefore: null,
    selectedId: null,
    detail: null,
    detailRequest: 0,
    detailInFlight: null,
    config: null,
    reposBusy: false,
    mutating: false,
    editorRepo: null,
    editorRevision: null,
    editorBaseline: { repo: "", patterns: "" },
    deleteTarget: null,
    csrf: null,
    csrfRequest: null,
    canEdit: false,
  };
  const statusCards = new Map();
  const sessionCards = new Map();
  const dateFormat = new Intl.DateTimeFormat(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short",
  });
  const numberFormat = new Intl.NumberFormat();
  const tones = {
    green: "positive", landed: "positive", red: "negative", gave_up: "negative",
    reverted: "negative", denied_policy: "negative", error: "negative",
    running: "info", pending: "warning", follow_up: "warning", head_moved: "warning",
  };

  function text(node, value) {
    const next = value == null ? "" : String(value);
    if (node.textContent !== next) node.textContent = next;
  }

  function el(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value != null) text(node, value);
    return node;
  }

  function notice(id, message = "", kind = "") {
    const node = $(id);
    text(node, message);
    node.className = `notice ${kind}`.trim();
    node.hidden = !message;
  }

  function timestamp(value) {
    if (value == null) return "Not recorded";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Unknown timestamp" : dateFormat.format(date);
  }

  function count(value) {
    if (value == null) return "—";
    const parsed = Number(value);
    return Number.isFinite(parsed) ? numberFormat.format(parsed) : "—";
  }

  function duration(value) {
    if (value == null) return "In progress";
    const milliseconds = Number(value);
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return "Not recorded";
    const totalSeconds = Math.floor(milliseconds / 1000);
    if (totalSeconds < 60) return `${totalSeconds}s`;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (totalMinutes < 60) return `${totalMinutes}m ${seconds}s`;
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours}h ${minutes}m`;
  }

  function outcome(node, value) {
    text(node, value ? String(value).replaceAll("_", " ") : "Not recorded");
    node.dataset.tone = tones[value] || "neutral";
  }

  function repoPath(repo) {
    const [owner, name] = repo.split("/");
    return `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  }

  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }

  async function api(path, options = {}) {
    let response;
    try {
      response = await fetch(path, {
        credentials: "same-origin",
        cache: "no-store",
        ...options,
        headers: { Accept: "application/json", ...options.headers },
      });
    } catch {
      throw new ApiError("Cannot reach the dashboard server. Check your connection and refresh.", 0);
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new ApiError(`The server returned an unreadable response (HTTP ${response.status}).`, response.status);
    }
    if (!response.ok) {
      throw new ApiError(typeof data.error === "string" ? data.error : `Request failed (HTTP ${response.status}).`, response.status);
    }
    return data;
  }

  async function csrfToken() {
    if (state.csrf) return state.csrf;
    if (!state.csrfRequest) {
      state.csrfRequest = api("/api/csrf").then((data) => {
        state.csrf = data.token;
        return data.token;
      }).finally(() => { state.csrfRequest = null; });
    }
    return state.csrfRequest;
  }

  function activateView(view, focusTab = false) {
    state.view = view;
    for (const tab of tabs) {
      const selected = tab.dataset.view === view;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      $(`view-${tab.dataset.view}`).hidden = !selected;
      if (selected && focusTab) tab.focus();
    }
  }

  function makeFact(list, label) {
    const row = el("div");
    const value = el("dd");
    row.append(el("dt", "", label), value);
    list.append(row);
    return value;
  }

  function createStatusCard(repo) {
    const card = el("article", "card repo-status-card");
    const top = el("div", "repo-status-title");
    const badge = el("span", "badge");
    top.append(el("h3", "", repo), badge);
    const facts = el("dl", "facts");
    const pollAt = makeFact(facts, "Last polled");
    const sha = el("code");
    makeFact(facts, "Polled commit").append(sha);
    const bottom = el("div", "status-session");
    const sessionButton = el("button", "link-button", "No session recorded");
    sessionButton.type = "button";
    sessionButton.addEventListener("click", () => {
      activateView("telemetry");
      selectSession(Number(sessionButton.dataset.sessionId));
    });
    const sessionOutcome = el("span", "badge");
    const sessionTimes = el("p");
    bottom.append(sessionButton, sessionOutcome, sessionTimes);
    card.append(top, facts, bottom);
    return { card, badge, pollAt, sha, sessionButton, sessionOutcome, sessionTimes };
  }

  async function refreshStatus(quiet = false) {
    if (state.statusBusy) return;
    state.statusBusy = true;
    if (!quiet) notice("status-notice", "Loading system status…");
    try {
      const data = await api("/api/status");
      const daemon = data.daemon;
      text($("daemon-state"), daemon.running ? "Running" : "Stopped");
      $("daemon-state").dataset.tone = daemon.running ? "positive" : "negative";
      let description = daemon.running
        ? `Process ${daemon.pid ?? "unknown"} is alive. This does not guarantee a successful poll.`
        : "No live daemon process was detected. Poll results below are historical.";
      if (daemon.staleLockPid != null) description += ` Stale lock recorded for process ${daemon.staleLockPid}.`;
      text($("daemon-description"), description);
      text($("poll-interval"), `${data.pollIntervalSeconds} seconds`);
      text($("repo-count"), data.repos.length);
      text($("poll-history"), data.hasPolls ? "Historical poll records are available." : "No polls have been recorded yet.");
      applyEditAccess(data.canEdit === true);
      const present = new Set();
      for (const repo of data.repos) {
        present.add(repo.repo);
        let nodes = statusCards.get(repo.repo);
        if (!nodes) {
          nodes = createStatusCard(repo.repo);
          statusCards.set(repo.repo, nodes);
          $("status-repos").append(nodes.card);
        }
        outcome(nodes.badge, repo.poll?.result || "Not polled");
        text(nodes.pollAt, repo.poll ? timestamp(repo.poll.at) : "No poll recorded");
        text(nodes.sha, repo.poll?.sha ? repo.poll.sha.slice(0, 12) : "—");
        nodes.sha.title = repo.poll?.sha || "No commit recorded";
        nodes.sessionButton.disabled = !repo.session;
        text(nodes.sessionButton, repo.session ? `Session #${repo.session.id}` : "No session recorded");
        nodes.sessionButton.dataset.sessionId = repo.session ? String(repo.session.id) : "";
        nodes.sessionOutcome.hidden = !repo.session;
        if (repo.session) outcome(nodes.sessionOutcome, repo.session.outcome || "running");
        text(nodes.sessionTimes, repo.session
          ? `Started ${timestamp(repo.session.started_at)} · ${repo.session.ended_at == null ? "No end recorded" : `Ended ${timestamp(repo.session.ended_at)}`}`
          : "Healing sessions will appear here when recorded.");
      }
      for (const [repo, nodes] of statusCards) {
        if (!present.has(repo)) {
          nodes.card.remove();
          statusCards.delete(repo);
        }
      }
      $("status-empty").hidden = data.repos.length !== 0;
      text($("status-updated"), `Liveness checked ${timestamp(Date.now())}`);
      state.statusLoaded = true;
      notice("status-notice");
    } catch (error) {
      notice("status-notice", `${error.message}${state.statusLoaded ? " Displayed status is from the last successful refresh, not current liveness." : ""}`, "error");
    } finally {
      state.statusBusy = false;
    }
  }

  function updatePagination() {
    $("sessions-latest").disabled = state.telemetryBusy || state.pages.length === 1;
    $("sessions-newer").disabled = state.telemetryBusy || state.pages.length === 1;
    $("sessions-older").disabled = state.telemetryBusy || state.nextBefore == null;
    text($("telemetry-page"), state.pages.length === 1 ? "Latest" : `Page ${state.pages.length} · paused`);
  }

  function markSelectedSession() {
    for (const [id, nodes] of sessionCards) {
      nodes.button.setAttribute("aria-pressed", String(id === state.selectedId));
    }
  }

  function renderSessions(sessions) {
    const present = new Set();
    let position = $("session-list").firstElementChild;
    for (const session of sessions) {
      present.add(session.sessionId);
      let nodes = sessionCards.get(session.sessionId);
      if (!nodes) {
        const item = el("li");
        const button = el("button", "session-button");
        button.type = "button";
        button.setAttribute("aria-controls", "session-detail");
        button.addEventListener("click", () => selectSession(session.sessionId));
        const name = el("span", "session-name");
        const meta = el("span", "session-meta");
        const badge = el("span", "badge");
        const time = el("span", "session-time");
        button.append(name, meta, badge, time);
        item.append(button);
        nodes = { item, button, name, meta, badge, time };
        sessionCards.set(session.sessionId, nodes);
      }
      text(nodes.name, session.repo);
      text(nodes.meta, `#${session.sessionId} · ${session.sha ? session.sha.slice(0, 10) : "No commit"}`);
      outcome(nodes.badge, session.outcome);
      text(nodes.time, timestamp(session.startedAt));
      if (nodes.item !== position) $("session-list").insertBefore(nodes.item, position);
      position = nodes.item.nextElementSibling;
    }
    for (const [id, nodes] of sessionCards) {
      if (!present.has(id)) {
        nodes.item.remove();
        sessionCards.delete(id);
      }
    }
    markSelectedSession();
    $("telemetry-empty").hidden = sessions.length !== 0;
    text($("telemetry-empty"), state.pages.length === 1
      ? "No healing sessions have been recorded yet. Sessions appear when the daemon attempts a repair."
      : "No older sessions on this page. Use Newer or Latest to return.");
  }

  function renderTelemetryTotals(totals) {
    const values = totals || {};
    text($("telemetry-total-attempts"), count(values.attempts));
    text($("telemetry-total-input-tokens"), count(values.tokensIn));
    text($("telemetry-total-output-tokens"), count(values.tokensOut));
    text($("telemetry-total-duration"), duration(values.durationMs));
  }

  async function loadTelemetry(pages = state.pages, quiet = false) {
    if (state.telemetryBusy) return;
    if (quiet && $("session-list").contains(document.activeElement)) return;
    state.telemetryBusy = true;
    updatePagination();
    if (!quiet) notice("telemetry-notice", "Loading sessions…");
    try {
      const before = pages[pages.length - 1];
      const data = await api(`/api/telemetry${before == null ? "" : `?before=${encodeURIComponent(before)}`}`);
      renderTelemetryTotals(data.totals);
      state.pages = [...pages];
      state.nextBefore = data.nextBefore;
      renderSessions(data.sessions);
      state.telemetryLoaded = true;
      text($("telemetry-updated"), `List updated ${timestamp(Date.now())}`);
      notice("telemetry-notice");
    } catch (error) {
      notice("telemetry-notice", `${error.message}${state.telemetryLoaded ? " The previously loaded page is still shown." : ""}`, "error");
    } finally {
      state.telemetryBusy = false;
      updatePagination();
    }
  }

  function selectSession(id) {
    if (!Number.isSafeInteger(id) || id < 1) return;
    if (state.selectedId !== id) {
      state.selectedId = id;
      state.detail = null;
      $("detail-content").hidden = true;
      text($("detail-heading"), `Session #${id}`);
      $("detail-empty").hidden = true;
    }
    $("detail-refresh").hidden = false;
    markSelectedSession();
    $("detail-heading").focus({ preventScroll: true });
    $("session-detail").scrollIntoView({ block: "nearest" });
    void loadDetail();
  }

  function renderDetail(report) {
    text($("detail-repo"), report.repo);
    outcome($("detail-outcome"), report.outcome);
    text($("detail-sha"), report.sha || "Not recorded");
    text($("detail-started"), timestamp(report.startedAt));
    text($("detail-ended"), report.endedAt == null ? "No end recorded" : timestamp(report.endedAt));
    text($("detail-attempts"), count(report.attempts));
    text($("detail-input-tokens"), count(report.tokensIn));
    text($("detail-output-tokens"), count(report.tokensOut));
    text($("detail-duration"), duration(report.durationMs));
    text($("detail-accepted"), report.accepted);
    text($("detail-worked"), report.worked);
    $("detail-running").hidden = report.outcome !== "running";
    const files = report.files || [];
    if (JSON.stringify(files) !== JSON.stringify(state.detail?.files)) {
      $("detail-files").replaceChildren(...files.map((file) => {
        const item = el("li");
        item.append(el("code", "", file));
        return item;
      }));
    }
    $("detail-no-files").hidden = files.length !== 0;
    text($("detail-reasoning"), report.reasoning || "No reasoning has been recorded for this session.");
    text($("detail-patch"), report.patch || "");
    $("detail-patch").hidden = !report.patch;
    $("detail-no-patch").hidden = !!report.patch;
    $("detail-content").hidden = false;
    state.detail = report;
  }

  async function loadDetail(quiet = false) {
    const id = state.selectedId;
    if (id == null || state.detailInFlight === id) return;
    const request = ++state.detailRequest;
    state.detailInFlight = id;
    $("detail-refresh").disabled = true;
    if (!quiet) notice("detail-notice", "Loading session details…");
    try {
      const report = await api(`/api/telemetry/${encodeURIComponent(id)}`);
      if (request !== state.detailRequest || id !== state.selectedId) return;
      renderDetail(report);
      notice("detail-notice");
    } catch (error) {
      if (request === state.detailRequest && id === state.selectedId) {
        notice("detail-notice", `${error.message}${state.detail ? " Previously loaded details are still shown." : ""}`, "error");
      }
    } finally {
      if (request === state.detailRequest) {
        state.detailInFlight = null;
        $("detail-refresh").disabled = false;
      }
    }
  }

  function renderPatterns(node, patterns) {
    node.replaceChildren(...patterns.map((pattern) => {
      const item = el("li");
      item.append(el("code", "", pattern));
      return item;
    }));
  }

  function renderRepos() {
    const config = state.config;
    renderPatterns($("global-patterns"), config.ignoreChecks);
    $("global-empty").hidden = config.ignoreChecks.length !== 0;
    text($("repos-total"), `${config.repos.length} tracked`);
    text($("repos-empty"), state.canEdit
      ? "No repositories yet. Add an owner/name to start tracking."
      : "No repositories are configured.");
    $("repos-empty").hidden = config.repos.length !== 0;
    $("repo-list").replaceChildren(...config.repos.map((repo) => {
      const name = `${repo.owner}/${repo.name}`;
      const item = el("li", "card repository-card");
      const top = el("div", "repository-top");
      top.append(el("h4", "repository-name", name));
      if (state.canEdit) {
        const actions = el("div", "repository-actions");
        const edit = el("button", "button secondary compact", "Edit ignores");
        edit.type = "button";
        edit.setAttribute("aria-label", `Edit ignored checks for ${name}`);
        edit.addEventListener("click", () => editRepo(repo));
        const remove = el("button", "button text-danger compact", "Remove");
        remove.type = "button";
        remove.setAttribute("aria-label", `Remove ${name}`);
        remove.addEventListener("click", () => openDelete(name));
        actions.append(edit, remove);
        top.append(actions);
      }
      const ignores = el("div", "repository-ignores");
      ignores.append(el("p", "muted small", "Repository ignored checks"));
      const patterns = repo.ignoreChecks || [];
      if (patterns.length) {
        const list = el("ul", "pattern-list");
        renderPatterns(list, patterns);
        ignores.append(list);
      } else {
        ignores.append(el("p", "muted small", "None · global patterns still apply"));
      }
      item.append(top, ignores);
      return item;
    }));
    updateRepoControls();
  }

  function updateRepoControls() {
    const busy = state.mutating || state.reposBusy;
    $("repo-fields").disabled = busy || !state.config || !state.canEdit;
    $("repos-refresh").disabled = busy;
    for (const button of $("repo-list").querySelectorAll("button")) button.disabled = busy;
    $("delete-confirm").disabled = busy || !state.deleteTarget;
    $("delete-cancel").disabled = state.mutating;
    $("delete-reload").disabled = busy;
  }

  function applyEditAccess(canEdit) {
    const next = canEdit === true;
    const changed = state.canEdit !== next;
    state.canEdit = next;
    $("repo-editor").hidden = !next;
    $("repos-readonly").hidden = next;
    if (next) {
      if (!state.csrf && !state.csrfRequest) {
        void csrfToken().catch((error) => {
          notice("form-notice", `Could not prepare secure configuration changes: ${error.message} Saving will request a fresh token.`, "error");
        });
      }
    } else {
      state.csrf = null;
      state.csrfRequest = null;
    }
    if (changed && state.config) renderRepos();
    else updateRepoControls();
  }

  function editorChanged() {
    return $("repo-name").value !== state.editorBaseline.repo
      || $("repo-patterns").value !== state.editorBaseline.patterns;
  }

  function useConfig(config) {
    state.config = config;
    state.editorRevision = config.revision;
    renderRepos();
  }

  async function loadRepos(manual = true) {
    if (state.reposBusy || state.mutating) return false;
    state.reposBusy = true;
    updateRepoControls();
    notice("repos-notice", "Loading repository configuration…");
    try {
      const config = await api("/api/repos");
      useConfig(config);
      if (manual) {
        const message = editorChanged() || state.editorRepo
          ? "Configuration refreshed. Your form entries are preserved. Review the current list and global patterns before saving again."
          : "Configuration refreshed.";
        notice("repos-notice", message, "info");
        notice("form-notice");
      } else {
        notice("repos-notice");
      }
      return true;
    } catch (error) {
      notice("repos-notice", `${error.message} Your form entries have not been changed.`, "error");
      return false;
    } finally {
      state.reposBusy = false;
      updateRepoControls();
    }
  }

  function resetEditor() {
    state.editorRepo = null;
    state.editorRevision = state.config?.revision ?? null;
    state.editorBaseline = { repo: "", patterns: "" };
    $("repo-form").reset();
    $("repo-name").readOnly = false;
    text($("editor-heading"), "Add repository");
    text($("editor-description"), "Track the repository’s main branch. Authentication is managed outside this dashboard.");
    text($("repo-save"), "Add repository");
    $("repo-cancel").hidden = true;
    notice("form-notice");
  }

  function editRepo(repo) {
    const name = `${repo.owner}/${repo.name}`;
    if (state.editorRepo === name) {
      $("repo-patterns").focus();
      return;
    }
    if (editorChanged() && !window.confirm("Discard your unsaved form entries and edit this repository instead?")) return;
    state.editorRepo = name;
    state.editorRevision = state.config.revision;
    const patterns = (repo.ignoreChecks || []).join("\n");
    state.editorBaseline = { repo: name, patterns };
    $("repo-name").value = name;
    $("repo-name").readOnly = true;
    $("repo-patterns").value = patterns;
    text($("editor-heading"), "Edit ignored checks");
    text($("editor-description"), "Edit this repository’s patterns. Leave the field blank to clear its overrides; global patterns remain in effect.");
    text($("repo-save"), "Save ignored checks");
    $("repo-cancel").hidden = false;
    notice("form-notice");
    $("repo-patterns").focus();
  }

  function mutationError(error) {
    if (error.status === 403) state.csrf = null;
    if (error.status === 409) {
      return `${error.message} Refresh configuration to review the latest settings, then save again. Your form entries are preserved; no retry was made.`;
    }
    return `${error.message} Your form entries are preserved.`;
  }

  async function mutate(path, method, body) {
    const token = await csrfToken();
    return api(path, {
      method,
      headers: { "Content-Type": "application/json", "X-Samasara-CSRF": token },
      body: JSON.stringify(body),
    });
  }

  async function saveRepo(event) {
    event.preventDefault();
    if (state.mutating || state.reposBusy || !state.config) return;
    const repo = $("repo-name").value.trim();
    const ignoreChecks = $("repo-patterns").value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const editing = state.editorRepo !== null;
    const revision = state.editorRevision;
    state.mutating = true;
    updateRepoControls();
    notice("form-notice", "Saving repository configuration…");
    try {
      const config = editing
        ? await mutate(repoPath(state.editorRepo), "PATCH", { ignoreChecks, revision })
        : await mutate("/api/repos", "POST", { repo, ignoreChecks, revision });
      useConfig(config);
      resetEditor();
      notice("repos-notice", `${repo} ${editing ? "updated" : "added"}. Changes apply on the next poll; a poll already in progress is unchanged.`, "success");
      void refreshStatus(true);
    } catch (error) {
      notice("form-notice", mutationError(error), "error");
    } finally {
      state.mutating = false;
      updateRepoControls();
    }
  }

  function openDelete(repo) {
    state.deleteTarget = { repo, revision: state.config.revision };
    text($("delete-repo"), repo);
    notice("delete-notice");
    $("delete-reload").hidden = true;
    updateRepoControls();
    $("delete-dialog").showModal();
  }

  async function deleteRepo() {
    if (state.mutating || state.reposBusy || !state.deleteTarget) return;
    const { repo, revision } = state.deleteTarget;
    state.mutating = true;
    updateRepoControls();
    notice("delete-notice", "Removing repository…");
    try {
      const config = await mutate(repoPath(repo), "DELETE", { revision });
      useConfig(config);
      $("delete-dialog").close();
      if (state.editorRepo === repo) {
        notice("form-notice", "This repository was removed. Your unsaved entries are preserved, but it is no longer tracked. Cancel editing to add a repository.", "info");
      }
      notice("repos-notice", `${repo} removed. Future tracking stops on the next poll. Historical telemetry is kept.`, "success");
      $("repos-refresh").disabled = false;
      $("repos-refresh").focus();
      void refreshStatus(true);
    } catch (error) {
      notice("delete-notice", error.status === 409
        ? `${error.message} Refresh configuration and review this removal before confirming again. No retry was made.`
        : mutationError(error), "error");
      $("delete-reload").hidden = error.status !== 409;
    } finally {
      state.mutating = false;
      updateRepoControls();
    }
  }

  async function reloadDeleteConfig() {
    if (!state.deleteTarget) return;
    const target = state.deleteTarget;
    if (!(await loadRepos())) {
      notice("delete-notice", "Configuration could not be refreshed. Close this dialog to see the connection error, or try refreshing again.", "error");
      return;
    }
    if (state.deleteTarget !== target) return;
    if (!state.config.repos.some((repo) => `${repo.owner}/${repo.name}` === target.repo)) {
      state.deleteTarget = null;
      notice("delete-notice", "This repository is no longer tracked. No further removal is needed. Historical telemetry is kept.", "info");
    } else {
      target.revision = state.config.revision;
      notice("delete-notice", "Configuration refreshed. Confirm removal again only if you still want to stop tracking this repository.", "info");
    }
    $("delete-reload").hidden = true;
    updateRepoControls();
  }

  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener("click", () => activateView(tab.dataset.view));
    tab.addEventListener("keydown", (event) => {
      let next;
      if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = tabs.length - 1;
      if (next == null) return;
      event.preventDefault();
      activateView(tabs[next].dataset.view, true);
    });
  }
  $("refresh").addEventListener("click", () => {
    if (state.view === "status") void refreshStatus();
    if (state.view === "telemetry") {
      void loadTelemetry();
      void loadDetail();
    }
    if (state.view === "repos") void loadRepos();
  });
  $("sessions-latest").addEventListener("click", () => void loadTelemetry([null]));
  $("sessions-newer").addEventListener("click", () => void loadTelemetry(state.pages.slice(0, -1)));
  $("sessions-older").addEventListener("click", () => {
    if (state.nextBefore != null) void loadTelemetry([...state.pages, state.nextBefore]);
  });
  $("detail-refresh").addEventListener("click", () => void loadDetail());
  $("repos-refresh").addEventListener("click", () => void loadRepos());
  $("repo-form").addEventListener("submit", saveRepo);
  $("repo-cancel").addEventListener("click", () => { resetEditor(); $("repo-name").focus(); });
  $("delete-cancel").addEventListener("click", () => $("delete-dialog").close());
  $("delete-confirm").addEventListener("click", () => void deleteRepo());
  $("delete-reload").addEventListener("click", () => void reloadDeleteConfig());
  $("delete-dialog").addEventListener("cancel", (event) => {
    if (state.mutating) event.preventDefault();
  });
  $("delete-dialog").addEventListener("close", () => { state.deleteTarget = null; });

  void refreshStatus();
  void loadTelemetry();
  void loadRepos(false);
  setInterval(() => {
    if (document.hidden) return;
    void refreshStatus(true);
    if (state.pages.length === 1) void loadTelemetry(state.pages, true);
    if (state.selectedId != null && (!state.detail || state.detail.outcome === "running")) void loadDetail(true);
  }, 10_000);
})();
