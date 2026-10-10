import { useState } from "react";
import { api, key } from "./api";
export function InviteCard({
  code,
  authenticated,
  onJoin,
}: {
  code: string;
  authenticated: boolean;
  onJoin: () => void;
}) {
  const [verifying, setVerifying] = useState(false);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("");
  return (
    <section className="panel invite-card">
      <div className="eyebrow">YOU’RE INVITED</div>
      <h2>One shared tab. Your own conversation.</h2>
      <p>
        Join to see the tab’s shared expense history and get private purchase
        updates. No wallet needed. Joining never authorizes a payment. Text STOP
        to pause updates.
      </p>
      {!authenticated && (
        <button onClick={() => setVerifying(true)}>Accept invitation</button>
      )}
      <p>Join directly in iMessage by sending:</p>
      <code className="invite-code">join {code}</code>
      <p className="muted">
        Use your own Photon-assigned conversation. During this pilot, the
        organizer must register your iMessage number or email with Photon first.
      </p>
      {authenticated ? (
        <button onClick={onJoin}>Accept invitation</button>
      ) : verifying ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const providerUserId = String(
              new FormData(e.currentTarget).get("inviteIdentity"),
            ).trim();
            setPending(true);
            setStatus("");
            try {
              const result = await api<{ message: string }>("/auth/start", {
                providerUserId,
                inviteCode: code,
              });
              setStatus(
                result.message +
                  " Open the link in iMessage, then press Accept invitation. If no message arrives, first send hi to your assigned Tab conversation and try again.",
              );
            } catch (error) {
              setStatus(
                error instanceof Error
                  ? error.message
                  : "Could not request sign-in.",
              );
            } finally {
              setPending(false);
            }
          }}
        >
          <h3>Verify with iMessage</h3>
          <p>
            First send <strong>hi</strong> to your assigned Tab conversation so
            Tab can recognize you. Then enter your own registered number
            (including country code) or iMessage email below.
          </p>
          <label>
            Your iMessage number or email
            <input
              name="inviteIdentity"
              autoComplete="username"
              placeholder="+19195550123"
              required
            />
          </label>
          <button disabled={pending}>
            {pending ? "Requesting…" : "Send my sign-in link"}
          </button>
          <p>
            We’ll carry this invitation into your private sign-in link. No
            password or wallet required.
          </p>
          {status && <p role="status">{status}</p>}
        </form>
      ) : (
        <p>
          Accept invitation to verify your identity, or use the iMessage command
          above.
        </p>
      )}
    </section>
  );
}
export function TabSetup({
  group,
  userId,
  busy,
  run,
  select,
}: {
  group: {
    id: string;
    direct: boolean;
    members: { id: string; role: string }[];
  } | null;
  userId: string;
  busy: boolean;
  run: (fn: () => Promise<unknown>, message?: string) => Promise<void>;
  select: (id: string) => void;
}) {
  const [invite, setInvite] = useState<{ url: string; code: string } | null>(
    null,
  );
  return (
    <section className="panel tab-setup">
      <div>
        <div className="eyebrow">MAKE A PLAN. SHARE A TAB.</div>
        <h2>Bring your people together</h2>
        <p>
          Everyone messages Tab privately. Share an invitation, wait for friends
          to join, then add the purchase.
        </p>
      </div>
      <div className="setup-forms">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const name = String(new FormData(e.currentTarget).get("tabName"));
            void run(async () => {
              const g = await api<{ id: string }>("/tabs", {
                name,
                idempotencyKey: key(),
              });
              select(g.id);
              setInvite(null);
            }, "Tab created. Invite friends before confirming a split.");
          }}
        >
          <label>
            New tab name
            <input
              name="tabName"
              placeholder="Friday dinner"
              required
              maxLength={100}
            />
          </label>
          <button disabled={busy}>Create shared tab</button>
        </form>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const code = String(
              new FormData(e.currentTarget).get("inviteCode"),
            ).trim();
            void run(async () => {
              const g = await api<{ id: string }>("/tabs/join", { code });
              select(g.id);
              setInvite(null);
            }, "Joined. Purchase updates arrive privately; text STOP to pause.");
          }}
        >
          <label>
            Invitation code
            <input
              name="inviteCode"
              required
              placeholder="Paste a code from your friend"
            />
          </label>
          <button className="secondary" disabled={busy}>
            Join shared tab
          </button>
        </form>
      </div>
      {group?.direct &&
        group.members.find((m) => m.id === userId)?.role === "owner" && (
          <div className="invite-actions">
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  setInvite(await api(`/groups/${group.id}/invites`, {}));
                })
              }
            >
              Get invitation link
            </button>
            <button
              className="text-button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await api(`/groups/${group.id}/invites/revoke`, {});
                  setInvite(null);
                }, "Invitations revoked. Existing members keep access.")
              }
            >
              Revoke invitations
            </button>
            {invite && (
              <div>
                <p>
                  Share this invitation with your friends. Anyone with the link
                  can join and see shared expenses. Expires in 7 days.
                </p>
                <a className="invite-code" href={invite.url}>
                  {invite.url}
                </a>
                <p>
                  Or message Tab:{" "}
                  <code className="invite-code">join {invite.code}</code>
                </p>
                <button
                  className="secondary"
                  onClick={() =>
                    void run(
                      () => navigator.clipboard.writeText(invite.url),
                      "Invitation copied.",
                    )
                  }
                >
                  Copy invitation
                </button>
              </div>
            )}
          </div>
        )}
    </section>
  );
}
