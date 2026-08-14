import { describe, expect, it } from "vitest";
import { APP_CONFIG } from "./config";
import { suggestSongs } from "./maimai-suggest";
import type { PlayerData, SongData } from "./maimai-rating";

describe("maimai version config", () => {
  it("uses CiRCLE+ for the scraper and keeps CiRCLE/CiRCLE+ in the current rating bucket", () => {
    expect(APP_CONFIG.game_versions.maimai.scraper).toBe("CiRCLE+");
    expect(APP_CONFIG.game_versions.maimai.rating_current).toEqual([
      "CiRCLE",
      "CiRCLE+",
    ]);
  });

  it("classifies CiRCLE+ replacement candidates into the current bucket", () => {
    const songs: SongData[] = [
      {
        title: "Current weak",
        chartType: "dx",
        releasedVersion: "CiRCLE",
        master: { level: "1", constant: 1 },
      },
      {
        title: "CiRCLE+ candidate",
        chartType: "dx",
        releasedVersion: "CiRCLE+",
        master: { level: "15", constant: 15 },
      },
    ];
    const playerData: PlayerData = {
      current: [
        {
          title: "Current weak",
          chartType: "dx",
          difficulty: "master",
          score: 1005000,
        },
      ],
      allRecords: [
        {
          title: "CiRCLE+ candidate",
          chartType: "dx",
          difficulty: "master",
          score: 1000000,
        },
      ],
    };

    const result = suggestSongs(playerData, songs, { targetRating: 250 });
    if (result.mode !== "target") throw new Error("expected target mode");

    expect(result.moves).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "CiRCLE+ candidate",
          section: "current",
          type: "replace",
        }),
      ]),
    );
  });
});
