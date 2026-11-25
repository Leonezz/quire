import { Fragment, useEffect, useState } from "react";
import { Button, Kbd, NumberField, Segment, Segmented, Sheet, SheetDialog, Switch, TextField } from "@read/ui";
import type { AgentStatus, AsrModelStatus, AsrProvider, Settings, SettingsPatch, StorageUsage } from "../../shared/contracts";
import { AboutSection } from "./AboutSection";
import { FeedbackSection } from "./FeedbackSection";
import { agentStore, needsSignIn, useAgentStatus } from "./agentStore";
import { read } from "./api";
import { bytesLabel } from "./InfoFacts";
import { KEYBOARD_MAP } from "./keyboardMap";
import { ReadingControls } from "./ReadingSettings";
import { useReadingPrefs } from "./readingPrefs";

type Patch = SettingsPatch;
type Field = keyof Patch;
/** The one-line privacy note of the Jev judge, from the Settings contract. */
export const JEV_PRIVACY_NOTE = "Jev refines the blocks the rules are unsure about over the network; the page text of those blocks leaves the machine.";
type FieldErrors = Partial<Record<Field, string>>;
export type SettingsSection = "reading" | "sources" | "agent" | "transcription" | "storage" | "feedback" | "keyboard" | "about";

const SECTIONS: { id: SettingsSection; title: string }[] = [
  { id: "reading", title: "Reading" }, { id: "sources", title: "Sources" }, { id: "agent", title: "Agent" }, { id: "transcription", title: "Transcription" }, { id: "storage", title: "Storage" }, { id: "feedback", title: "Feedback" }, { id: "keyboard", title: "Keyboard" }, { id: "about", title: "About" },
];

function Section({ id, title, children }: { id: SettingsSection; title: string; children: React.ReactNode }) {
  return (
    <section id={`settings-${id}`} aria-labelledby={`settings-${id}-title`} className="grid gap-3 border-t border-separator-soft pt-4 first:border-t-0 first:pt-0">
      <h3 id={`settings-${id}-title`} className="m-0 text-[11px] font-semibold uppercase tracking-[.07em] text-label-3">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string | undefined; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[150px_minmax(0,1fr)] items-start gap-3">
      <div className="pt-2 text-[13px] font-medium text-label-2">{label}{hint ? <span className="mt-0.5 block text-[11.5px] font-normal text-label-3">{hint}</span> : null}</div>
      <div className="grid min-w-0 gap-1.5">{children}</div>
    </div>
  );
}

const USAGE_PARTS: { key: "materials" | "images" | "figures" | "database"; label: string }[] = [
  { key: "materials", label: "Materials" }, { key: "images", label: "Images" }, { key: "figures", label: "Figures" }, { key: "database", label: "Database" },
];

