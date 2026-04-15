import { readFileSync } from "fs";
import { join } from "path";
import type { SongData } from "../../global/lib/rating";

let _songsCache: SongData[] | null = null;

export function loadSongs(): SongData[] {
  if (_songsCache) return _songsCache;
  try {
    _songsCache = JSON.parse(
      readFileSync(join(process.cwd(), "public", "songs.json"), "utf-8"),
    );
    return _songsCache!;
  } catch {
    return [];
  }
}
