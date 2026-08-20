import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

type Tab = "audio" | "transcription" | "review";
type Page = "files" | "tasks";
type AudioFile = { id: string; filename: string; alias: string | null; savedAt: string; durationMs: number; sizeBytes: number; isTranscribed: boolean; isReviewed: boolean };
type AudioFilesResponse = { items: AudioFile[]; pagination: { page: number; pageSize: number; totalItems: number; totalPages: number; totalSizeBytes: number } };
type TaskProposal = { title: string; description: string; links: string[]; scheduledAt: string | null; deadlineAt: string | null };
type TaskDraft = { proposalKey: string; title: string; description: string; links: string; scheduledAt: string; deadlineAt: string; estimateDays: number };
type TaskStatus = "neutral" | "green" | "yellow" | "red" | "dead";
type TaskListState = "all" | "in_progress" | "done" | "dead";
type StoredTask = { id: string; title: string; description: string; links: string[]; audioFileId: string; scheduledAt: string | null; deadlineAt: string | null; estimateDays: number; isCompleted: boolean; status: TaskStatus };
type TasksResponse = { items: StoredTask[]; pagination: { page: number; pageSize: number; totalItems: number; totalPages: number } };
type TaskEditDraft = { title: string; description: string; links: string; scheduledAt: string; deadlineAt: string; estimateDays: number };

