/**
 * Connectivity, offline songs and the install prompt.
 *
 * The service worker (public/sw.js) serves the app and the last known library when Encore is
 * out of reach. Songs the user saves are written here into the "encore-offline-v1" cache under
 * their normal URLs, so the stage loads them exactly like online songs.
 */
import { useSyncExternalStore } from "react";
import type { SongDetail } from "./api";

const CACHE = "encore-offline-v1";
const INDEX = "/__encore/offline-index.json";

// ---- tiny observable store ----------------------------------------------------

function store<T>(initial: T) {
  let value = initial;
  const subs = new Set<() => void>();
  return {
    get: () => value,
    set(v: T) {
      if (v === value) return;
      value = v;
      subs.forEach((f) => f());
    },
    subscribe(f: () => void) {
      subs.add(f);
      return () => subs.delete(f);
    },
  };
}

// ---- connectivity -------------------------------------------------------------

/** false when the last request to Encore failed or was answered from the offline cache. */
export const connection = store(typeof navigator === "undefined" ? true : navigator.onLine);

export function useOnline(): boolean {
  return useSyncExternalStore(connection.subscribe, connection.get);
}

/** Called by api.ts after every request. */
export function noteResponse(res: Response | null): void {
  connection.set(!!res && res.headers.get("x-encore-offline") !== "1");
}

let probing = 0;
/** While offline, check every few seconds whether Encore is back. */
export function watchConnection(onBack: () => void): () => void {
  const probe = async () => {
    if (connection.get()) return;
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      if (res.ok && res.headers.get("x-encore-offline") !== "1") {
        connection.set(true);
        onBack();
      }
    } catch {
      /* still offline */
    }
  };
  probing = window.setInterval(probe, 5000);
  const goOnline = () => void probe();
  const goOffline = () => connection.set(false);
  window.addEventListener("online", goOnline);
  window.addEventListener("offline", goOffline);
  return () => {
    window.clearInterval(probing);
    window.removeEventListener("online", goOnline);
    window.removeEventListener("offline", goOffline);
  };
}

// ---- service worker -----------------------------------------------------------

/** Service workers (and so offline use and installing) need https or localhost. */
export const offlineCapable = typeof window !== "undefined" && window.isSecureContext && "serviceWorker" in navigator && "caches" in window;

export function registerServiceWorker(): void {
  if (!offlineCapable || import.meta.env.DEV) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((e) => console.warn("service worker not registered", e));
  });
}

// ---- install prompt (Edge, Chrome, Android) -------------------------------------

interface InstallEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const installEvent = store<InstallEvent | null>(null);
export const standalone = store(
  typeof window !== "undefined" &&
    (window.matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true),
);

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // we show our own button
    installEvent.set(e as InstallEvent);
  });
  window.addEventListener("appinstalled", () => {
    installEvent.set(null);
    standalone.set(true);
  });
}

export function useInstall(): { canPrompt: boolean; installed: boolean; ios: boolean; install: () => Promise<void> } {
  const ev = useSyncExternalStore(installEvent.subscribe, installEvent.get);
  const installed = useSyncExternalStore(standalone.subscribe, standalone.get);
  const ios = typeof navigator !== "undefined" && /iphone|ipad|ipod/i.test(navigator.userAgent);
  return {
    canPrompt: !!ev,
    installed,
    ios,
    install: async () => {
      if (!ev) return;
      await ev.prompt();
      await ev.userChoice;
      installEvent.set(null);
    },
  };
}

// ---- saved songs ----------------------------------------------------------------

export interface SavedSong {
  id: string;
  title: string;
  artist: string;
  cover: string;
  duration: number;
  bytes: number;
  savedAt: number;
}

type Index = Record<string, SavedSong>;
export const saved = store<Index>({});
export const saving = store<Record<string, number>>({}); // song id -> progress 0..1

export function useSaved(): Index {
  return useSyncExternalStore(saved.subscribe, saved.get);
}

export function useSaving(): Record<string, number> {
  return useSyncExternalStore(saving.subscribe, saving.get);
}

async function readIndex(cache: Cache): Promise<Index> {
  try {
    const res = await cache.match(INDEX);
    return res ? ((await res.json()) as Index) : {};
  } catch {
    return {};
  }
}

