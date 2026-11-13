// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/trpc", () => ({
  trpc: { study: { uploadAvatar: { useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }) } } },
}));
vi.mock("@/components/studyos/AiConnections", () => ({
  AiConnections: () => <section aria-label="AI Connections">Manage AI connections</section>,
}));

import { ProfileView } from "./Home";

describe("ProfileView", () => {
  it("renders the stored avatar URL in the dashboard profile card", () => {
    render(<ProfileView profile={{ name: "Alya", avatar: "/manus-storage/studyos/avatars/profile_uploaded.png" }} sessions={[]} timers={[]} activeSessionId={null} onProfileUpdate={vi.fn()} onDeleteTimer={vi.fn()} onOpenSession={vi.fn()} />);

    expect(screen.getByAltText("Profile")).toHaveAttribute("src", "/manus-storage/studyos/avatars/profile_uploaded.png");
    expect(screen.getByRole("region", { name: "AI Connections" })).toBeVisible();
  });
});
