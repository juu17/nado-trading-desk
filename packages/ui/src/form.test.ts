import { describe, it, expect } from "vitest";
import { renderActionForm } from "./form.js";
import type { SettingsSpec, ManifestCapabilities } from "@farm/adapter-api";

const spec: SettingsSpec = [
  { id: "market", label: "Market", kind: "enum", default: "a", options: [{ value: "a", label: "A" }] },
  { id: "side", label: "Side", kind: "enum", capabilityGate: "trading", options: [{ value: "buy", label: "Buy" }] },
  { id: "reserve", label: "Reserve", kind: "number", capabilityGate: "lending" },
];

describe("renderActionForm", () => {
  it("drops fields whose capability is not implemented", () => {
    const caps: ManifestCapabilities = { implemented: ["trading"], rewards: false };
    const model = renderActionForm("placeOrder", spec, caps);
    expect(model.fields.map((f) => f.schema.id)).toEqual(["market", "side"]); // lending field dropped
    expect(model.fields.every((f) => f.visible)).toBe(true);
    expect(model.fields.find((f) => f.schema.id === "market")?.value).toBe("a"); // default carried
  });

  it("keeps ungated + implemented-gated fields", () => {
    const caps: ManifestCapabilities = { implemented: ["trading", "lending"], rewards: false };
    expect(renderActionForm("placeOrder", spec, caps).fields).toHaveLength(3);
  });
});