async function writeIndex(cache: Cache, index: Index): Promise<void> {
  await cache.put(INDEX, new Response(JSON.stringify(index), { headers: { "content-type": "application/json" } }));
  saved.set(index);
}

export async function loadSaved(): Promise<void> {
  if (!offlineCapable) return;
  saved.set(await readIndex(await caches.open(CACHE)));
}

async function download(url: string, onProgress: (got: number, total: number) => void): Promise<Response> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(got, total);
  }
  const blob = new Blob(chunks as BlobPart[], { type: res.headers.get("content-type") ?? "application/octet-stream" });
  return new Response(blob, { headers: { "content-type": blob.type, "content-length": String(blob.size) } });
}

/** Stems, cover and song details (with lyrics and word timing) go onto the device. */
export async function saveSong(id: string): Promise<void> {
  if (!offlineCapable) throw new Error("Saving songs needs Encore over https (or localhost).");
  if (saving.get()[id] !== undefined) return;
  saving.set({ ...saving.get(), [id]: 0 });
  try {
    void navigator.storage?.persist?.(); // ask the browser not to evict saved songs
    const cache = await caches.open(CACHE);
    const detailUrl = `/api/songs/${id}`;
    const detailRes = await fetch(detailUrl, { cache: "no-store" });
    if (!detailRes.ok || detailRes.headers.get("x-encore-offline") === "1") throw new Error("Encore is not reachable");
    const detail = (await detailRes.clone().json()) as SongDetail;
    if (!detail.stems) throw new Error("This song is not ready yet");
    const urls = [detail.stems.instrumental, detail.stems.vocals, detail.cover].filter(Boolean);
    const got = new Map<string, number>();
    const totals = new Map<string, number>();
    const report = () => {
      const t = [...totals.values()].reduce((a, b) => a + b, 0) || 1;
      const g = [...got.values()].reduce((a, b) => a + b, 0);
      saving.set({ ...saving.get(), [id]: Math.min(0.99, g / t) });
    };
    let bytes = 0;
    const responses = await Promise.all(
      urls.map((u) =>
        download(u, (g, t) => {
          got.set(u, g);
          totals.set(u, t || g);
          report();
        }),
      ),
    );
    for (let i = 0; i < urls.length; i++) {
      bytes += Number(responses[i].headers.get("content-length")) || 0;
      await cache.put(urls[i], responses[i]);
    }
    await cache.put(detailUrl, detailRes); // last: the song counts as saved once its details are there
    const index = await readIndex(cache);
    index[id] = { id, title: detail.title, artist: detail.artist, cover: detail.cover, duration: detail.duration, bytes, savedAt: Date.now() };
    await writeIndex(cache, index);
  } finally {
    const { [id]: _done, ...rest } = saving.get();
    saving.set(rest);
  }
}

export async function removeSong(id: string): Promise<void> {
  if (!offlineCapable) return;
  const cache = await caches.open(CACHE);
  // A proxied cover (/api/thumb?u=...) has no song id in its path, find it through the details.
  try {
    const detail = (await (await cache.match(`/api/songs/${id}`))?.json()) as SongDetail | undefined;
    if (detail?.cover) await cache.delete(detail.cover);
  } catch {
    /* no details stored */
  }
  for (const req of await cache.keys()) {
    const path = new URL(req.url).pathname;
    if (path === `/api/songs/${id}` || path.startsWith(`/media/${id}/`)) await cache.delete(req);
  }
  const index = await readIndex(cache);
  delete index[id];
  await writeIndex(cache, index);
}

export async function removeAll(): Promise<void> {
  if (!offlineCapable) return;
  await caches.delete(CACHE);
  saved.set({});
}

/** Refresh lyrics, timing and title of saved songs while Encore is reachable. */
export async function refreshSavedDetails(): Promise<void> {
  if (!offlineCapable) return;
  const cache = await caches.open(CACHE);
  const index = await readIndex(cache);
  for (const id of Object.keys(index)) {
    try {
      const res = await fetch(`/api/songs/${id}`, { cache: "no-store" });
      if (res.status === 404) {
        await removeSong(id); // deleted on the server
        continue;
      }
      if (res.ok && res.headers.get("x-encore-offline") !== "1") await cache.put(`/api/songs/${id}`, res);
    } catch {
      return; // offline again
    }
  }
}
