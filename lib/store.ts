/**
 * Prototype persistence layer.
 *
 * For the prototype this is a JSON file store (no infra to configure).
 * The MVP deploy swaps this for Postgres (Neon) per the spec §6 — same
 * interface, durable and queryable for the monitoring tier's baseline diffing.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ScanResult } from "../lib/checks/types.ts";

const DATA_DIR = process.env.PRELAUNCH_DATA_DIR ?? join(process.cwd(), ".data");

async function pathFor(id: string): Promise<string> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  if (!/^[a-z0-9-]+$/i.test(id)) throw new Error("bad scan id");
  return join(DATA_DIR, `${id}.json`);
}

export async function saveScan(result: ScanResult): Promise<void> {
  const file = await pathFor(result.id);
  // Write-then-rename so pollers never read a half-written file.
  const tmp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(result));
  await fs.rename(tmp, file);
}

export async function getScan(id: string): Promise<ScanResult | null> {
  try {
    const raw = await fs.readFile(await pathFor(id), "utf8");
    return JSON.parse(raw) as ScanResult;
  } catch {
    return null;
  }
}

export const DATA_ROOT = DATA_DIR;

async function shotPath(id: string, name: string): Promise<string> {
  if (!/^[a-z0-9-]+$/i.test(id) || !/^[a-z]+$/.test(name)) throw new Error("bad shot id");
  const dir = join(DATA_DIR, "shots");
  await fs.mkdir(dir, { recursive: true });
  return join(dir, `${id}-${name}.jpg`);
}

export async function saveShot(id: string, name: string, data: Buffer): Promise<void> {
  await fs.writeFile(await shotPath(id, name), data);
}

export async function getShot(id: string, name: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(await shotPath(id, name));
  } catch {
    return null;
  }
}

export function newScanId(): string {
  // 128-bit random IDs (security review 2026-10-18, MEDIUM #10): report pages
  // are public by design, so IDs must not be enumerable.
  return randomUUID();
}
