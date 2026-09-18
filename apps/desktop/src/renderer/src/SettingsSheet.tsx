import { useCallback, useEffect, useState } from "react";
import { Button, Kbd, NumberField, Segment, Segmented, Sheet, SheetDialog, Switch, TextField } from "@read/ui";
import type { AgentStatus, Settings } from "../../shared/contracts";
import { read } from "./api";
import { KEYBOARD_MAP } from "./keyboardMap";
import { ReadingControls } from "./ReadingSettings";
import { useReadingPrefs } from "./readingPrefs";

type Patch = Partial<Omit<Settings, "dataDirectory">>;
type Field = keyof Patch;
type FieldErrors = Partial<Record<Field, string>>;
export type SettingsSection = "reading" | "sources" | "agent" | "storage" | "keyboard";

const SECTIONS: { id: SettingsSection; title: string }[] = [
  { id: "reading", title: "Reading" }, { id: "sources", title: "Sources" }, { id: "agent", title: "Agent" }, { id: "storage", title: "Storage" }, { id: "keyboard", title: "Keyboard" },
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

function agentLine(status: AgentStatus | undefined, error: string | undefined): string {
  if (error) return error;
  if (!status) return "Checking the agent…";
  if (status.available) return `Codex ${status.version ?? ""}${status.account ? ` · ${status.account}` : ""}${status.busy ? " · answering" : ""}`.replace(/\s+/g, " ").trim();
  return status.reason ?? "The agent is not available.";
}

/**
 * ⌘, — every setting the app has, in one scrollable sheet. Reading prefs apply live (they are the
 * shared reading store); engine settings are saved per change with the engine's answer shown
 * under the field that caused it.
 */
export function SettingsSheet({ open, onClose, section }: { open: boolean; onClose: () => void; section?: SettingsSection | undefined }) {
  const [prefs, setPrefs] = useReadingPrefs();
  const [settings, setSettings] = useState<Settings | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saved, setSaved] = useState<Field | undefined>(undefined);
  const [agent, setAgent] = useState<AgentStatus | undefined>(undefined);
  const [agentError, setAgentError] = useState<string | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  // Text fields are edited locally and saved on blur / Enter, so a half-typed path is not rejected mid-way.
  const [drafts, setDrafts] = useState<{ codexPath: string; agentModel: string; syncIntervalMinutes: number }>({ codexPath: "", agentModel: "", syncIntervalMinutes: 30 });

  const refreshAgent = useCallback(async () => {
    try { setAgent(await read.agentStatus()); setAgentError(undefined); }
    catch (cause: unknown) { setAgentError(cause instanceof Error ? cause.message : "Could not reach the agent."); }
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadError(undefined); setErrors({}); setSaved(undefined); setCopied(false);
    read.getSettings()
      .then((loaded) => { if (cancelled) return; setSettings(loaded); setDrafts({ codexPath: loaded.codexPath, agentModel: loaded.agentModel, syncIntervalMinutes: loaded.syncIntervalMinutes }); })
      .catch((cause: unknown) => { if (!cancelled) setLoadError(cause instanceof Error ? cause.message : "Could not load the settings."); });
    void refreshAgent();
    return () => { cancelled = true; };
  }, [open, refreshAgent]);

  useEffect(() => {
    if (!open || !section) return;
    const frame = requestAnimationFrame(() => document.getElementById(`settings-${section}`)?.scrollIntoView({ block: "start" }));
    return () => cancelAnimationFrame(frame);
  }, [open, section, settings]);

  const save = async (field: Field, value: Patch[Field]) => {
    if (settings && settings[field] === value) return;
    setErrors((current) => ({ ...current, [field]: undefined }));
    try {
      const next = await read.updateSettings({ [field]: value } as Patch);
      setSettings(next);
      setDrafts({ codexPath: next.codexPath, agentModel: next.agentModel, syncIntervalMinutes: next.syncIntervalMinutes });
      setSaved(field);
      if (field === "codexPath" || field === "agentModel" || field === "agentReasoningEffort") void refreshAgent();
    } catch (cause: unknown) {
      setErrors((current) => ({ ...current, [field]: cause instanceof Error ? cause.message : `Could not save ${field}.` }));
    }
  };
  const login = async () => {
    try { setAgent(await read.agentLogin()); setAgentError(undefined); }
    catch (cause: unknown) { setAgentError(cause instanceof Error ? cause.message : "Signing in failed."); }
  };
  const copyDirectory = async () => {
    if (!settings) return;
    await navigator.clipboard.writeText(settings.dataDirectory);
    setCopied(true);
  };
  const savedNote = (field: Field) => (saved === field && !errors[field] ? "Saved." : undefined);
  const needsSignIn = agent !== undefined && !agent.available && /sign in|log in|login/i.test(agent.reason ?? "");
  const enterSaves = (field: "codexPath" | "agentModel") => (event: React.KeyboardEvent) => { if (event.key === "Enter") { event.preventDefault(); void save(field, drafts[field]); } };

  return (
    <Sheet isOpen={open} onOpenChange={(next) => { if (!next) onClose(); }} size="lg">
      <SheetDialog title="Settings" className="max-h-[84vh] gap-3">
        <nav aria-label="Sections" className="flex flex-wrap gap-1">
          {SECTIONS.map((entry) => <a key={entry.id} href={`#settings-${entry.id}`} className="rounded-pill px-2.5 py-1 text-[12.5px] font-medium text-label-2 no-underline hover:bg-fill hover:text-label" onClick={(event) => { event.preventDefault(); document.getElementById(`settings-${entry.id}`)?.scrollIntoView({ block: "start", behavior: "smooth" }); }}>{entry.title}</a>)}
        </nav>
        <div className="list-scroll -mx-6 grid min-h-0 gap-5 overflow-y-auto px-6 pb-2 pt-1">
          {loadError ? <p role="alert" className="m-0 rounded-card bg-red-soft px-3 py-2 text-[12.5px] text-red-text">{loadError}</p> : null}

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
                {needsSignIn ? <Button size="sm" variant="primary" onPress={() => void login()}>Sign in</Button> : null}
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
              {errors.agentReasoningEffort ? <p role="alert" className="m-0 text-[12px] text-red-text">{errors.agentReasoningEffort}</p> : null}
            </Row>
          </Section>

          <Section id="storage" title="Storage">
            <Row label="Raw page capture" hint="Keeps the page as fetched next to the record so the agent can rebuild it.">
              <div className="pt-1.5"><Switch aria-label="Keep raw page capture" isSelected={settings?.keepCapture ?? true} isDisabled={!settings} onChange={(value) => void save("keepCapture", value)}>{settings?.keepCapture ? "Kept" : "Discarded after extraction"}</Switch></div>
              {errors.keepCapture ? <p role="alert" className="m-0 text-[12px] text-red-text">{errors.keepCapture}</p> : null}
            </Row>
            <Row label="Data directory" hint="Materials, images and the database.">
              <button type="button" onClick={() => void copyDirectory()} disabled={!settings} className="cursor-default rounded-control bg-fill px-3 py-2 text-left font-mono text-[12px] leading-[17px] text-label outline-none break-all hover:bg-fill-2 focus-visible:ring-[3px] focus-visible:ring-accent-ring" title="Click to copy">
                {settings?.dataDirectory ?? "…"}
              </button>
              <span className="text-[11.5px] text-label-3">{copied ? "Copied." : "Click to copy the path."}</span>
            </Row>
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
        </div>
      </SheetDialog>
    </Sheet>
  );
}
