"use client";

import { Button, ButtonGroup, Checkbox, Input } from "@cloudflare/kumo";
import type { FormModel, ParamValue } from "@farm/adapter-api";

/** Renders a FormModel (built by renderActionForm from a manifest schema) into Kumo controls —
 *  enum → a ButtonGroup of toggle Buttons (the app-wide single-select idiom: the selected option is
 *  variant="primary", i.e. the network brand), bool → Checkbox, else → Input.
 *  No per-protocol branching: the control is chosen by the param kind alone. */
export function DynamicForm({ model, values, onChange }: {
  model: FormModel;
  values: Record<string, ParamValue>;
  onChange: (id: string, v: ParamValue) => void;
}) {
  return (
    <>
      {model.fields.filter((f) => f.visible).map((f) => {
        const s = f.schema;
        const v = values[s.id];
        if (s.kind === "enum") {
          return (
            <div key={s.id} className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">{s.label}</span>
              <ButtonGroup aria-label={s.label}>
                {(s.options ?? []).map((o) => (
                  <Button
                    key={o.value}
                    size="xs"
                    variant={v === o.value ? "primary" : "secondary"}
                    aria-pressed={v === o.value}
                    onClick={() => onChange(s.id, o.value)}
                  >
                    {o.label}
                  </Button>
                ))}
              </ButtonGroup>
            </div>
          );
        }
        if (s.kind === "bool") {
          return <Checkbox key={s.id} label={s.label} checked={Boolean(v)} onCheckedChange={(c) => onChange(s.id, c === true)} />;
        }
        return (
          <Input
            key={s.id}
            size="sm"
            label={s.unit ? `${s.label} (${s.unit})` : s.label}
            value={String(v ?? "")}
            onChange={(e) => onChange(s.id, e.target.value)}
          />
        );
      })}
    </>
  );
}