function formatDuration(value: number) {
  const seconds = Math.floor(value / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours ? `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${rest.toString().padStart(2, "0")}` : `${minutes.toString().padStart(2, "0")}:${rest.toString().padStart(2, "0")}`;
}

function formatSize(value: number) { return `${(value / 1024 / 1024).toFixed(1)} MB`; }
function stem(filename: string) { return filename.replace(/\.[^.]+$/, ""); }
function displayName(file: AudioFile) { return file.alias?.trim() || stem(file.filename); }
function shortId(value: string) { return `${value.slice(0, 8)}...${value.slice(-6)}`; }
function formatDateTime(value: string) {
  const date = new Date(value);
  const pad = (part: number) => part.toString().padStart(2, "0");
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} - ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toDateTimeInput(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  const pad = (part: number) => part.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatEstimate(value: number) {
  if (value === 0) return "Менее часа";
  if (value === 1) return "От 1 до 3 часов";
  if (value === 2) return "От 3 до 8 часов";
  const days = value - 1;
  return `${days} ${days < 5 ? "дня" : "дней"}`;
}

const waveform = Array.from({ length: 60 }, (_, i) => Math.round(11 + Math.abs(Math.sin(i * .58)) * 30 + (i * 7) % 13));

function Logo() {
  return <span className="logo"><svg width="24" height="24" viewBox="0 0 16 16"><path d="M8 1.5a.75.75 0 0 1 .75.75v11.5a.75.75 0 0 1-1.5 0V2.25A.75.75 0 0 1 8 1.5ZM5 4a.75.75 0 0 1 .75.75v6.5a.75.75 0 0 1-1.5 0v-6.5A.75.75 0 0 1 5 4Zm6 0a.75.75 0 0 1 .75.75v6.5a.75.75 0 0 1-1.5 0v-6.5A.75.75 0 0 1 11 4ZM2.5 5.5a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5a.75.75 0 0 1 .75-.75Zm11 0a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5a.75.75 0 0 1 .75-.75Z" fill="white" /></svg></span>;
}

function MiniWave({ active }: { active: boolean }) {
  return <span className={`mini-wave ${active ? "active" : ""}`} aria-hidden="true">{[3, 7, 5, 9, 4, 8, 6].map((h, i) => <i key={i} style={{ height: h, animationDelay: `${i * .07}s` }} />)}</span>;
}

function inlineMarkdown(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean).map((part, index) => {
    if (part.startsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    return <Fragment key={index}>{part}</Fragment>;
  });
}

function Document({ source, loading }: { source: string; loading: boolean }) {
  if (loading) return <section className="document compact"><p>Загрузка...</p></section>;
  const blocks = source.split(/\n\s*\n/).filter(Boolean);
  return <section className="document compact">{blocks.map((block, index) => {
    if (block.startsWith("### ")) return <h3 key={index}>{inlineMarkdown(block.slice(4))}</h3>;
    if (block.startsWith("## ")) return <h2 key={index}>{inlineMarkdown(block.slice(3))}</h2>;
    if (block.startsWith("# ")) return <h1 key={index}>{inlineMarkdown(block.slice(2))}</h1>;
    if (block.startsWith("> ")) return <blockquote key={index}>{inlineMarkdown(block.slice(2))}</blockquote>;
    if (block.split("\n").every((line) => /^[-*] /.test(line))) return <ul key={index}>{block.split("\n").map((line, lineIndex) => <li key={lineIndex}>{inlineMarkdown(line.slice(2))}</li>)}</ul>;
    return <p key={index}>{inlineMarkdown(block.replace(/\n/g, " "))}</p>;
  })}</section>;
}

const taskStatusLabels: Record<TaskStatus, string> = {
  neutral: "Нейтральный",
  green: "Времени достаточно",
  yellow: "Пора начинать",
  red: "Желаемый срок прошёл",
  dead: "Дедлайн пропущен",
};

function TasksPage({ onOpenAudio }: { onOpenAudio: (audioFileId: string) => void }) {
  const [tasks, setTasks] = useState<StoredTask[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [taskState, setTaskState] = useState<TaskListState>("all");
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 20, totalItems: 0, totalPages: 0 });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editDraft, setEditDraft] = useState<TaskEditDraft | null>(null);
  const [error, setError] = useState("");
  const selected = tasks.find((task) => task.id === selectedId) ?? tasks[0];

  useEffect(() => {
    const timeout = window.setTimeout(() => { setDebouncedSearch(search.trim()); setPage(1); }, 500);
    return () => window.clearTimeout(timeout);
  }, [search]);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ page: String(page), sort: "asc" });
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    if (debouncedSearch) params.set("search", debouncedSearch);
    params.set("state", taskState);
    setLoading(true);
    setError("");
    fetch(`/api/tasks?${params}`, { signal: controller.signal })
      .then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json() as Promise<TasksResponse>; })
      .then((data) => {
        setTasks((current) => page === 1 ? data.items : [...current, ...data.items.filter((item) => !current.some((existing) => existing.id === item.id))]);
        setPagination(data.pagination);
        setSelectedId((current) => page > 1 ? current : (data.items.some((task) => task.id === current) ? current : (data.items[0]?.id ?? "")));
      })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Ошибка загрузки"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [page, dateFrom, dateTo, debouncedSearch, taskState]);

  const toggleCompleted = async () => {
    if (!selected || saving) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/tasks/${selected.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isCompleted: !selected.isCompleted }) });
      const result = await response.json() as StoredTask & { error?: string };
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      setTasks((current) => current.map((task) => task.id === result.id ? result : task));
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Не удалось обновить задачу");
    } finally {
      setSaving(false);
    }
  };
  const beginEdit = () => {
    if (!selected) return;
    setEditDraft({ title: selected.title, description: selected.description, links: selected.links.join("\n"), scheduledAt: toDateTimeInput(selected.scheduledAt), deadlineAt: toDateTimeInput(selected.deadlineAt), estimateDays: selected.estimateDays });
  };
  const saveTask = async () => {
    if (!selected || !editDraft || saving) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/tasks/${selected.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: editDraft.title,
          description: editDraft.description,
          links: editDraft.links.split(/\r?\n|,/).map((link) => link.trim()).filter(Boolean),
          scheduledAt: editDraft.scheduledAt ? new Date(editDraft.scheduledAt).toISOString() : null,
          deadlineAt: editDraft.deadlineAt ? new Date(editDraft.deadlineAt).toISOString() : null,
          estimateDays: editDraft.estimateDays,
        }),
      });
      const result = await response.json() as StoredTask & { error?: string };
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      setTasks((current) => current.map((task) => task.id === result.id ? result : task));
      setEditDraft(null);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Не удалось сохранить задачу");
    } finally {
      setSaving(false);
    }
  };

  return <div className="workspace tasks-workspace">
    <aside className="sidebar task-sidebar">
      <label className="search"><svg width="13" height="13" viewBox="0 0 16 16"><circle cx="7" cy="7" r="5" /><path d="m11 11 3 3" /></svg><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="поиск задач..." /></label>
      <div className="date-range">
        <input aria-label="Дата от" type="date" value={dateFrom} max={dateTo || undefined} onChange={(event) => { setDateFrom(event.target.value); setPage(1); }} />
        <span>—</span>
        <input aria-label="Дата до" type="date" value={dateTo} min={dateFrom || undefined} onChange={(event) => { setDateTo(event.target.value); setPage(1); }} />
        {(dateFrom || dateTo) && <button aria-label="Сбросить диапазон" onClick={() => { setDateFrom(""); setDateTo(""); setPage(1); }}>✕</button>}
      </div>
      <div className="task-state-filter" aria-label="Фильтр по состоянию задачи">
        <button className={taskState === "all" ? "active" : ""} onClick={() => { setTaskState("all"); setPage(1); }}>All</button>
        <button className={taskState === "in_progress" ? "active" : ""} onClick={() => { setTaskState("in_progress"); setPage(1); }}><i className="filter-progress" />In progress</button>
        <button className={taskState === "done" ? "active" : ""} onClick={() => { setTaskState("done"); setPage(1); }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>Done</button>
        <button className={taskState === "dead" ? "active" : ""} onClick={() => { setTaskState("dead"); setPage(1); }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m12.5 17-.5-1-.5 1h1z" /><path d="M15 22a1 1 0 0 0 1-1v-1a2 2 0 0 0 1.56-3.25 8 8 0 1 0-11.12 0A2 2 0 0 0 8 20v1a1 1 0 0 0 1 1z" /><circle cx="15" cy="12" r="1" /><circle cx="9" cy="12" r="1" /></svg>Dead</button>
      </div>
      <nav className="file-list task-list" onScroll={(event) => {
        const element = event.currentTarget;
        if (!loading && page < pagination.totalPages && element.scrollHeight - element.scrollTop - element.clientHeight < 80) setPage((value) => value + 1);
      }}>
        {tasks.map((task) => <button key={task.id} className={`task-list-item ${selected?.id === task.id ? "selected" : ""} ${task.isCompleted ? "completed" : ""} ${task.status === "dead" ? "dead" : ""}`} onClick={() => setSelectedId(task.id)}>
          <span className={`status-dot ${task.status}`} />
          <span><strong>{task.title}</strong><small>{task.scheduledAt ? formatDateTime(task.scheduledAt) : "Без желаемой даты"}</small></span>
          {task.status === "dead" ? <span className="completed-mark dead-mark" aria-label="Дедлайн пропущен"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m12.5 17-.5-1-.5 1h1z" /><path d="M15 22a1 1 0 0 0 1-1v-1a2 2 0 0 0 1.56-3.25 8 8 0 1 0-11.12 0A2 2 0 0 0 8 20v1a1 1 0 0 0 1 1z" /><circle cx="15" cy="12" r="1" /><circle cx="9" cy="12" r="1" /></svg></span> : task.isCompleted && <span className="completed-mark" aria-label="Выполнено"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg></span>}
        </button>)}
        {!tasks.length && !loading && <p className="empty">{error || "задачи не найдены"}</p>}
        {loading && <p className="loading">загрузка...</p>}
      </nav>
      <div className="file-summary"><i /><span>{pagination.totalItems} задач</span></div>
    </aside>
    <main className="content task-content">
      {!selected ? <div className="no-selection">{error ? `API: ${error}` : "Нет задач"}</div> : <>
        <div className={`task-header ${selected.isCompleted ? "completed" : ""}`}>
          <div><span className={`task-status ${selected.isCompleted ? "green" : selected.status}`}><i />{selected.isCompleted ? "Выполнено" : taskStatusLabels[selected.status]}</span><h1 title="Двойной клик для редактирования" onDoubleClick={beginEdit}>{selected.title}</h1></div>
          <div className="task-header-actions"><button className="task-edit" disabled={saving} onClick={beginEdit}>Редактировать</button><button className={selected.isCompleted ? "task-reopen" : "task-complete"} disabled={saving} onClick={() => void toggleCompleted()}>{saving ? "Сохранение..." : selected.isCompleted ? "Вернуть в работу" : "Отметить выполненной"}</button></div>
        </div>
        <div className="task-detail-scroll">
          <section className="task-description" onDoubleClick={beginEdit}><small>Описание</small><p>{selected.description}</p></section>
          <section className="task-facts">
            <div><small>Желаемое время</small><span>{selected.scheduledAt ? formatDateTime(selected.scheduledAt) : "Не указано"}</span></div>
            <div><small>Дедлайн</small><span>{selected.deadlineAt ? formatDateTime(selected.deadlineAt) : "Не указан"}</span></div>
            <div><small>Оценка</small><span>{formatEstimate(selected.estimateDays)}</span></div>
            <div className="task-source"><small>Исходный аудиофайл</small><button onClick={() => onOpenAudio(selected.audioFileId)}>Перейти к файлу</button></div>
          </section>
          {!!selected.links.length && <section className="task-links"><small>Ссылки</small>{selected.links.map((link) => <a key={link} href={link} target="_blank" rel="noreferrer">{link}</a>)}</section>}
        </div>
        {editDraft && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setEditDraft(null); }}>
          <form className="task-modal" onSubmit={(event) => { event.preventDefault(); void saveTask(); }}>
            <div className="modal-title"><div><small>Задача</small><h2>Редактирование Task</h2></div><button type="button" aria-label="Закрыть" disabled={saving} onClick={() => setEditDraft(null)}>×</button></div>
            <label><span>Название</span><input required maxLength={160} value={editDraft.title} onChange={(event) => setEditDraft({ ...editDraft, title: event.target.value })} /></label>
            <label><span>Описание</span><textarea required rows={6} maxLength={4000} value={editDraft.description} onChange={(event) => setEditDraft({ ...editDraft, description: event.target.value })} /></label>
            <label><span>Ссылки <small>по одной на строку</small></span><textarea rows={3} value={editDraft.links} onChange={(event) => setEditDraft({ ...editDraft, links: event.target.value })} /></label>
            <div className="task-date-fields"><label><span>Желаемое время</span><input type="datetime-local" value={editDraft.scheduledAt} onChange={(event) => setEditDraft({ ...editDraft, scheduledAt: event.target.value })} /></label><label><span>Дедлайн</span><input type="datetime-local" value={editDraft.deadlineAt} onChange={(event) => setEditDraft({ ...editDraft, deadlineAt: event.target.value })} /></label></div>
            <label className="estimate-field"><span><span>Оценка длительности</span><strong>{formatEstimate(editDraft.estimateDays)}</strong></span><input type="range" min="0" max="15" step="1" value={editDraft.estimateDays} onChange={(event) => setEditDraft({ ...editDraft, estimateDays: Number(event.target.value) })} style={{ "--estimate-progress": `${editDraft.estimateDays / 15 * 100}%` } as CSSProperties} /><div className="estimate-scale"><span>менее часа</span>{Array.from({ length: 14 }, (_, index) => <i key={index} />)}<span>14 дней</span></div></label>
            <div className="modal-actions"><button type="button" disabled={saving} onClick={() => setEditDraft(null)}>Отмена</button><button type="submit" disabled={saving || !editDraft.title.trim() || !editDraft.description.trim()}>{saving ? "Сохранение..." : "Сохранить"}</button></div>
          </form>
        </div>}
      </>}
    </main>
  </div>;
}

