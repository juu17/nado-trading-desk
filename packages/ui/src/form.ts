// =============================================================================
// @farm/ui · generic action form — builds a FormModel from a manifest's typed
// settings schema, with ZERO per-protocol branching. Fields whose capabilityGate
// is not implemented by the adapter are dropped; the rest render from pure data.
// =============================================================================
import type { SettingsSpec, ManifestCapabilities, OperationKind, FormModel, FormField } from "@farm/adapter-api";

export function renderActionForm(op: OperationKind, spec: SettingsSpec, caps: ManifestCapabilities): FormModel {
  void op; // reserved: a future refinement can scope fields per operation
  const fields: FormField[] = spec
    .filter((s) => !s.capabilityGate || caps.implemented.includes(s.capabilityGate))
    .map((s) => ({ schema: s, visible: true, value: s.default as FormField["value"] }));
  return { fields };
}
