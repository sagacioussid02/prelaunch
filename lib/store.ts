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
  await fs.writeFile(await pathFor(result.id), JSON.stringify(result));
}

export async function getScan(id: string): Promise<ScanResult | null> {
  try {
    const raw = await fs.readFile(await pathFor(id), "utf8");
    return JSON.parse(raw) as ScanResult;
  } catch {
    return null;
  }
}

export function newScanId(): string {
  // 128-bit random IDs (security review 2026-10-18, MEDIUM #10): report pages
  // are public by design, so IDs must not be enumerable.
  return randomUUID();
}