/** The data directory's bytes by part, then their total. */
function StorageUsageList({ usage }: { usage: StorageUsage }) {
  const extraParts: { label: string; bytes: number }[] = [
    ...(usage.media !== undefined ? [{ label: "Media", bytes: usage.media }] : []),
    ...(usage.models !== undefined ? [{ label: "Models", bytes: usage.models }] : []),
  ];
  const parts = [...USAGE_PARTS.map((part) => ({ label: part.label, bytes: usage[part.key] })), ...extraParts];
  const rows = [...parts, { label: "Total", bytes: parts.reduce((total, part) => total + part.bytes, 0) }];
  return (
    <dl aria-label="Storage used" className="m-0 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 pt-2 text-[13px]">
      {rows.map((row) => (
        <Fragment key={row.label}>
          <dt className={row.label === "Total" ? "font-medium text-label" : "text-label-2"}>{row.label}</dt>
          <dd className="m-0 text-right tabular-nums text-label">{bytesLabel(row.bytes)}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

function agentLine(status: AgentStatus | undefined, error: string | undefined): string {
  if (error) return error;
  if (!status) return "Checking the agent…";
  if (status.available) return `Codex ${status.version ?? ""}${status.account ? ` · ${status.account}` : ""}${status.reason ? ` · ${status.reason}` : ""}${status.running === 1 ? " · answering" : status.running > 1 ? ` · answering ${status.running}` : ""}`.replace(/\s+/g, " ").trim();
  return status.reason ?? "The agent is not available.";
}

/**
 * ⌘, — every setting the app has, in one scrollable sheet. Reading prefs apply live (they are the
 * shared reading store); engine settings are saved per change with the engine's answer shown
 * under the field that caused it.
 */
export function SettingsSheet({ open, onClose, section, onOpenLink }: { open: boolean; onClose: () => void; section?: SettingsSection | undefined; onOpenLink: (url: string) => void }) {
  const [prefs, setPrefs] = useReadingPrefs();
  const [settings, setSettings] = useState<Settings | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saved, setSaved] = useState<Field | undefined>(undefined);
  // The agent's status is the store's (the sidebar and every panel read the same one): saving the Codex path, model or
  // effort reads it again, and so does the bridge's own change notice, so the line flips without reopening the sheet.
  const { status: agent, statusError: agentError } = useAgentStatus();
  const refreshAgent = agentStore.refreshStatus;
  const [copied, setCopied] = useState(false);
  const [usage, setUsage] = useState<{ value?: StorageUsage; error?: string }>({});
  const [asrModelInfo, setAsrModelInfo] = useState<AsrModelStatus | undefined>(undefined);
  const [downloadingModel, setDownloadingModel] = useState(false);
  const [asrModelError, setAsrModelError] = useState<string | undefined>(undefined);
  const [asrTest, setAsrTest] = useState<{ busy?: boolean; ok?: string; error?: string } | undefined>(undefined);
  // Text fields are edited locally and saved on blur / Enter, so a half-typed path is not rejected mid-way.
  const [drafts, setDrafts] = useState<{
    codexPath: string;
    agentModel: string;
    syncIntervalMinutes: number;
    typesafeApiKey: string;
    asrBaseUrl: string;
    asrModel: string;
    asrApiKey: string;
  }>({
    codexPath: "",
    agentModel: "",
    syncIntervalMinutes: 30,
    typesafeApiKey: "",
    asrBaseUrl: "",
    asrModel: "",
    asrApiKey: "",
  });

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadError(undefined); setErrors({}); setSaved(undefined); setCopied(false); setUsage({});
    setAsrModelInfo(undefined); setAsrModelError(undefined); setAsrTest(undefined);
    read.getSettings()
      .then((loaded) => {
        if (cancelled) return;
        setSettings(loaded);
        setDrafts({
          codexPath: loaded.codexPath,
          agentModel: loaded.agentModel,
          syncIntervalMinutes: loaded.syncIntervalMinutes,
          typesafeApiKey: "",
          asrBaseUrl: loaded.asrBaseUrl ?? "",
          asrModel: loaded.asrModel ?? "",
          asrApiKey: "",
        });
        if (loaded.asrProvider === "local") {
          read.asrModelStatus().then((status) => { if (!cancelled) setAsrModelInfo(status); }).catch(() => undefined);
        }
      })
      .catch((cause: unknown) => { if (!cancelled) setLoadError(cause instanceof Error ? cause.message : "Could not load the settings."); });
    // Measured at every opening: deleting materials or reading new ones changes it between two.
    read.storageUsage()
      .then((value) => { if (!cancelled) setUsage({ value }); })
      .catch((cause: unknown) => { if (!cancelled) setUsage({ error: cause instanceof Error ? cause.message : "Could not measure the storage." }); });
    void refreshAgent();
    return () => { cancelled = true; };
  }, [open, refreshAgent]);

  useEffect(() => {
    if (!open || !section) return;
    const frame = requestAnimationFrame(() => document.getElementById(`settings-${section}`)?.scrollIntoView({ block: "start" }));
    return () => cancelAnimationFrame(frame);
  }, [open, section, settings]);

  const save = async (field: Field, value: Patch[Field]) => {
    if (field !== "typesafeApiKey" && field !== "asrApiKey" && settings && settings[field] === value) return;
    setErrors((current) => ({ ...current, [field]: undefined }));
    try {
      const next = await read.updateSettings({ [field]: value } as Patch);
      setSettings(next);
      // The key is write-only: once stored (or removed) the draft is cleared, never echoed back.
      setDrafts({
        codexPath: next.codexPath,
        agentModel: next.agentModel,
        syncIntervalMinutes: next.syncIntervalMinutes,
        typesafeApiKey: "",
        asrBaseUrl: next.asrBaseUrl ?? "",
        asrModel: next.asrModel ?? "",
        asrApiKey: "",
      });
      setSaved(field);
      if (field === "codexPath" || field === "agentModel" || field === "agentReasoningEffort") void refreshAgent();
      if (field === "asrProvider" || field === "localWhisperModel") {
        if (next.asrProvider === "local") {
          read.asrModelStatus().then(setAsrModelInfo).catch(() => undefined);
        }
      }
    } catch (cause: unknown) {
      setErrors((current) => ({ ...current, [field]: cause instanceof Error ? cause.message : `Could not save ${field}.` }));
    }
  };
  const login = agentStore.login;
  const copyDirectory = async () => {
    if (!settings) return;
    await navigator.clipboard.writeText(settings.dataDirectory);
    setCopied(true);
  };
  const savedNote = (field: Field) => (saved === field && !errors[field] ? "Saved." : undefined);
  const enterSaves = (field: "codexPath" | "agentModel" | "asrBaseUrl" | "asrModel") => (event: React.KeyboardEvent) => { if (event.key === "Enter") { event.preventDefault(); void save(field, drafts[field]); } };
  const storeKey = () => { if (drafts.typesafeApiKey.trim()) void save("typesafeApiKey", drafts.typesafeApiKey); };
  const storeAsrKey = () => { if (drafts.asrApiKey.trim()) void save("asrApiKey", drafts.asrApiKey); };
  const asrProvider: AsrProvider = settings?.asrProvider ?? "openai_compatible";

  const runAsrTest = async () => {
    if (!settings) return;
    setAsrTest({ busy: true });
    try {
      const pendingPatch: SettingsPatch = {};
      if (drafts.asrBaseUrl !== (settings.asrBaseUrl ?? "")) pendingPatch.asrBaseUrl = drafts.asrBaseUrl;
      if (drafts.asrModel !== (settings.asrModel ?? "")) pendingPatch.asrModel = drafts.asrModel;
      if (drafts.asrApiKey.trim()) pendingPatch.asrApiKey = drafts.asrApiKey;
      if (Object.keys(pendingPatch).length > 0) {
        const next = await read.updateSettings(pendingPatch);
        setSettings(next);
        setDrafts((current) => ({ ...current, asrBaseUrl: next.asrBaseUrl ?? "", asrModel: next.asrModel ?? "", asrApiKey: "" }));
      }
      const res = await read.testAsrConnection();
      setAsrTest({
        ok: `Connected (${res.latencyMs} ms · ${res.supportsVerboseJson ? "segment timestamps" : "chunk timestamps"})`,
      });
    } catch (cause: unknown) {
      setAsrTest({ error: cause instanceof Error ? cause.message : "Connection test failed." });
    }
  };

  const downloadWhisperModel = async () => {
    if (!settings) return;
    setDownloadingModel(true);
    setAsrModelError(undefined);
    try {
      const model = settings.localWhisperModel ?? "base";
      const status = await read.downloadAsrModel(model);
      setAsrModelInfo(status);
      read.storageUsage().then((value) => setUsage({ value })).catch(() => undefined);
    } catch (cause: unknown) {
      setAsrModelError(cause instanceof Error ? cause.message : "Could not download Whisper model.");
    } finally {
      setDownloadingModel(false);
    }
  };

  const clearCachedMedia = async () => {
    try {
      await read.clearMediaCache();
      const value = await read.storageUsage();
      setUsage({ value });
    } catch (cause: unknown) {
      setUsage({ error: cause instanceof Error ? cause.message : "Could not clear cached media." });
    }
  };

  return (
    <Sheet isOpen={open} onOpenChange={(next) => { if (!next) onClose(); }} size="lg">
      <SheetDialog title="Settings" className="max-h-[84vh] gap-3">
        <nav aria-label="Sections" className="flex flex-wrap gap-1">
          {SECTIONS.map((entry) => <a key={entry.id} href={`#settings-${entry.id}`} className="rounded-pill px-2.5 py-1 text-[12.5px] font-medium text-label-2 no-underline hover:bg-fill hover:text-label" onClick={(event) => { event.preventDefault(); document.getElementById(`settings-${entry.id}`)?.scrollIntoView({ block: "start", behavior: "smooth" }); }}>{entry.title}</a>)}
        </nav>
        <div className="list-scroll -mx-6 grid min-h-0 gap-5 overflow-y-auto px-6 pb-2 pt-1">
          {loadError ? <p role="alert" className="t-text-in m-0 rounded-card bg-red-soft px-3 py-2 text-[12.5px] text-red-text">{loadError}</p> : null}

          <Section id="reading" title="Reading">
            <ReadingControls prefs={prefs} onChange={setPrefs} />
          </Section>

          <Section id="sources" title="Sources">
            <Row label="Sync interval" hint="Minutes between two syncs of the same source (5–1440).">
              {/* The number field commits on blur, Enter and the steppers (never per keystroke), so its onChange is the save. */}
              <NumberField aria-label="Sync interval in minutes" value={drafts.syncIntervalMinutes} onChange={(value) => { setDrafts((current) => ({ ...current, syncIntervalMinutes: value })); void save("syncIntervalMinutes", value); }}
                formatOptions={{ maximumFractionDigits: 0 }} unit="min" isDisabled={!settings} errorMessage={errors.syncIntervalMinutes} description={savedNote("syncIntervalMinutes")} />
            </Row>
          </Section>

          <Section id="agent" title="Agent">
            <Row label="Status">
              <div className="flex flex-wrap items-center gap-2 pt-2 text-[13px] text-label">
                <span className={agentError ? "text-red-text" : ""}>{agentLine(agent, agentError)}</span>
                {needsSignIn(agent) ? <Button size="sm" variant="primary" onPress={() => void login()}>Sign in</Button> : null}
                <Button size="sm" variant="quiet" onPress={() => void refreshAgent()}>Check again</Button>
              </div>
            </Row>
            <Row label="Codex path" hint="Empty auto-detects the codex binary on PATH.">
              <TextField aria-label="Codex path" placeholder="auto-detect" value={drafts.codexPath} onChange={(value) => setDrafts((current) => ({ ...current, codexPath: value }))} onBlur={() => void save("codexPath", drafts.codexPath)} onKeyDown={enterSaves("codexPath")}
                isDisabled={!settings} errorMessage={errors.codexPath} description={savedNote("codexPath")} />
            </Row>
            <Row label="Model" hint="Empty uses Codex's own default.">
              <TextField aria-label="Model" placeholder="Codex default" value={drafts.agentModel} onChange={(value) => setDrafts((current) => ({ ...current, agentModel: value }))} onBlur={() => void save("agentModel", drafts.agentModel)} onKeyDown={enterSaves("agentModel")}
                isDisabled={!settings} errorMessage={errors.agentModel} description={savedNote("agentModel")} />
            </Row>
            <Row label="Reasoning effort">
              <Segmented aria-label="Reasoning effort" selectedKeys={[settings?.agentReasoningEffort === "" ? "none" : (settings?.agentReasoningEffort ?? "none")]} isDisabled={!settings}
                onSelectionChange={(keys) => { const key = [...keys][0]; if (key !== undefined) void save("agentReasoningEffort", key === "none" ? "" : (key as Settings["agentReasoningEffort"])); }}>
                <Segment id="none">None</Segment><Segment id="low">Low</Segment><Segment id="medium">Medium</Segment><Segment id="high">High</Segment>
              </Segmented>
              {errors.agentReasoningEffort ? <p role="alert" className="t-text-in m-0 text-[12px] text-red-text">{errors.agentReasoningEffort}</p> : null}
            </Row>
            <Row label="TypeSafe API key" hint="Kept encrypted on this machine; used only by the PDF reflow judge.">
              {settings?.typesafeApiKeySet ? (
                <div className="flex flex-wrap items-center gap-2 pt-2 text-[13px] text-label">
                  <span>Key stored</span>
                  <Button size="sm" variant="quiet" onPress={() => void save("typesafeApiKey", "")}>Remove</Button>
                </div>
              ) : (
                <TextField aria-label="TypeSafe API key" type="password" placeholder="Paste the key and press Enter" value={drafts.typesafeApiKey} onChange={(value) => setDrafts((current) => ({ ...current, typesafeApiKey: value }))}
                  onBlur={storeKey} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); storeKey(); } }} isDisabled={!settings} />
              )}
              {errors.typesafeApiKey ? <p role="alert" className="t-text-in m-0 text-[12px] text-red-text">{errors.typesafeApiKey}</p> : savedNote("typesafeApiKey") ? <p className="m-0 text-[11.5px] text-label-3">{savedNote("typesafeApiKey")}</p> : null}
            </Row>
            <Row label="PDF reflow judge" hint={JEV_PRIVACY_NOTE}>
              <Segmented aria-label="PDF reflow judge" selectedKeys={[settings?.reflowJudge ?? "rules"]} isDisabled={!settings}
                onSelectionChange={(keys) => { const key = [...keys][0]; if (key === "rules" || key === "jev") void save("reflowJudge", key); }}>
                <Segment id="rules">Rules</Segment><Segment id="jev" isDisabled={!settings?.typesafeApiKeySet}>Jev</Segment>
              </Segmented>
              {!settings?.typesafeApiKeySet ? <span className="text-[11.5px] text-label-3">Jev needs a stored TypeSafe API key.</span> : null}
              {errors.reflowJudge ? <p role="alert" className="t-text-in m-0 text-[12px] text-red-text">{errors.reflowJudge}</p> : null}
            </Row>
          </Section>

          <Section id="transcription" title="Transcription">
            <Row label="Provider" hint="Used when a podcast episode or video has no publisher transcript.">
              <Segmented aria-label="Transcription provider" selectedKeys={[asrProvider]} isDisabled={!settings}
                onSelectionChange={(keys) => { const key = [...keys][0]; if (key === "local" || key === "openai_compatible") void save("asrProvider", key); }}>
                <Segment id="openai_compatible">OpenAI Compatible</Segment>
                <Segment id="local">Built-in Local</Segment>
              </Segmented>
              {errors.asrProvider ? <p role="alert" className="t-text-in m-0 text-[12px] text-red-text">{errors.asrProvider}</p> : null}
            </Row>
            {asrProvider === "openai_compatible" ? (
              <>
                <Row label="ASR base URL" hint="HTTPS endpoint, or http://localhost for local whisper.cpp / mlx-audio.">
                  <TextField aria-label="ASR base URL" placeholder="https://api.groq.com/openai/v1" value={drafts.asrBaseUrl}
                    onChange={(value) => { setDrafts((current) => ({ ...current, asrBaseUrl: value })); setAsrTest(undefined); }}
                    onBlur={() => void save("asrBaseUrl", drafts.asrBaseUrl)} onKeyDown={enterSaves("asrBaseUrl")}
                    isDisabled={!settings} errorMessage={errors.asrBaseUrl} description={savedNote("asrBaseUrl")} />
                </Row>
                <Row label="ASR model" hint="Model sent to /audio/transcriptions.">
                  <TextField aria-label="ASR model" placeholder="whisper-large-v3-turbo" value={drafts.asrModel}
                    onChange={(value) => { setDrafts((current) => ({ ...current, asrModel: value })); setAsrTest(undefined); }}
                    onBlur={() => void save("asrModel", drafts.asrModel)} onKeyDown={enterSaves("asrModel")}
                    isDisabled={!settings} errorMessage={errors.asrModel} description={savedNote("asrModel")} />
                </Row>
                <Row label="ASR API key" hint="Stored encrypted in the macOS Keychain; optional for localhost.">
                  {settings?.asrApiKeySet ? (
                    <div className="flex flex-wrap items-center gap-2 pt-2 text-[13px] text-label">
                      <span>ASR key stored</span>
                      <Button size="sm" variant="quiet" onPress={() => void save("asrApiKey", "")}>Remove ASR key</Button>
                    </div>
                  ) : (
                    <TextField aria-label="ASR API key" type="password" placeholder="Paste key (optional for localhost)" value={drafts.asrApiKey}
                      onChange={(value) => { setDrafts((current) => ({ ...current, asrApiKey: value })); setAsrTest(undefined); }}
                      onBlur={storeAsrKey} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); storeAsrKey(); } }}
                      isDisabled={!settings} />
                  )}
                  {errors.asrApiKey ? <p role="alert" className="t-text-in m-0 text-[12px] text-red-text">{errors.asrApiKey}</p> : savedNote("asrApiKey") ? <p className="m-0 text-[11.5px] text-label-3">{savedNote("asrApiKey")}</p> : null}
                </Row>
                <Row label="Connection">
                  <div className="flex flex-wrap items-center gap-2 pt-1.5 text-[12.5px]">
                    <Button size="sm" isDisabled={!settings || asrTest?.busy === true} onPress={() => void runAsrTest()}>
                      {asrTest?.busy ? "Testing…" : "Test connection"}
                    </Button>
                    {asrTest?.ok ? <span role="status" className="text-label-2">{asrTest.ok}</span> : null}
                    {asrTest?.error ? <span role="alert" className="text-red-text">{asrTest.error}</span> : null}
                  </div>
                </Row>
              </>
            ) : (
              <Row label="Whisper model" hint="GGUF weights stored locally in the data directory.">
                <Segmented aria-label="Local Whisper model" selectedKeys={[settings?.localWhisperModel ?? "base"]} isDisabled={!settings}
                  onSelectionChange={(keys) => { const key = [...keys][0]; if (typeof key === "string") void save("localWhisperModel", key); }}>
                  <Segment id="base">Base</Segment>
                  <Segment id="small">Small</Segment>
                  <Segment id="large-v3-turbo">Large v3 Turbo</Segment>
                </Segmented>
                <div className="flex flex-wrap items-center gap-2 pt-1 text-[12.5px] text-label-2">
                  <span>
                    {asrModelInfo?.downloaded
                      ? `Downloaded${asrModelInfo.sizeBytes ? ` (${bytesLabel(asrModelInfo.sizeBytes)})` : ""}${asrModelInfo.localRuntimeReady ? " · whisper-cli ready" : " · install whisper-cli to run"}`
                      : "Weights not downloaded yet."}
                  </span>
                  {!asrModelInfo?.downloaded ? (
                    <Button size="sm" isDisabled={!settings || downloadingModel} onPress={() => void downloadWhisperModel()}>
                      {downloadingModel ? "Downloading…" : "Download model"}
                    </Button>
                  ) : null}
                </div>
                {asrModelError ? <p role="alert" className="t-text-in m-0 text-[12px] text-red-text">{asrModelError}</p> : null}
              </Row>
            )}
          </Section>

          <Section id="storage" title="Storage">
            <Row label="Raw page capture" hint="Keeps the page as fetched next to the record so the agent can rebuild it.">
              <div className="pt-1.5"><Switch aria-label="Keep raw page capture" isSelected={settings?.keepCapture ?? true} isDisabled={!settings} onChange={(value) => void save("keepCapture", value)}>{settings?.keepCapture ? "Kept" : "Discarded after extraction"}</Switch></div>
              {errors.keepCapture ? <p role="alert" className="t-text-in m-0 text-[12px] text-red-text">{errors.keepCapture}</p> : null}
            </Row>
            <Row label="Cached media" hint="Offline audio and video files downloaded for reading without the network.">
              <div className="pt-1.5"><Switch aria-label="Remove cached media after finishing" isSelected={settings?.removeCachedMediaAfterFinish ?? false} isDisabled={!settings} onChange={(value) => void save("removeCachedMediaAfterFinish", value)}>{settings?.removeCachedMediaAfterFinish ? "Removed after finishing" : "Kept until cleared"}</Switch></div>
              {errors.removeCachedMediaAfterFinish ? <p role="alert" className="t-text-in m-0 text-[12px] text-red-text">{errors.removeCachedMediaAfterFinish}</p> : null}
            </Row>
            <Row label="Data directory" hint="Materials, images and the database.">
              <button type="button" onClick={() => void copyDirectory()} disabled={!settings} className="cursor-default rounded-control bg-fill px-3 py-2 text-left font-mono text-[12px] leading-[17px] text-label outline-none break-all hover:bg-fill-2 focus-visible:ring-[3px] focus-visible:ring-accent-ring" title="Click to copy">
                {settings?.dataDirectory ?? "…"}
              </button>
              <span className="text-[11.5px] text-label-3">{copied ? "Copied." : "Click to copy the path."}</span>
            </Row>
            <Row label="Storage used" hint="Materials are records, captured pages, PDFs and views; images are cached pictures.">
              {usage.value ? (
                <>
                  <StorageUsageList usage={usage.value} />
                  {(usage.value.media ?? 0) > 0 ? (
                    <div className="pt-1">
                      <Button size="sm" variant="quiet" onPress={() => void clearCachedMedia()}>Clear cached media</Button>
                    </div>
                  ) : null}
                </>
              )
                : usage.error ? <p role="alert" className="t-text-in m-0 pt-2 text-[12px] text-red-text">{usage.error}</p>
                : <span className="pt-2 text-[13px] text-label-3">Measuring…</span>}
            </Row>
          </Section>

          <Section id="feedback" title="Feedback">
            <FeedbackSection onOpenLink={onOpenLink} />
          </Section>

          <Section id="keyboard" title="Keyboard">
            <div className="grid gap-4">
              {KEYBOARD_MAP.map((group) => (
                <table key={group.title} className="w-full border-collapse text-[13px]">
                  <caption className="mb-1 text-left text-[12px] font-semibold text-label-2">{group.title}</caption>
                  <tbody>
                    {group.shortcuts.map((shortcut) => (
                      <tr key={shortcut.keys} className="border-t border-separator-soft">
                        <td className="w-[150px] py-1.5 pr-3 align-top"><Kbd className="rounded-control bg-fill px-1.5 py-0.5 text-[11.5px] text-label">{shortcut.keys}</Kbd></td>
                        <td className="py-1.5 text-label-2">{shortcut.action}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ))}
            </div>
          </Section>

          <Section id="about" title="About">
            <AboutSection version={read.version} autoCheck={settings?.checkUpdatesAutomatically} disabled={!settings} onAutoCheck={(value) => void save("checkUpdatesAutomatically", value)}
              autoCheckError={errors.checkUpdatesAutomatically} autoCheckNote={savedNote("checkUpdatesAutomatically")} onOpenLink={onOpenLink} />
          </Section>
        </div>
      </SheetDialog>
    </Sheet>
  );
}
