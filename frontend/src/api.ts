export type Status = "queued" | "downloading" | "separating" | "finishing" | "ready" | "error";

export interface SearchResult {
  id: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  thumbnail: string;
  thumb: string; // proxied, for display
  status: Status | null;
}

export interface Song {
  id: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  thumbnail: string;
  cover: string;
  status: Status;
  stage: string;
  progress: number;
  error: string;
  model: string;
  lyrics_synced: number;
  lyrics_source: string;
  has_video: number;
  has_cover: number;
  play_count: number;
  last_played_at: number | null;
  created_at: number;
  stems?: { instrumental: string; vocals: string };
  video?: string | null;
}

export interface LyricLine {
  t: number | null;
  end: number | null;
  text: string;
  words: { t: number; text: string }[];
}

export interface SongDetail extends Song {
  lyrics: LyricLine[];
  lyrics_raw: string;
  lyrics_offset: number;
  video_id: string;
}

export interface QueueEntry {
  id: number;
  song_id: string;
  singer: string;
  title: string;
  artist: string;
  cover: string;
  status: Status;
  stage: string;
  progress: number;
  duration: number;
}

export type BackgroundMode = "aurora" | "visualizer" | "cover" | "video" | "custom";

export interface Settings {
  model: string;
  device: string;
  mp3_bitrate: number;
  download_video: boolean;
  video_max_height: number;
  default_vocals: number;
  default_background: BackgroundMode;
  custom_background: string;
  lyrics_sources: string[];
  lyrics_font_scale: number;
  auto_advance: boolean;
  countdown_seconds: number;
  ytmusic_language: string;
  concurrent_jobs: number;
}

export interface ConfigResponse {
  settings: Settings;
  models: Record<string, string>;
  backgrounds: BackgroundMode[];
}

export interface Background {
  name: string;
  url: string;
  kind: "image" | "video";
}

export interface SystemInfo {
  version: string;
  yt_dlp: string;
  device: string;
  library_bytes: number;
  disk_free_bytes: number;
  cookies: boolean;
  processing: string | null;
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: {} };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["content-type"] = "application/json";
  }
  const res = await fetch(path, init);
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
    } catch {
      /* keep status text */
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export const api = {
  search: (q: string) => req<SearchResult[]>("GET", `/api/search?q=${encodeURIComponent(q)}`),
  songs: () => req<Song[]>("GET", "/api/songs"),
  song: (id: string) => req<SongDetail>("GET", `/api/songs/${id}`),
  add: (s: Partial<SearchResult> & { url?: string; singer?: string }) => req<Song>("POST", "/api/songs", s),
  patch: (id: string, p: { lyrics_offset?: number; title?: string; artist?: string }) =>
    req<SongDetail>("PATCH", `/api/songs/${id}`, p),
  remove: (id: string) => req("DELETE", `/api/songs/${id}`),
  reprocess: (id: string, model?: string, redownload = false) =>
    req<Song>("POST", `/api/songs/${id}/reprocess`, { model, redownload }),
  played: (id: string) => req("POST", `/api/songs/${id}/played`),
  setLyrics: (id: string, text: string) => req<SongDetail>("PUT", `/api/songs/${id}/lyrics`, { text }),
  refetchLyrics: (id: string) => req<SongDetail>("POST", `/api/songs/${id}/lyrics/refetch`),
  queue: () => req<QueueEntry[]>("GET", "/api/queue"),
  enqueue: (song_id: string, singer: string) => req<{ id: number }>("POST", "/api/queue", { song_id, singer }),
  dequeue: (id: number) => req("DELETE", `/api/queue/${id}`),
  reorder: (ids: number[]) => req("PUT", "/api/queue/order", { ids }),
  clearQueue: () => req("DELETE", "/api/queue"),
  config: () => req<ConfigResponse>("GET", "/api/config"),
  saveConfig: (p: Partial<Settings>) => req<ConfigResponse>("PUT", "/api/config", p),
  backgrounds: () => req<Background[]>("GET", "/api/backgrounds"),
  uploadBackground: (f: File) => {
    const fd = new FormData();
    fd.append("file", f);
    return req<{ name: string; url: string }>("POST", "/api/backgrounds", fd);
  },
  deleteBackground: (name: string) => req("DELETE", `/api/backgrounds/${encodeURIComponent(name)}`),
  system: () => req<SystemInfo>("GET", "/api/system"),
};

export function fmtTime(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export function fmtBytes(n: number): string {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

export const STAGE_LABEL: Record<string, string> = {
  download: "Downloading",
  model: "Fetching AI model",
  separate: "Separating vocals",
  lyrics: "Finding lyrics",
  video: "Fetching music video",
};

export function statusLabel(s: Pick<Song, "status" | "stage" | "progress">): string {
  if (s.status === "ready") return "Ready";
  if (s.status === "error") return "Failed";
  if (s.status === "queued") return "Waiting";
  const label = STAGE_LABEL[s.stage] ?? "Working";
  return `${label} ${Math.round(s.progress * 100)}%`;
}
