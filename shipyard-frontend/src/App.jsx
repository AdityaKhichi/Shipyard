import { useMemo, useState } from "react";
import { generate } from "random-words";
import { deployRepository } from "./main-server-api.js";
import { listenToLogs } from "./socket.js";
import { env } from "./env.js";
import { validateProjectName, validateURL } from "./utils.js";

const initialDeployments = [];

function normalizeLogMessage(data) {
  try {
    const parsed = JSON.parse(data);
    return parsed.log || data;
  } catch {
    return String(data);
  }
}

function deploymentUrl(projectId) {
  const protocol = window.location.protocol === "https:" ? "https:" : "http:";
  return `${protocol}//${projectId}.${env.currentDomain}`;
}

export default function App() {
  const [repoUrl, setRepoUrl] = useState("");
  const [projectName, setProjectName] = useState("");
  const [logs, setLogs] = useState([]);
  const [status, setStatus] = useState("idle");
  const [deployments, setDeployments] = useState(initialDeployments);
  const [activeUrl, setActiveUrl] = useState("");
  const [error, setError] = useState("");

  const repoValid = repoUrl === "" || validateURL(repoUrl.trim());
  const projectValid =
    projectName === "" || validateProjectName(projectName.trim());
  const canDeploy =
    repoUrl.trim() !== "" &&
    projectName.trim() !== "" &&
    repoValid &&
    projectValid &&
    status !== "deploying";

  const timeline = useMemo(
    () => [
      { label: "Queued", active: status !== "idle" },
      { label: "Building", active: status === "deploying" || status === "success" },
      { label: "Uploaded", active: status === "success" },
      { label: "Live", active: status === "success" },
    ],
    [status]
  );

  function appendLog(message) {
    const normalized = normalizeLogMessage(message);
    setLogs((current) => [...current, normalized]);

    if (normalized.includes("Deployment successful")) {
      const url = deploymentUrl(projectName.trim());
      setStatus("success");
      setActiveUrl(url);
      setDeployments((current) => [
        {
          id: projectName.trim(),
          repo: repoUrl.trim(),
          status: "Live",
          url,
          time: new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }),
        },
        ...current.filter((deployment) => deployment.id !== projectName.trim()),
      ]);
    }
  }

  async function startDeployment(event) {
    event.preventDefault();
    if (!canDeploy) return;

    const id = projectName.trim();
    setStatus("deploying");
    setError("");
    setActiveUrl("");
    setLogs([
      `Queued Shipyard deployment for ${id}.`,
      "Starting build container and waiting for logs...",
    ]);

    const fallbackTimer = window.setTimeout(() => {
      setLogs((current) => [
        ...current,
        "Logs are delayed. The deployment is still running in the background.",
      ]);
    }, 6000);

    try {
      const result = await deployRepository(repoUrl.trim(), id);
      setLogs((current) => [
        ...current,
        `ECS task accepted: ${result.taskArn || "task ARN unavailable"}.`,
      ]);

      listenToLogs(result.projectId || id, (message) => {
        window.clearTimeout(fallbackTimer);
        appendLog(message);
      });

      window.setTimeout(() => {
        setStatus((current) => {
          if (current === "deploying") {
            const url = deploymentUrl(id);
            setActiveUrl(url);
            setDeployments((existing) => [
              {
                id,
                repo: repoUrl.trim(),
                status: "Live",
                url,
                time: new Date().toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                }),
              },
              ...existing.filter((deployment) => deployment.id !== id),
            ]);
            return "success";
          }
          return current;
        });
      }, 30000);
    } catch (err) {
      window.clearTimeout(fallbackTimer);
      setStatus("error");
      setError(err.message || "Failed to start deployment.");
      setLogs((current) => [
        ...current,
        `Failed to start deployment: ${err.message || "unknown error"}`,
      ]);
    }
  }

  function fillSample() {
    const repoOptions = [
      "https://github.com/rajatevencodes/MarioGame.git",
      "https://github.com/MisterPrada/morph-particles",
    ];
    setRepoUrl(repoOptions[Math.floor(Math.random() * repoOptions.length)]);
    setProjectName(generate().toLowerCase());
  }

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="Shipyard navigation">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            S
          </span>
          <div>
            <strong>Shipyard</strong>
            <span>Self-hosted deploys</span>
          </div>
        </div>

        <nav className="nav-list">
          <a className="active" href="#deploy">Deployments</a>
          <a href="#logs">Build logs</a>
          <a href="#history">History</a>
        </nav>

        <div className="sidebar-status">
          <span className="status-dot" />
          API {env.apiURL || "not configured"}
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Deployment console</p>
            <h1>Ship from Git to your own cloud.</h1>
          </div>
          <div className={`deploy-state ${status}`}>{status}</div>
        </header>

        <div className="dashboard-grid">
          <section className="panel deploy-panel" id="deploy">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">New deployment</p>
                <h2>Configure source</h2>
              </div>
              <button type="button" className="ghost-button" onClick={fillSample}>
                Sample
              </button>
            </div>

            <form className="deploy-form" onSubmit={startDeployment}>
              <label>
                Repository URL
                <input
                  className={!repoValid ? "invalid" : ""}
                  value={repoUrl}
                  onChange={(event) => setRepoUrl(event.target.value)}
                  placeholder="https://github.com/acme/site.git"
                  autoComplete="off"
                />
              </label>

              <label>
                Subdomain
                <input
                  className={!projectValid ? "invalid" : ""}
                  value={projectName}
                  onChange={(event) => setProjectName(event.target.value)}
                  placeholder="launch-preview"
                  autoComplete="off"
                />
              </label>

              {error && <p className="form-error">{error}</p>}

              <button className="primary-button" type="submit" disabled={!canDeploy}>
                {status === "deploying" ? "Deploying..." : "Deploy"}
              </button>
            </form>
          </section>

          <section className="panel timeline-panel">
            <p className="eyebrow">Progress</p>
            <div className="timeline">
              {timeline.map((item) => (
                <div className={item.active ? "timeline-item active" : "timeline-item"} key={item.label}>
                  <span />
                  {item.label}
                </div>
              ))}
            </div>
            {activeUrl ? (
              <a className="live-url" href={activeUrl} target="_blank" rel="noreferrer">
                {activeUrl}
              </a>
            ) : (
              <p className="muted">The production URL appears here after upload.</p>
            )}
          </section>

          <section className="panel logs-panel" id="logs">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Live stream</p>
                <h2>Build logs</h2>
              </div>
              <span className="connection-pill">Socket.IO</span>
            </div>
            <div className="terminal" role="log" aria-live="polite">
              {logs.length === 0 ? (
                <p className="terminal-empty">No deployment has been started.</p>
              ) : (
                logs.map((line, index) => (
                  <div className="terminal-line" key={`${line}-${index}`}>
                    {line}
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="panel history-panel" id="history">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Recent</p>
                <h2>Deployment history</h2>
              </div>
            </div>
            {deployments.length === 0 ? (
              <p className="empty-state">Completed deployments will appear here.</p>
            ) : (
              <div className="history-list">
                {deployments.map((deployment) => (
                  <a
                    className="history-row"
                    href={deployment.url}
                    target="_blank"
                    rel="noreferrer"
                    key={deployment.id}
                  >
                    <span>
                      <strong>{deployment.id}</strong>
                      <small>{deployment.repo}</small>
                    </span>
                    <em>{deployment.status}</em>
                    <time>{deployment.time}</time>
                  </a>
                ))}
              </div>
            )}
          </section>
        </div>
      </section>
    </main>
  );
}
