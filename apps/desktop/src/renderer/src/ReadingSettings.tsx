import { Type } from "lucide-react";
import { Button, Popover, Segment, Segmented, Switch, ToolbarButton, cx, DialogTrigger } from "@read/ui";
import { DEFAULT_PREFS, SIZES, type ReadingPrefs } from "./readingPrefs";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="grid grid-cols-[78px_minmax(0,1fr)] items-center gap-2.5"><span className="text-[12.5px] font-medium text-label-2">{label}</span>{children}</div>;
}

/** The Aa popover. Every control changes the page live; the values apply to every material. */
export function ReadingSettings({ prefs, onChange }: { prefs: ReadingPrefs; onChange: (next: ReadingPrefs) => void }) {
  const set = <K extends keyof ReadingPrefs>(key: K, value: ReadingPrefs[K]) => onChange({ ...prefs, [key]: value });
  const sizeIndex = SIZES.indexOf(prefs.size);
  return (
    <DialogTrigger>
      <ToolbarButton aria-label="Reading settings"><Type /></ToolbarButton>
      <Popover placement="bottom end" className="w-[340px]" aria-label="Reading settings">
        <div className="grid gap-3">
          <Row label="Typeface">
            <div className="grid grid-cols-3 gap-1.5">
              {([["sans", "SF Pro", "font-sans"], ["serif", "New York", "font-serif"], ["mono", "Mono", "font-mono"]] as const).map(([key, name, cls]) => (
                <Button key={key} variant="default" aria-label={name} aria-pressed={prefs.font === key} onPress={() => set("font", key)} className={cx("h-auto flex-col gap-0.5 rounded-xl bg-content py-2 shadow-[0_1px_2px_rgba(15,17,21,.05)]", prefs.font === key && "shadow-[inset_0_0_0_1.5px_var(--accent),0_1px_2px_rgba(15,17,21,.05)]")}>
                  <b className={cx("text-[22px] font-medium leading-6", cls)}>Aa</b>
                  <small className={cx("text-[11.5px]", prefs.font === key ? "text-accent-text" : "text-label-3")}>{name}</small>
                </Button>
              ))}
            </div>
          </Row>
          <Row label="Size">
            <div className="inline-flex items-center rounded-pill bg-fill p-0.5">
              <Button variant="quiet" size="sm" isDisabled={sizeIndex <= 0} onPress={() => set("size", SIZES[sizeIndex - 1] ?? prefs.size)} aria-label="Smaller">A</Button>
              <span className="min-w-[54px] text-center text-[12.5px] font-medium tabular-nums text-label-2">{prefs.size} px</span>
              <Button variant="quiet" size="sm" isDisabled={sizeIndex >= SIZES.length - 1} onPress={() => set("size", SIZES[sizeIndex + 1] ?? prefs.size)} aria-label="Larger" className="text-[16px]">A</Button>
            </div>
          </Row>
          <Row label="Measure"><Segmented aria-label="Measure" className="flex" selectedKeys={[prefs.measure]} onSelectionChange={(keys) => { const k = [...keys][0]; if (k) set("measure", k as ReadingPrefs["measure"]); }}><Segment id="narrow" className="flex-1">Narrow</Segment><Segment id="normal" className="flex-1">Normal</Segment><Segment id="wide" className="flex-1">Wide</Segment></Segmented></Row>
          <Row label="Line height"><Segmented aria-label="Line height" className="flex" selectedKeys={[prefs.lineHeight]} onSelectionChange={(keys) => { const k = [...keys][0]; if (k) set("lineHeight", k as ReadingPrefs["lineHeight"]); }}><Segment id="tight" className="flex-1">Tight</Segment><Segment id="comfortable" className="flex-1">Comfortable</Segment><Segment id="loose" className="flex-1">Loose</Segment></Segmented></Row>
          <Row label="Theme"><Segmented aria-label="Theme" className="flex" selectedKeys={[prefs.theme]} onSelectionChange={(keys) => { const k = [...keys][0]; if (k) set("theme", k as ReadingPrefs["theme"]); }}><Segment id="light" className="flex-1">Light</Segment><Segment id="dark" className="flex-1">Dark</Segment><Segment id="system" className="flex-1">System</Segment></Segmented></Row>
          <Row label="Justify"><Switch isSelected={prefs.justify} onChange={(v) => set("justify", v)} aria-label="Justify text" /></Row>
          <Row label="Focus mode"><div className="flex items-center gap-2.5"><Switch isSelected={prefs.focus} onChange={(v) => set("focus", v)} aria-label="Focus mode" /><span className="text-[11.5px] text-label-3">Hides the inspector and the progress line</span></div></Row>
          <div className="flex items-center justify-between pt-1 text-[11.5px] text-label-3"><span>Applies to every material</span><Button variant="plain" size="sm" onPress={() => onChange(DEFAULT_PREFS)}>Reset</Button></div>
        </div>
      </Popover>
    </DialogTrigger>
  );
}
