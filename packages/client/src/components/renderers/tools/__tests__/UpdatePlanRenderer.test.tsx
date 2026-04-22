import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { updatePlanRenderer } from "../UpdatePlanRenderer";

const renderContext = {
  isStreaming: false,
  theme: "dark" as const,
};

describe("UpdatePlanRenderer", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders plan checklist inline with progress counts", () => {
    if (!updatePlanRenderer.renderInline) {
      throw new Error("UpdatePlan renderer must provide inline rendering");
    }

    render(
      <div>
        {updatePlanRenderer.renderInline(
          {
            explanation: "Resuming from previous checkpoint",
            plan: [
              { step: "Investigate renderer mismatch", status: "completed" },
              { step: "Add compatibility aliases", status: "in_progress" },
              { step: "Add regression tests", status: "pending" },
            ],
          },
          "Plan updated",
          false,
          "complete",
          renderContext,
        )}
      </div>,
    );

    expect(screen.getByText("1 out of 3 tasks completed")).toBeDefined();
    expect(screen.getByText("Resuming from previous checkpoint")).toBeDefined();
    expect(screen.getByText("1. Investigate renderer mismatch")).toBeDefined();
    expect(screen.getByText("2. Add compatibility aliases")).toBeDefined();
    expect(screen.getByText("3. Add regression tests")).toBeDefined();
  });

  it("renders an inline error message when tool call fails", () => {
    if (!updatePlanRenderer.renderInline) {
      throw new Error("UpdatePlan renderer must provide inline rendering");
    }

    render(
      <div>
        {updatePlanRenderer.renderInline(
          { plan: [{ step: "Do thing", status: "pending" }] },
          "Could not persist plan",
          true,
          "error",
          renderContext,
        )}
      </div>,
    );

    expect(screen.getByText("Could not persist plan")).toBeDefined();
  });
});
