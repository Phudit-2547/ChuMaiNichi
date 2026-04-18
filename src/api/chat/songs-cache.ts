import { readFileSync } from "fs";
import { join } from "path";
import type { SongData } from "../../global/lib/maimai-rating";

let _songsCache: SongData[] | null = null;

export function loadSongs(): SongData[] {
  if (_songsCache) return _songsCache;
  try {
    _songsCache = JSON.parse(
      readFileSync(join(process.cwd(), "public", "maimai-songs.json"), "utf-8"),
    );
    return _songsCache!;
  } catch {
    return [];
  }
}
