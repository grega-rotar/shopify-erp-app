import { prisma } from "~/adapters/db/client.server";

/**
 * The shop's background jobs, read straight from pg-boss.
 *
 * Every job this app queues for a shop carries `shopDomain` in its data, so a
 * test can wait for the work it caused and then see whether any of it failed.
 */

interface JobRow {
  name: string;
  state: string;
  output: unknown;
}

async function shopJobs(shopDomain: string): Promise<JobRow[]> {
  return prisma.$queryRaw<JobRow[]>`
    SELECT name, state::text AS state, output
    FROM pgboss.job
    WHERE data->>'shopDomain' = ${shopDomain}
  `;
}

/**
 * Waits until none of the shop's jobs is running or due, and returns the ones
 * that failed — finally, or once and now waiting to retry. A job that is not
 * due yet (a retry with a delay, a throttled refresh) does not hold this up.
 */
export async function settleJobs(
  shopDomain: string,
  timeoutMs = 30_000,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const busy = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count
      FROM pgboss.job
      WHERE data->>'shopDomain' = ${shopDomain}
        AND (state = 'active' OR (state IN ('created', 'retry') AND start_after <= now()))
    `;
    if (Number(busy[0]?.count ?? 0) === 0) break;
    if (Date.now() > deadline) {
      const pending = (await shopJobs(shopDomain)).filter(
        (job) => job.state === "active" || job.state === "created",
      );
      return pending.map(
        (job) => `${job.name}: still ${job.state} after ${timeoutMs} ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return (await shopJobs(shopDomain))
    .filter((job) => job.state === "failed" || job.state === "retry")
    .map((job) => `${job.name}: ${job.state}, ${failureMessage(job.output)}`);
}

/** pg-boss stores a thrown error as `{ name, message, stack }`. */
function failureMessage(output: unknown): string {
  if (typeof output === "object" && output !== null && "message" in output) {
    return String(output.message);
  }
  return JSON.stringify(output);
}
