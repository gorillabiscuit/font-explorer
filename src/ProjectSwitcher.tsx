// The project menu at the far left of the top bar. One project per client and name, each saved on
// disk by the local server (server/projects/<id>.json). Switching swaps every setting, verdict,
// candidate and vibe search in place, without reloading the page, and clears the undo history.
// The online build has no server: projects live in this browser only, so the menu says so, offers
// Delete (nothing on disk to clean up by hand), and leaves out the brief, which only vibe search reads.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { BriefField } from "./BriefField";
import { STATIC } from "./env";
import { usePopover } from "./popover";
import { forgetProject, listProjects, newProjectId, type ProjectListing } from "./projectSync";
import { useStore } from "./store";
import "./projects.css";

type Mode = "menu" | "new" | "rename" | "brief" | "delete";

export function ProjectSwitcher() {
  const { projectId, projectName, syncStatus, switchProject, createProject, duplicateProject, renameProject, toast } = useStore();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("menu");
  const [list, setList] = useState<{ projects: ProjectListing[]; serverOk: boolean } | null>(null);
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const close = () => {
    setOpen(false);
    setMode("menu");
  };
  usePopover(open, close, ref);

  useEffect(() => {
    if (!open) return;
    let current = true;
    void listProjects().then((l) => current && setList(l));
    return () => {
      current = false;
    };
  }, [open, projectId]);

  // A deleted project's keys go once the page has switched away from it (projectSync forgetProject).
  const deleting = useRef<string | null>(null);
  useEffect(() => {
    const id = deleting.current;
    if (!id || id === projectId) return;
    deleting.current = null;
    forgetProject(id);
  }, [projectId]);

  // Without the server's answer the list may lack projects saved only on disk; newProjectId then
  // adds a random tail so a new id cannot overwrite one of them.
  const taken = () => [projectId, ...(list?.projects ?? []).map((p) => p.id)];
  /** Where Delete goes: the most recently changed other project. None when this is the only one. */
  const nextProject = (list?.projects ?? []).find((p) => p.id !== projectId) ?? null;
  const serverOk = list?.serverOk ?? false;
  // Either way the latest work is only in this browser for now; the two cases differ in what happens next.
  const warning = syncStatus === "offline" ? SAVE_WARNING : syncStatus === "unchecked" ? UNCHECKED_WARNING : null;

  const startForm = (next: Mode, initialName = "") => {
    setName(initialName);
    setText("");
    setMode(next);
  };
  const create = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    createProject(newProjectId(n, taken(), serverOk), n, text.trim());
    close();
    toast(`New project: ${n}`);
  };
  const duplicate = () => {
    const n = `${projectName} copy`;
    duplicateProject(newProjectId(n, taken(), serverOk), n);
    close();
    toast(`Duplicated as ${n}`);
  };
  const rename = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) renameProject(name);
    close();
  };
  const remove = (e: FormEvent) => {
    e.preventDefault();
    if (!nextProject) return;
    deleting.current = projectId;
    switchProject(nextProject.id);
    close();
    toast(`Deleted ${projectName}`);
  };

  return (
    <div className="popover-anchor project-switcher" ref={ref}>
      <button
        type="button"
        className={`project-btn ${open ? "is-open" : ""}`}
        title={warning ?? "Projects: one per client and name"}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className="name">{projectName}</span>
        {warning && <span className="sync-dot" aria-label="(not saved to disk)" />}
        <span className="caret">▾</span>
      </button>

      {open && mode === "menu" && (
        <div className="popover project-menu" role="menu">
          <div className="menu-head">Projects</div>
          <div className="menu-list">
            {(list?.projects ?? [{ id: projectId, name: projectName, updatedAt: 0 }]).map((p) => {
              const here = p.id === projectId;
              return (
                <button
                  key={p.id}
                  type="button"
                  role="menuitem"
                  className={`menu-item ${here ? "is-current" : ""}`}
                  title={STATIC ? undefined : `server/projects/${p.id}.json`}
                  onClick={() => {
                    if (!here) switchProject(p.id);
                    close();
                  }}
                >
                  <span className="check">{here ? "✓" : ""}</span>
                  <span className="label">{here ? projectName : p.name}</span>
                  <span className="when">{ago(p.updatedAt)}</span>
                </button>
              );
            })}
          </div>
          <div className="menu-sep" />
          <button type="button" role="menuitem" className="menu-item" onClick={() => startForm("new")}>
            <span className="check" />
            New project…
          </button>
          <button type="button" role="menuitem" className="menu-item" onClick={duplicate}>
            <span className="check" />
            Duplicate
          </button>
          <button type="button" role="menuitem" className="menu-item" onClick={() => startForm("rename", projectName)}>
            <span className="check" />
            Rename…
          </button>
          {STATIC ? (
            <button
              type="button"
              role="menuitem"
              className="menu-item"
              disabled={!nextProject}
              title={nextProject ? undefined : "The only project can't be deleted. Make another one first."}
              onClick={() => setMode("delete")}
            >
              <span className="check" />
              Delete…
            </button>
          ) : (
            <button type="button" role="menuitem" className="menu-item" onClick={() => setMode("brief")}>
              <span className="check" />
              Brief…
            </button>
          )}
          <div className="menu-sep" />
          {warning ? (
            <div className="menu-note warn">{warning}</div>
          ) : STATIC ? (
            <div className="menu-note">Saved in this browser only. Clearing this site's data deletes it.</div>
          ) : (
            <div className="menu-note">Saved on disk in server/projects/{projectId}.json</div>
          )}
          {list && !list.serverOk && !warning && (
            <div className="menu-note warn">The local server did not answer, so projects saved only on disk are missing here.</div>
          )}
        </div>
      )}

      {open && mode === "new" && (
        <form className="popover menu-form" onSubmit={create}>
          <div className="menu-head">New project</div>
          <label>
            Name (client or job)
            <input type="text" autoFocus value={name} maxLength={80} placeholder="Acme" onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Name to set
            <input
              type="text"
              value={text}
              placeholder={name.trim() || "The wordmark, with / for a line break"}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <div className="form-buttons">
            <button type="button" onClick={() => setMode("menu")}>
              Back
            </button>
            <button type="submit" className="primary" disabled={!name.trim()}>
              Create
            </button>
          </div>
        </form>
      )}

      {open && mode === "rename" && (
        <form className="popover menu-form" onSubmit={rename}>
          <div className="menu-head">Rename project</div>
          <input type="text" autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          {!STATIC && <div className="faint small">The file keeps its name: server/projects/{projectId}.json</div>}
          <div className="form-buttons">
            <button type="button" onClick={() => setMode("menu")}>
              Back
            </button>
            <button type="submit" className="primary" disabled={!name.trim()}>
              Rename
            </button>
          </div>
        </form>
      )}

      {open && mode === "delete" && (
        <form className="popover menu-form" onSubmit={remove}>
          <div className="menu-head">Delete {projectName}?</div>
          <div className="faint small">Its settings, verdicts and candidates are kept only in this browser, so this can't be undone.</div>
          <div className="form-buttons">
            <button type="button" onClick={() => setMode("menu")}>
              Back
            </button>
            <button type="submit" className="primary" autoFocus>
              Delete
            </button>
          </div>
        </form>
      )}

      {open && mode === "brief" && (
        <div className="popover menu-form brief-pop">
          <div className="menu-head">Brief · Claude reads it with every vibe search</div>
          <BriefField autoFocus onDone={close} />
          <div className="form-buttons">
            <button type="button" className="primary" onClick={close}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const SAVE_WARNING =
  "Not saved to disk yet: the local server is not answering. Your changes are kept in this browser and saving is tried again on its own until the server is back.";
const UNCHECKED_WARNING =
  "The local server did not answer when this project opened, so it is not compared with the copy on disk yet. Changes stay in this browser and nothing is written to disk until the server answers; if the copy on disk is newer, it then replaces what you see here.";

/** '5 min ago'; empty for a project never changed in this browser. */
function ago(ms: number): string {
  if (!ms) return "";
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
