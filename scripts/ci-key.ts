/**
 * Owner tool: issue, list and revoke Prelaunch keys for the GitHub Action.
 *
 *   node scripts/ci-key.ts issue <email> [label]   prints the key ONCE
 *   node scripts/ci-key.ts list [email]            ids, emails, labels, state
 *   node scripts/ci-key.ts revoke <key id>         e.g. ck_0123456789ab
 *
 * Writes to Postgres when DATABASE_URL is set (point it at production to
 * issue a real key), else to the JSON store under PRELAUNCH_DATA_DIR.
 * A key only scans while its email is on Pro (Stripe subscription or
 * PRO_EMAILS); issuing one does not grant Pro. Self-serve issuing after
 * checkout is a later step.
 */
import { issueCiKey, listCiKeys, revokeCiKey } from "../lib/cikeys.ts";

const [cmd, a, ...rest] = process.argv.slice(2);

async function main(): Promise<number> {
  switch (cmd) {
    case "issue": {
      if (!a) break;
      const { key, record } = await issueCiKey(a, rest.join(" ") || null);
      console.log(`Issued ${record.id} for ${record.email}${record.label ? ` (${record.label})` : ""}.`);
      console.log("Key (shown once; store it as the repository secret PRELAUNCH_API_KEY):");
      console.log(key);
      return 0;
    }
    case "list": {
      for (const k of await listCiKeys(a)) {
        console.log(
          [k.id, k.email, k.label ?? "-", k.createdAt.slice(0, 10), k.revokedAt ? `revoked ${k.revokedAt.slice(0, 10)}` : "active"].join("  "),
        );
      }
      return 0;
    }
    case "revoke": {
      if (!a) break;
      const ok = await revokeCiKey(a);
      console.log(ok ? `Revoked ${a}.` : `No key with id ${a}.`);
      return ok ? 0 : 1;
    }
  }
  console.error("usage: node scripts/ci-key.ts issue <email> [label] | list [email] | revoke <key id>");
  return 2;
}

process.exit(await main());
