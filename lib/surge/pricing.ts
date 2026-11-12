/**
 * Launch traffic forecast: host plan amounts and rates, as data.
 *
 * Every number carries its source page and the date it was read, and the
 * report shows `PRICING_AS_OF` next to the forecast. When Vercel changes
 * its pricing, update this file only (and the as-of date); the model in
 * lib/surge/model.ts reads nothing else.
 *
 * Read on 2026-11-12 from https://vercel.com/pricing,
 * https://vercel.com/docs/pricing and
 * https://vercel.com/docs/limits/fair-use-guidelines. The three pages
 * agree on the Hobby amounts below. They disagree on some Pro rates (the
 * docs page says several "vary by region"), so Pro uses the pricing page's
 * "starting at" rates: Pro costs are a floor, never a quote.
 */

export type Resource =
  | "cdnRequests"
  | "fastDataTransfer"
  | "functionInvocations"
  | "activeCpu"
  | "imageTransformations"
  | "fastOriginTransfer";

export interface ResourceInfo {
  label: string;
  unit: string;
  /** False for usage that does not grow with visitors (image transformations are cached) */
  scalesWithVisitors: boolean;
}

export const RESOURCES: Record<Resource, ResourceInfo> = {
  cdnRequests: { label: "CDN requests", unit: "requests", scalesWithVisitors: true },
  fastDataTransfer: { label: "Fast Data Transfer", unit: "GB", scalesWithVisitors: true },
  functionInvocations: { label: "Function invocations", unit: "invocations", scalesWithVisitors: true },
  activeCpu: { label: "Active CPU", unit: "hours", scalesWithVisitors: true },
  imageTransformations: { label: "Image transformations", unit: "transformations", scalesWithVisitors: false },
  fastOriginTransfer: { label: "Fast Origin Transfer", unit: "GB", scalesWithVisitors: true },
};

/** Display and evaluation order. */
export const RESOURCE_ORDER: Resource[] = [
  "cdnRequests",
  "fastDataTransfer",
  "functionInvocations",
  "activeCpu",
  "fastOriginTransfer",
  "imageTransformations",
];

export interface ResourceTerms {
  /** Monthly amount included, in the resource's unit; omitted when the plan sets none */
  included?: number;
  /** On-demand price beyond `included`: `usd` per `per` units */
  rate?: { per: number; usd: number };
  /** Plain-language note, e.g. how the plan bills this resource */
  note?: string;
}

export interface PlanPricing {
  id: "hobby" | "pro";
  name: string;
  monthlyBaseUsd: number;
  /** Monthly usage credit that on-demand charges are taken from first */
  usageCreditUsd: number;
  /** True when usage stops at the included amounts and more can't be bought */
  hardCaps: boolean;
  resources: Partial<Record<Resource, ResourceTerms>>;
  source: string;
}

export const PRICING_AS_OF = "2026-11-12";

export const VERCEL_HOBBY: PlanPricing = {
  id: "hobby",
  name: "Vercel Hobby",
  monthlyBaseUsd: 0,
  usageCreditUsd: 0,
  // "If you have a free Hobby account, you are limited to the usage caps
  // and cannot purchase additional usage." (vercel.com/pricing FAQ)
  hardCaps: true,
  resources: {
    cdnRequests: { included: 1_000_000 },
    fastDataTransfer: { included: 100 },
    functionInvocations: { included: 1_000_000 },
    activeCpu: { included: 4 },
    imageTransformations: { included: 5_000 },
    fastOriginTransfer: { included: 10 },
  },
  source: "https://vercel.com/pricing",
};

const FLAT_RATE_CDN = "Included in Vercel's Flat Rate CDN on Pro (a fixed monthly price), so not metered here.";

export const VERCEL_PRO: PlanPricing = {
  id: "pro",
  name: "Vercel Pro",
  monthlyBaseUsd: 20,
  // "$20/mo." with "$20 of included usage credit"; on-demand charges start
  // once the credit is used.
  usageCreditUsd: 20,
  hardCaps: false,
  resources: {
    cdnRequests: { note: FLAT_RATE_CDN },
    fastDataTransfer: { note: FLAT_RATE_CDN },
    functionInvocations: { rate: { per: 1_000_000, usd: 0.6 } },
    activeCpu: { rate: { per: 1, usd: 0.128 } },
    imageTransformations: { rate: { per: 1_000, usd: 0.05 } },
    fastOriginTransfer: { rate: { per: 1, usd: 0.06 } },
  },
  source: "https://vercel.com/pricing",
};

export const PLANS: Record<PlanPricing["id"], PlanPricing> = { hobby: VERCEL_HOBBY, pro: VERCEL_PRO };