export function App() {
  const [activePage, setActivePage] = useState<Page>("files");
  const [nearestTaskStatus, setNearestTaskStatus] = useState<TaskStatus | null>(null);
  const [taskIndicatorStatus, setTaskIndicatorStatus] = useState<"green" | "yellow" | "red">("green");
  const [files, setFiles] = useState<AudioFile[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [tab, setTab] = useState<Tab>("audio");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [playing, setPlaying] = useState(false);
  const [copiedId, setCopiedId] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  const [editingAlias, setEditingAlias] = useState(false);
  const [aliasDraft, setAliasDraft] = useState("");
  const [aliasSaving, setAliasSaving] = useState(false);
  const [selectedForDeletion, setSelectedForDeletion] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 20, totalItems: 0, totalPages: 0, totalSizeBytes: 0 });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [content, setContent] = useState<Record<string, Partial<Record<"transcription" | "review", string>>>>({});
  const [taskProposals, setTaskProposals] = useState<Record<string, TaskProposal[]>>({});
  const [createdProposals, setCreatedProposals] = useState<string[]>([]);
  const [taskDraft, setTaskDraft] = useState<TaskDraft | null>(null);
  const [taskSaving, setTaskSaving] = useState(false);
  const [contentLoading, setContentLoading] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    let active = true;
    const loadNearestTaskStatus = () => {
      void fetch("/api/tasks/nearest-status")
        .then((response) => response.ok ? response.json() as Promise<{ status: TaskStatus | null }> : null)
        .then((result) => {
          if (!active) return;
          const status = result?.status ?? null;
          setNearestTaskStatus(status);
          if (status === "green" || status === "yellow" || status === "red") setTaskIndicatorStatus(status);
        })
        .catch(() => { if (active) setNearestTaskStatus(null); });
    };
    loadNearestTaskStatus();
    const interval = window.setInterval(loadNearestTaskStatus, 60_000);
    return () => { active = false; window.clearInterval(interval); };
  }, [activePage]);
  const waveformRef = useRef<HTMLDivElement>(null);
  const waveformAnimations = useRef<Animation[]>([]);
  const [currentMs, setCurrentMs] = useState(0);
  const selected = files.find((file) => file.id === selectedId) ?? files[0];
  const selectedSizeBytes = files.reduce((total, file) => selectedForDeletion.includes(file.id) ? total + file.sizeBytes : total, 0);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 1000);
    return () => window.clearTimeout(timeout);
  }, [search]);

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), sort: "desc" });
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    if (debouncedSearch) params.set("search", debouncedSearch);
    fetch(`/api/audio-files?${params}`, { signal: controller.signal })
      .then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json() as Promise<AudioFilesResponse>; })
      .then((data) => {
        setFiles((current) => page === 1 ? data.items : [...current, ...data.items.filter((item) => !current.some((existing) => existing.id === item.id))]);
        setPagination(data.pagination);
        setSelectedId((current) => page > 1 ? current : (data.items.some((file) => file.id === current) ? current : (data.items[0]?.id ?? "")));
      })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Ошибка загрузки"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [page, dateFrom, dateTo, debouncedSearch, reloadKey]);

  useEffect(() => {
    if (!selected || tab === "audio" || content[selected.id]?.[tab]) return;
    const controller = new AbortController();
    setContentLoading(true);
    fetch(`/api/audio-files/${selected.id}/${tab}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as { content?: string; proposals?: TaskProposal[]; error?: string };
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
        return body;
      })
      .then((body) => {
        setContent((current) => ({ ...current, [selected.id]: { ...current[selected.id], [tab]: body.content ?? "" } }));
        if (tab === "review") setTaskProposals((current) => ({ ...current, [selected.id]: body.proposals ?? [] }));
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setContent((current) => ({ ...current, [selected.id]: { ...current[selected.id], [tab]: reason instanceof Error ? reason.message : "Ошибка загрузки" } }));
      })
      .finally(() => { if (!controller.signal.aborted) setContentLoading(false); });
    return () => controller.abort();
  }, [content, selected, tab]);

  useEffect(() => {
    const bars = Array.from(waveformRef.current?.querySelectorAll("i") ?? []);
    if (playing) {
      waveformAnimations.current = bars.map((bar, index) => {
        const current = getComputedStyle(bar);
        waveformAnimations.current[index]?.cancel();
        return bar.animate([
        { transform: current.transform, backgroundPosition: current.backgroundPosition, opacity: current.opacity, filter: current.filter },
        { transform: "scaleY(.88)", backgroundPosition: "50% 54%", opacity: .76, filter: "brightness(1.06)" },
        { transform: "scaleY(1)", backgroundPosition: "50% 65%", opacity: .66, filter: "brightness(1)" },
      ], { duration: 1450 + (index % 7) * 80, delay: (index % 6) * 35, easing: "ease-in-out", iterations: Infinity });
      });
      return;
    }

    const restingAnimations = bars.map((bar, index) => {
      const current = getComputedStyle(bar);
      waveformAnimations.current[index]?.cancel();
      return bar.animate([
        { transform: current.transform, backgroundPosition: current.backgroundPosition, opacity: current.opacity, filter: current.filter },
        { transform: "scaleY(1)", backgroundPosition: "50% 65%", opacity: .66, filter: "brightness(1)" },
      ], { duration: 420, easing: "ease-out" });
    });
    waveformAnimations.current = restingAnimations;
  }, [playing]);

  const select = (id: string) => { setSelectedId(id); setTab("audio"); setPlaying(false); setCurrentMs(0); setEditingAlias(false); };
  const beginAliasEdit = () => {
    if (!selected) return;
    setAliasDraft(displayName(selected));
    setEditingAlias(true);
  };
  const saveAlias = async () => {
    if (!selected || aliasSaving) return;
    const alias = aliasDraft.trim();
    if (!alias || alias.length > 160) return;
    setAliasSaving(true);
    try {
      const response = await fetch(`/api/audio-files/${selected.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ alias }) });
      const result = await response.json() as { alias?: string; error?: string };
      if (!response.ok || !result.alias) throw new Error(result.error ?? `HTTP ${response.status}`);
      setFiles((current) => current.map((file) => file.id === selected.id ? { ...file, alias: result.alias! } : file));
      setEditingAlias(false);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Не удалось сохранить alias");
    } finally {
      setAliasSaving(false);
    }
  };
  const copyId = async () => {
    if (!selected) return;
    await navigator.clipboard.writeText(selected.id);
    setCopiedId(true);
    window.setTimeout(() => setCopiedId(false), 1500);
  };
  const copyPath = async () => {
    if (!selected) return;
    await navigator.clipboard.writeText(`/home/igormeshalkin/voice-commander/audio/${selected.filename}`);
    setCopiedPath(true);
    window.setTimeout(() => setCopiedPath(false), 1500);
  };
  const toggleAudio = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) await audio.play(); else audio.pause();
  };
  const toggleDeletionSelection = (id: string) => {
    setSelectedForDeletion((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  };
  const deleteSelected = async () => {
    if (!selectedForDeletion.length || deleting || !window.confirm(`Удалить выбранные файлы (${selectedForDeletion.length}) вместе с транскрипциями и ревью?`)) return;
    setDeleting(true);
    try {
      const response = await fetch("/api/audio-files", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: selectedForDeletion }) });
      const result = await response.json() as { deleted?: number; error?: string };
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      setSelectedForDeletion([]);
      setPage(1);
      setReloadKey((value) => value + 1);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Не удалось удалить файлы");
    } finally {
      setDeleting(false);
    }
  };
  const openTaskProposal = (proposal: TaskProposal, index: number) => {
    if (!selected) return;
    setTaskDraft({
      proposalKey: `${selected.id}:${index}`,
      title: proposal.title,
      description: proposal.description,
      links: proposal.links.join("\n"),
      scheduledAt: toDateTimeInput(proposal.scheduledAt),
      deadlineAt: toDateTimeInput(proposal.deadlineAt),
      estimateDays: 0,
    });
  };
  const createTask = async () => {
    if (!selected || !taskDraft || taskSaving) return;
    setTaskSaving(true);
    try {
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: taskDraft.title,
          description: taskDraft.description,
          links: taskDraft.links.split(/\r?\n|,/).map((link) => link.trim()).filter(Boolean),
          audioFileId: selected.id,
          scheduledAt: taskDraft.scheduledAt ? new Date(taskDraft.scheduledAt).toISOString() : null,
          deadlineAt: taskDraft.deadlineAt ? new Date(taskDraft.deadlineAt).toISOString() : null,
          estimateDays: taskDraft.estimateDays,
        }),
      });
      const result = await response.json() as { id?: string; error?: string };
      if (!response.ok || !result.id) throw new Error(result.error ?? `HTTP ${response.status}`);
      setCreatedProposals((current) => [...current, taskDraft.proposalKey]);
      setTaskDraft(null);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Не удалось создать задачу");
    } finally {
      setTaskSaving(false);
    }
  };

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><Logo /><div><strong>Voice Commander</strong><small>admin panel</small></div></div>
      <nav className="page-nav" aria-label="Основная навигация">
        <button className={activePage === "files" ? "active" : ""} onClick={() => setActivePage("files")}>Files</button>
        <button className={activePage === "tasks" ? "active" : ""} onClick={() => setActivePage("tasks")}>Tasks<i className={`task-nav-indicator ${taskIndicatorStatus} ${activePage === "files" && nearestTaskStatus && ["green", "yellow", "red"].includes(nearestTaskStatus) ? "visible" : ""}`} aria-hidden="true" /></button>
      </nav>
    </header>
    {activePage === "files" ? <div className="workspace">
      <aside className="sidebar">
        <label className="search"><svg width="13" height="13" viewBox="0 0 16 16"><circle cx="7" cy="7" r="5" /><path d="m11 11 3 3" /></svg><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="поиск файлов..." /></label>
        <div className="date-range">
          <input aria-label="Дата от" type="date" value={dateFrom} max={dateTo || undefined} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} />
          <span>—</span>
          <input aria-label="Дата до" type="date" value={dateTo} min={dateFrom || undefined} onChange={(e) => { setDateTo(e.target.value); setPage(1); }} />
          {(dateFrom || dateTo) && <button aria-label="Сбросить диапазон" onClick={() => { setDateFrom(""); setDateTo(""); setPage(1); }}>✕</button>}
        </div>
        <nav className="file-list" onScroll={(event) => {
          const element = event.currentTarget;
          if (!loading && page < pagination.totalPages && element.scrollHeight - element.scrollTop - element.clientHeight < 80) setPage((value) => value + 1);
        }}>
          {files.map((file) => <div key={file.id} className={`file-row ${selectedForDeletion.includes(file.id) ? "checked" : ""}`}>
            <button className={`file-item ${selected?.id === file.id ? "selected" : ""}`} onClick={() => select(file.id)}>
              <span className="file-name"><MiniWave active={selected?.id === file.id} /><span title={file.alias ? file.filename : undefined}>{displayName(file)}</span></span>
              <span className="file-meta"><span>{formatDateTime(file.savedAt)}</span><span>{formatSize(file.sizeBytes)}</span><span>{formatDuration(file.durationMs)}</span></span>
            </button>
            <label className="file-checkbox" title="Выбрать файл"><input type="checkbox" checked={selectedForDeletion.includes(file.id)} onChange={() => toggleDeletionSelection(file.id)} /><span /></label>
          </div>)}
          {!files.length && <p className="empty">{error || "файлы не найдены"}</p>}
          {loading && <p className="loading">загрузка...</p>}
        </nav>
        {selectedForDeletion.length > 0 && <div className="selection-actions">
          <span>Выбрано {selectedForDeletion.length} / {pagination.totalItems} · {formatSize(selectedSizeBytes)}</span>
          <div><button className="clear-selection" onClick={() => setSelectedForDeletion([])} disabled={deleting}>Снять выделение</button><button className="delete-files" onClick={() => void deleteSelected()} disabled={deleting}>{deleting ? "Удаление..." : "Удалить"}</button></div>
        </div>}
        <div className="file-summary"><i /><span>{pagination.totalItems} файлов</span><span>·</span><span>{formatSize(pagination.totalSizeBytes)}</span></div>
      </aside>
      <main className="content">
        {!selected ? <div className="no-selection">{error ? `API: ${error}` : "Нет аудиофайлов"}</div> : <>
        <div className="file-header">{editingAlias
          ? <input className="alias-editor" value={aliasDraft} maxLength={160} autoFocus disabled={aliasSaving} onChange={(event) => setAliasDraft(event.target.value)} onBlur={() => { if (!aliasSaving) setEditingAlias(false); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void saveAlias(); } else if (event.key === "Escape") setEditingAlias(false); }} aria-label="Alias записи" />
          : <h1 title={`${selected.alias ? `${selected.filename}\n` : ""}Двойной клик для изменения alias`} onDoubleClick={beginAliasEdit}>{displayName(selected)}</h1>}
          <div><span>{formatDateTime(selected.savedAt)}</span><i /><span>{formatDuration(selected.durationMs)}</span><i /><span>{formatSize(selected.sizeBytes)}</span></div></div>
        <div className="tabs" role="tablist">
          {([["audio", "♪", "Аудио"], ["transcription", "≡", "Транскрипция"], ["review", "★", "Ревью"]] as [Tab, string, string][]).map(([key, icon, label]) => {
            const disabled = key !== "audio" && !selected.isReviewed;
            return <button key={key} className={tab === key ? "active" : ""} onClick={() => setTab(key)} role="tab" aria-selected={tab === key} disabled={disabled} title={disabled ? "Транскрипция и ревью готовятся в процессе AI-обработки" : undefined}><span>{icon}</span>{label}</button>;
          })}
        </div>
        <div className="tab-content">
          {tab === "audio" && <div className="column">
            <section className="player">
              <div ref={waveformRef} className="waveform" aria-hidden="true">{waveform.map((h, i) => <i key={i} style={{ height: h }} />)}</div>
              <div className="controls">
                <button className={`play ${playing ? "playing" : ""}`} onClick={() => void toggleAudio()} aria-label={playing ? "Пауза" : "Воспроизвести"}>{playing ? <><i /><i /></> : <span />}</button>
                <div className="timeline">
                  <input aria-label="Позиция воспроизведения" type="range" min="0" max={selected.durationMs} value={Math.min(currentMs, selected.durationMs)} onChange={(event) => { const value = Number(event.target.value); setCurrentMs(value); if (audioRef.current) audioRef.current.currentTime = value / 1000; }} style={{ "--progress": `${selected.durationMs ? currentMs / selected.durationMs * 100 : 0}%` } as CSSProperties} />
                  <small><span>{formatDuration(currentMs)}</span><span>{formatDuration(selected.durationMs)}</span></small>
                </div><span className="speed">1×</span>
              </div>
              <audio key={selected.id} ref={audioRef} src={`/api/audio-files/${selected.id}/audio`} preload="metadata" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onTimeUpdate={(event) => setCurrentMs(event.currentTarget.currentTime * 1000)} />
              <div className="audio-path">
                <span title={`/home/igormeshalkin/voice-commander/audio/${selected.filename}`}>/audio/{selected.filename}</span>
                <button onClick={copyPath} title={copiedPath ? "Скопировано" : "Копировать полный путь"} aria-label="Копировать полный путь"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" /><path d="M10.5 5.5V3.75A1.25 1.25 0 0 0 9.25 2.5h-5.5A1.25 1.25 0 0 0 2.5 3.75v5.5a1.25 1.25 0 0 0 1.25 1.25H5.5" stroke="currentColor" strokeLinecap="round" /></svg></button>
              </div>
            </section>
            <section className="details">
              <div><small>ID</small><span className="id-value"><span title={selected.id}>{shortId(selected.id)}</span><button onClick={copyId} title={copiedId ? "Скопировано" : "Копировать полный ID"} aria-label="Копировать полный ID"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" /><path d="M10.5 5.5V3.75A1.25 1.25 0 0 0 9.25 2.5h-5.5A1.25 1.25 0 0 0 2.5 3.75v5.5a1.25 1.25 0 0 0 1.25 1.25H5.5" stroke="currentColor" strokeLinecap="round" /></svg></button></span></div>
              {[["Длительность", formatDuration(selected.durationMs)], ["Размер", formatSize(selected.sizeBytes)], ["Дата записи", formatDateTime(selected.savedAt)]].map(([label, value]) => <div key={label}><small>{label}</small><span>{value}</span></div>)}
            </section>
          </div>}
          {tab === "transcription" && (selected.isReviewed ? <Document source={content[selected.id]?.transcription ?? ""} loading={contentLoading} /> : <Document source="# Транскрипция\n\nAI-обработка ещё не завершена." loading={false} />)}
          {tab === "review" && (selected.isReviewed ? <div className="review-layout">
            <Document source={content[selected.id]?.review ?? ""} loading={contentLoading} />
            <section className="task-proposals">
              <div className="proposal-heading"><div><small>AI</small><h2>Предложения по созданию задач</h2></div><span>{taskProposals[selected.id]?.length ?? 0}</span></div>
              {contentLoading ? <p className="proposal-empty">Загрузка...</p> : (taskProposals[selected.id] ?? []).length ? (taskProposals[selected.id] ?? []).map((proposal, index) => {
                const proposalKey = `${selected.id}:${index}`;
                const created = createdProposals.includes(proposalKey);
                return <article className="proposal-card" key={proposalKey}>
                  <h3>{proposal.title}</h3>
                  <p>{proposal.description}</p>
                  {(proposal.scheduledAt || proposal.deadlineAt) && <div className="proposal-dates">
                    {proposal.scheduledAt && <span><small>Желательно</small>{formatDateTime(proposal.scheduledAt)}</span>}
                    {proposal.deadlineAt && <span><small>Дедлайн</small>{formatDateTime(proposal.deadlineAt)}</span>}
                  </div>}
                  {!!proposal.links.length && <div className="proposal-links">{proposal.links.map((link) => <span key={link}>{link}</span>)}</div>}
                  <button disabled={created} onClick={() => openTaskProposal(proposal, index)}>{created ? "Создано" : "Создать"}</button>
                </article>;
              }) : <p className="proposal-empty">В этой записи предложения задач не найдены.</p>}
            </section>
          </div> : <Document source="# Review\n\nРевью ещё не сформировано." loading={false} />)}
        </div>
        </>}
      </main>
    </div> : <TasksPage onOpenAudio={(audioFileId) => {
      setSelectedId(audioFileId);
      setTab("audio");
      setActivePage("files");
      void fetch(`/api/audio-files/${audioFileId}`).then((response) => response.ok ? response.json() as Promise<AudioFile> : null).then((file) => {
        if (file) setFiles((current) => current.some((item) => item.id === file.id) ? current : [file, ...current]);
      });
    }} />}
    {taskDraft && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !taskSaving) setTaskDraft(null); }}>
      <form className="task-modal" onSubmit={(event) => { event.preventDefault(); void createTask(); }}>
        <div className="modal-title"><div><small>Новая задача</small><h2>Создание Task</h2></div><button type="button" aria-label="Закрыть" disabled={taskSaving} onClick={() => setTaskDraft(null)}>×</button></div>
        <label><span>Название</span><input required maxLength={160} value={taskDraft.title} onChange={(event) => setTaskDraft({ ...taskDraft, title: event.target.value })} /></label>
        <label><span>Описание</span><textarea required maxLength={4000} rows={5} value={taskDraft.description} onChange={(event) => setTaskDraft({ ...taskDraft, description: event.target.value })} /></label>
        <label><span>Ссылки <small>по одной на строку</small></span><textarea rows={3} value={taskDraft.links} onChange={(event) => setTaskDraft({ ...taskDraft, links: event.target.value })} /></label>
        <div className="task-date-fields">
          <label><span>Желательно выполнить</span><input type="datetime-local" value={taskDraft.scheduledAt} onChange={(event) => setTaskDraft({ ...taskDraft, scheduledAt: event.target.value })} /></label>
          <label><span>Дедлайн</span><input type="datetime-local" value={taskDraft.deadlineAt} onChange={(event) => setTaskDraft({ ...taskDraft, deadlineAt: event.target.value })} /></label>
        </div>
        <label className="estimate-field">
          <span><span>Оценка длительности</span><strong>{formatEstimate(taskDraft.estimateDays)}</strong></span>
          <input type="range" min="0" max="15" step="1" value={taskDraft.estimateDays} onChange={(event) => setTaskDraft({ ...taskDraft, estimateDays: Number(event.target.value) })} style={{ "--estimate-progress": `${taskDraft.estimateDays / 15 * 100}%` } as CSSProperties} />
          <div className="estimate-scale"><span>менее часа</span>{Array.from({ length: 14 }, (_, index) => <i key={index} />)}<span>14 дней</span></div>
        </label>
        <div className="modal-actions"><button type="button" disabled={taskSaving} onClick={() => setTaskDraft(null)}>Отмена</button><button type="submit" disabled={taskSaving || !taskDraft.title.trim() || !taskDraft.description.trim()}>{taskSaving ? "Сохранение..." : "Сохранить задачу"}</button></div>
      </form>
    </div>}
  </div>;
}
