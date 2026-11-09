import { describe, expect, it } from "vitest";
import { describeVessel } from "../src/crm/describe";

describe("describeVessel", () => {
  it("describes a boat with hull, year and engines", () => {
    expect(
      describeVessel({ kind: "barco_lancha", hull_type: "fibra_mono", boat_year: 2018, engine_count: "parelha", horsepower: 150 }),
    ).toBe("Barco/Lancha · Fibra mono casco · 2018 · 2×150 HP");
  });

  it("describes an outboard motor", () => {
    expect(describeVessel({ kind: "motor_popa", brand: "mercury", horsepower: 150, year: 2015 })).toBe(
      "Motor de Popa · Mercury 150 HP · 2015",
    );
  });

  it("describes a jet ski", () => {
    expect(describeVessel({ kind: "jet_ski", brand: "sea_doo", model: "GTI", year: 2020 })).toBe("Jet Ski · Sea-Doo GTI · 2020");
  });

  it("omits missing parts", () => {
    expect(describeVessel({ kind: "barco_lancha", horsepower: 90 })).toBe("Barco/Lancha · 90 HP");
    expect(describeVessel({ kind: "barco_lancha", hull_type: null, boat_year: null })).toBe("Barco/Lancha");
    expect(describeVessel({ kind: "jet_ski", model: "GTI" })).toBe("Jet Ski · GTI");
  });
});
