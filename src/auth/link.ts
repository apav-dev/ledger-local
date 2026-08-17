import type { LinkTokenGetSessionsResponse } from 'plaid';
import { getItem, upsertItem, type Db } from '../core/db.js';
import type { LedgerPlaidApi } from '../core/plaid-client.js';

export class LinkError extends Error {
  override readonly name = 'LinkError';
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export interface LinkRunOpts {
  /** Opens the hosted URL in a browser. Injected so tests never launch one. */
  openUrl: (url: string) => void;
  redirectUri?: string | undefined;
  pollIntervalMs?: number | undefined;
  timeoutMs?: number | undefined;
  now?: (() => number) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Receives progress lines; defaults to silence. */
  report?: ((message: string) => void) | undefined;
}

interface Terminal {
  session: LinkTokenGetSessionsResponse;
  publicToken: string | null;
  institutionName: string | null;
  institutionId: string | null;
}

/**
 * Reads a session for a terminal outcome.
 *
 * Order matters. A cancelled session also carries `finished_at`, so success
 * evidence must be checked before treating a finished session as an exit.
 * Returns null while the session is still in flight.
 */
export function readTerminalSession(session: LinkTokenGetSessionsResponse): Terminal | null {
  const added = session.results?.item_add_results ?? [];
  const first = added[0];
  if (first !== undefined) {
    return {
      session,
      publicToken: first.public_token,
      institutionName: first.institution?.name ?? null,
      institutionId: first.institution?.institution_id ?? null,
    };
  }

  if (session.on_success != null) {
    const metadata = session.on_success.metadata;
    return {
      session,
      publicToken: session.on_success.public_token,
      institutionName: metadata?.institution?.name ?? null,
      institutionId: metadata?.institution?.institution_id ?? null,
    };
  }

  if (session.exit != null) {
    const error = session.exit.error;
    throw new LinkError(
      error == null
        ? 'Link session was closed before a bank was linked. Re-run the command to try again.'
        : `Link failed: ${error.error_message} (${error.error_code})`,
    );
  }

  if (session.finished_at != null) {
    // Finished with neither success evidence nor an exit error. Update mode
    // lands here: it repairs the existing Item and mints no public_token.
    return { session, publicToken: null, institutionName: null, institutionId: null };
  }

  return null;
}

/**
 * Creates a Hosted Link session, opens it, and polls `/link/token/get` until it
 * reaches a terminal state.
 *
 * Hosted Link has no frontend integration point, so polling is the sanctioned
 * way to collect the result without running a webhook receiver — which is why
 * this tool needs no local HTTP server.
 *
 * The poll loop is bounded by iteration count, not just wall-clock, so a
 * misbehaving clock cannot turn it into an infinite loop.
 */
async function openHostedLinkAndWait(
  api: LedgerPlaidApi,
  opts: LinkRunOpts & { accessToken?: string | undefined },
): Promise<Terminal> {
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));
  const report = opts.report ?? (() => {});

  const { linkToken, hostedLinkUrl } = await api.createLinkToken({
    accessToken: opts.accessToken,
    redirectUri: opts.redirectUri,
  });
  if (hostedLinkUrl === null) {
    throw new LinkError(
      'Plaid did not return a hosted_link_url. Confirm Hosted Link is enabled for this ' +
        'client_id in the Plaid dashboard.',
    );
  }

  report(`Opening ${hostedLinkUrl}\nComplete the bank login in your browser.`);
  opts.openUrl(hostedLinkUrl);

  const deadline = now() + timeoutMs;
  const maxPolls = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));

  for (let poll = 0; poll < maxPolls; poll++) {
    await sleep(pollIntervalMs);
    const response = await api.getLinkSession(linkToken);
    for (const session of response.link_sessions ?? []) {
      const terminal = readTerminalSession(session);
      if (terminal !== null) return terminal;
    }
    if (now() >= deadline) break;
  }

  throw new LinkError(
    `Link timed out after ${Math.round(timeoutMs / 1000)}s with no completed session. ` +
      `Re-run the command to try again.`,
  );
}

export interface LinkedItem {
  itemId: string;
  institution: string;
}

/**
 * Links a new bank: Hosted Link, then exchange the public_token for a permanent
 * access_token, then record the Item with a NULL cursor so the first sync pulls
 * full history.
 */
export async function linkNewItem(
  db: Db,
  api: LedgerPlaidApi,
  opts: LinkRunOpts,
): Promise<LinkedItem> {
  const terminal = await openHostedLinkAndWait(api, opts);
  if (terminal.publicToken === null) {
    throw new LinkError(
      'Link finished without returning a public_token, so no bank was linked. ' +
        'Re-run the command to try again.',
    );
  }

  const { accessToken, itemId } = await api.exchangePublicToken(terminal.publicToken);
  // The Link session metadata carries the institution name, so no extra
  // /item/get + /institutions/get_by_id round trip is needed.
  const institution = terminal.institutionName ?? 'Unknown institution';

  upsertItem(db, {
    id: itemId,
    access_token: accessToken,
    institution,
    institution_id: terminal.institutionId,
    created_at: Date.now(),
  });

  return { itemId, institution };
}

/**
 * Repairs an Item stuck in ITEM_LOGIN_REQUIRED using Link update mode.
 *
 * Update mode is not a convenience: re-running a plain link would create a
 * SECOND Item for the same bank and consume another slot against the Trial
 * plan's 10-Item cap, while leaving the broken Item behind.
 */
export async function repairItem(
  db: Db,
  api: LedgerPlaidApi,
  itemId: string,
  opts: LinkRunOpts,
): Promise<LinkedItem> {
  const item = getItem(db, itemId);
  if (item === undefined) {
    throw new LinkError(`No linked item with id "${itemId}". Run \`ledger auth status\` to list them.`);
  }

  await openHostedLinkAndWait(api, { ...opts, accessToken: item.access_token });

  // Update mode keeps the same access_token and item_id, and upsertItem
  // deliberately preserves the cursor so the next sync stays incremental.
  return { itemId: item.id, institution: item.institution };
}
