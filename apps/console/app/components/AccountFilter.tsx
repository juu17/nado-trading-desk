"use client";

import { Button, Checkbox, Popover } from "@cloudflare/kumo";
import { CaretDownIcon } from "@phosphor-icons/react";
import type { AccountOption } from "@farm/ui";
import { AccountKindBadge } from "./AccountKindBadge";

interface Props {
  options: AccountOption[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}

/** The Account multi-checkbox dropdown (filters ALL accounts — HD and PK): a Kumo Popover anchored to a
 *  secondary Button, holding All / None buttons and one Kumo Checkbox per account. Not a DropdownMenu:
 *  its CheckboxItem draws nothing for an unchecked row (only a check mark when checked), so the list
 *  stopped reading as checkboxes; a Popover keeps real, always-visible checkboxes. Base UI handles
 *  dismissal, focus and Escape (no hand-rolled outside-click listener). */
export function AccountFilter({ options, selected, onChange }: Props) {
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChange(next);
  };

  const label = selected.size === options.length ? "All accounts"
    : selected.size === 0 ? "No accounts"
    : `${selected.size} of ${options.length} accounts`;

  return (
    <Popover>
      <Popover.Trigger
        render={
          <Button variant="secondary" className="w-full justify-between">
            <span className="truncate">{label}</span>
            <CaretDownIcon />
          </Button>
        }
      />
      {/* Trigger-width (Base UI's --anchor-width), start-aligned, like the field it drops from. */}
      <Popover.Content align="start" sideOffset={4} className="flex w-(--anchor-width) flex-col gap-2 p-2">
        <div className="flex gap-1">
          <Button size="xs" variant="secondary" onClick={() => onChange(new Set(options.map((o) => o.id)))}>All</Button>
          <Button size="xs" variant="secondary" onClick={() => onChange(new Set())}>None</Button>
        </div>
        {/* py-0.5 absorbs a 1px sub-pixel overflow that otherwise raises the auto scrollbar on one row. */}
        <ul className="flex max-h-80 flex-col gap-0.5 overflow-y-auto py-0.5">
          {options.map((o) => (
            <li key={o.id} className="flex items-center justify-between gap-2 rounded-sm px-1 py-1 hover:bg-kumo-tint">
              <Checkbox checked={selected.has(o.id)} onCheckedChange={() => toggle(o.id)} label={o.name} />
              <span className="flex shrink-0 items-center gap-1 tabular-nums text-kumo-subtle">
                <AccountKindBadge kind={o.kind}>{o.kind}</AccountKindBadge>
                {o.count}
              </span>
            </li>
          ))}
        </ul>
      </Popover.Content>
    </Popover>
  );
}
