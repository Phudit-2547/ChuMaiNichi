import { describe, expect, it, vi } from "vitest";
import {
  loadAndMigrateStoredMessages,
  messagesForStorage,
  parseStoredMessages,
  type UiMessage,
} from "../lib/history";

describe("ChatPanel history privacy", () => {
  it("drops legacy tool results while restoring conversation text", () => {
    const raw = JSON.stringify([
      { role: "user", content: "Total ONGEKI in 2026" },
      {
        role: "tool",
        name: "query_japan_activity",
        result: {
          rows: [{ source_paths: ["private/journal.md"] }],
          totals: { ongeki_tracks: 543 },
        },
      },
      { role: "assistant", content: "543 tracks" },
    ]);

    const restored = parseStoredMessages(raw);

    expect(restored).toEqual([
      { role: "user", content: "Total ONGEKI in 2026" },
      { role: "assistant", content: "543 tracks" },
    ]);
    expect(JSON.stringify(restored)).not.toMatch(
      /source_paths|private\/journal|"totals"/,
    );
  });

  it("never includes current-session tool entries in persisted history", () => {
    const messages: UiMessage[] = [
      { role: "user", content: "Show my data" },
      {
        role: "tool",
        name: "query_database",
        result: { rows: [{ private_value: "sentinel-secret" }] },
      },
      { role: "assistant", content: "Done", streaming: true },
    ];

    const stored = messagesForStorage(messages);

    expect(stored).toEqual([
      { role: "user", content: "Show my data" },
      { role: "assistant", content: "Done" },
    ]);
    expect(JSON.stringify(stored)).not.toContain("sentinel-secret");
  });

  it("rewrites legacy storage without tools and removes tool-only history", () => {
    const key = "chat-history";
    const storage = {
      getItem: vi.fn(() =>
        JSON.stringify([
          { role: "user", content: "Question" },
          { role: "tool", name: "query_database", result: { secret: 1 } },
        ]),
      ),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };

    expect(loadAndMigrateStoredMessages(storage, key)).toEqual([
      { role: "user", content: "Question" },
    ]);
    expect(storage.setItem).toHaveBeenCalledWith(
      key,
      JSON.stringify([{ role: "user", content: "Question" }]),
    );

    storage.getItem.mockReturnValueOnce(
      JSON.stringify([{ role: "tool", name: "query_database", result: {} }]),
    );
    expect(loadAndMigrateStoredMessages(storage, key)).toEqual([]);
    expect(storage.removeItem).toHaveBeenCalledWith(key);
  });
});
