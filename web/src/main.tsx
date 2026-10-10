import React, { useEffect, useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import type {
  Expense,
  Intent,
  Attempt,
  Destination,
} from "../../server/src/db/schema";
import type {
  PaymentCapability,
  PaymentInstructions,
  PaymentMethod,
} from "../../server/src/payments/types";
import { api, ApiError, key, money } from "./api";
import "./styles.css";
import { TabSetup, InviteCard } from "./TabSetup";
type Me = {
  user: { id: string; name: string };
  demo: boolean;
  modes: { ai: string; messaging: string; solana: string };
  demoPeople: { id: string; name: string }[];
  wallet: string | null;
};
type Group = {
  direct: boolean;
  id: string;
  name: string;
  members: { id: string; name: string; role: string }[];
  expenses: (Expense & { shares: { userId: string; cents: number }[] })[];
  balances: { userId: string; cents: number }[];
  intents: Intent[];
  activePlan: boolean;
  attempts: (Attempt & { explorerUrl: string | null })[];
  activity: {
    id: string;
    type: string;
    actorId: string | null;
    createdAt: number;
  }[];
  messages: { id: string; text: string; state: string }[];
};
const labels: Record<string, string> = {
  solana: "Solana",
  venmo: "Venmo",
  apple_cash: "Apple Cash",
  zelle: "Zelle",
  cash: "Cash",
};
const statuses: Record<string, string> = {
  pending: "Needs review",
  confirmed: "Confirmed expense",
  rejected: "Rejected",
  ready_for_external_payment: "Ready to pay independently",
  awaiting_authorization: "Needs your approval",
  sender_claimed: "Claimed · awaiting recipient",
  recipient_confirmed: "Confirmed by recipient",
  onchain_verified: "On-chain verified · devnet",
  submitting: "Preparing transaction",
  submitted: "Awaiting chain verification",
  failed: "Failed · no credit applied",
  disputed: "Disputed · unresolved",
  cancelled: "Cancelled",
};
function Icon({ type = "grid" }: { type?: string }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {type === "grid" ? (
        <>
          <rect x="3" y="3" width="7" height="7" rx="2" />
          <rect x="14" y="3" width="7" height="7" rx="2" />
          <rect x="3" y="14" width="7" height="7" rx="2" />
          <rect x="14" y="14" width="7" height="7" rx="2" />
        </>
      ) : type === "pay" ? (
        <>
          <path d="M4 8h15m-4-4 4 4-4 4M20 16H5m4-4-4 4 4 4" />
        </>
      ) : type === "chat" ? (
        <path d="M21 11a8 8 0 0 1-8 8H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4zM7 8h10M7 12h7" />
      ) : (
        <>
          <rect x="3" y="5" width="18" height="14" rx="3" />
          <path d="M3 10h18M7 15h3" />
        </>
      )}
    </svg>
  );
}
function Badge({ status }: { status: string }) {
  return (
    <span
      className={`badge ${["confirmed", "recipient_confirmed", "onchain_verified"].includes(status) ? "green" : ["failed", "disputed"].includes(status) ? "red" : ""}`}
    >
      {statuses[status] || status}
    </span>
  );
}
function App() {
  const [inviteCode, setInviteCode] = useState(
    () => new URLSearchParams(location.hash.slice(1)).get("invite") || "",
  );
  const [me, setMe] = useState<Me | null>(null),
    [groups, setGroups] = useState<{ id: string; name: string }[]>([]),
    [groupId, setGroupId] = useState(""),
    [group, setGroup] = useState<Group | null>(null);
  const [tab, setTab] = useState("Overview"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  const [capabilities, setCapabilities] = useState<PaymentCapability[]>([]),
    [destinations, setDestinations] = useState<Destination[]>([]),
    [modal, setModal] = useState<null | "expense" | "receipt" | "simulation">(
      null,
    );
  const groupRef = useRef(
    location.pathname.startsWith("/trip/")
      ? decodeURIComponent(location.pathname.slice(6))
      : "",
  );
  const [paymentId, setPaymentId] = useState<string | null>(null),
    [approval, setApproval] = useState<{
      token: string;
      amountCents: number;
      recipientId: string;
    } | null>(null);
  async function refresh(selected = groupRef.current) {
    const current = await api<Me>("/me");
    setMe(current);
    const list = await api<{ id: string; name: string }[]>("/groups");
    setGroups(list);
    const id = list.some((g) => g.id === selected)
      ? selected
      : (list[0]?.id ?? "");
    groupRef.current = id;
    setGroupId(id);
    setGroup(id ? await api<Group>(`/groups/${id}`) : null);
    setCapabilities(await api<PaymentCapability[]>("/payments/methods"));
    setDestinations(await api<Destination[]>("/me/destinations"));
  }
  useEffect(() => {
    const bootstrap = async () => {
      const fragment = new URLSearchParams(location.hash.slice(1));
      const token = fragment.get("login"),
        identity = fragment.get("identity");
      if (token && identity) {
        history.replaceState(null, "", location.pathname);
        await api("/auth/verify", { token, providerUserId: identity });
      }
      await refresh();
    };
    bootstrap()
      .catch((e) => {
        if (!(e instanceof ApiError && e.status === 401))
          setError(String(e.message));
      })
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    if (!me || busy || modal || paymentId) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible")
        void refresh().catch(() => {});
    }, 8000);
    return () => clearInterval(timer);
  }, [me?.user.id, busy, modal, paymentId]);
  async function act(fn: () => Promise<unknown>, message?: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      await refresh();
      if (message) setNotice(message);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not complete action.");
    } finally {
      setBusy(false);
    }
  }
  async function login(userId: string) {
    await act(async () => {
      await api("/dev/login", { userId });
      setPaymentId(null);
      setApproval(null);
    });
  }
  const name = (id: string | null) =>
    group?.members.find((m) => m.id === id)?.name ?? id ?? "Choose payer";
  const balance =
    group?.balances.find((b) => b.userId === me?.user.id)?.cents ?? 0;
  const confirmed =
    group?.expenses.filter((e) => e.status === "confirmed") ?? [];
  const attempt = group?.attempts.find((a) => a.id === paymentId),
    intent = group?.intents.find((i) => i.id === attempt?.intentId);
  const instructions: PaymentInstructions | null = attempt
    ? (JSON.parse(attempt.destination) as PaymentInstructions)
    : null;
  const overlayClose = () => {
    setModal(null);
    setPaymentId(null);
    setApproval(null);
  };
  useEffect(() => {
    if (!modal && !paymentId) return;
    const previous = document.activeElement as HTMLElement;
    const dialog = document.querySelector<HTMLElement>(".modal");
    dialog?.querySelector<HTMLElement>("button, input, select")?.focus();
    const keydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) overlayClose();
      if (e.key === "Tab") {
        const nodes = dialog?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]",
        );
        if (!nodes?.length) return;
        const first = nodes[0]!,
          last = nodes[nodes.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      previous?.focus();
    };
  }, [modal, paymentId, busy]);
  if (loading)
    return (
      <div className="splash">
        <span className="logo">
          tab<span>↗</span>
        </span>
        <p>Opening your shared space…</p>
      </div>
    );
  if (!me)
    return (
      <main className="login">
        <span className="logo">
          tab<span>↗</span>
        </span>
        {!inviteCode && (
          <>
            <div className="eyebrow">SHARED MOMENTS. SORTED.</div>
            <h1>
              Good trips.
              <br />
              Clear tabs.
            </h1>
            <p>
              Track expenses together. Settle your way.
              <br />
              No wallet needed to join the conversation.
            </p>
          </>
        )}
        {inviteCode && (
          <InviteCard
            code={inviteCode}
            authenticated={false}
            onJoin={() => {}}
          />
        )}
        <div className="login-card">
          <h2>Open your private trip</h2>
          <p>
            Message Tab privately with "link" to get a private sign-in link. No
            account registration needed. You can also request a link below.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void act(
                () => api("/auth/start", { providerUserId: f.get("identity") }),
                "Check your direct messages for your private sign-in link.",
              );
            }}
          >
            <label>
              Messaging identity
              <input name="identity" required autoComplete="username" />
            </label>
            <button disabled={busy}>Send private link</button>
          </form>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void act(() =>
                api("/auth/verify", {
                  providerUserId: f.get("identity"),
                  token: f.get("token"),
                }),
              );
            }}
          >
            <label>
              Identity
              <input name="identity" required />
            </label>
            <label>
              One-time code
              <input name="token" required autoComplete="one-time-code" />
            </label>
            <button className="secondary" disabled={busy}>
              Sign in
            </button>
          </form>
          <div className="divider" />
          <span className="badge">LOCAL DEMO</span>
          <p>
            Explore the four-friend Tahoe fixture. Identity switching is
            simulation, not real authentication.
          </p>
          <button onClick={() => void login("alex")} disabled={busy}>
            Explore as Alex <span>↗</span>
          </button>
        </div>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
      </main>
    );
  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="logo" href="#">
          tab<span>↗</span>
        </a>
        <div className="workspace">
          <span className="tiny">YOUR SPACE</span>
          <strong>Weekend people</strong>
          <span className="muted">A little less settling up.</span>
        </div>
        <nav>
          {["Overview", "Settle up", "Tab messages", "Payment details"].map(
            (label, i) => (
              <button
                className={tab === label ? "active" : ""}
                key={label}
                onClick={() => setTab(label)}
              >
                <Icon type={["grid", "pay", "chat", "card"][i]} />
                {label}
                {label === "Settle up" && (
                  <span className="nav-count">
                    {group?.intents.filter((i) => i.status === "pending")
                      .length ?? 0}
                  </span>
                )}
              </button>
            ),
          )}
        </nav>
        <div className="sidebar-note">
          <span className="spark">✳</span>
          <strong>Everyone’s invited.</strong>
          <p>
            Track the trip together.
            <br />
            Choose a payment method
            <br />
            when you’re ready.
          </p>
        </div>
        <div className="profile">
          <span className={`avatar ${me.user.id}`}>{me.user.name[0]}</span>
          <div>
            <strong>{me.user.name}</strong>
            <small>{me.demo ? "Demo participant" : "Verified member"}</small>
          </div>
          <button
            className="icon-button"
            aria-label="Sign out"
            onClick={() =>
              void act(async () => {
                await api("/auth/logout", {});
                setMe(null);
              })
            }
          >
            ↪
          </button>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <span>
            YOUR TRIPS <span className="slash">/</span>{" "}
            <select
              aria-label="Select trip"
              value={groupId}
              onChange={(e) => {
                const id = e.target.value;
                setGroupId(id);
                void act(() => refresh(id));
              }}
            >
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </span>
          <span className="connection">
            <i />
            {me.modes.messaging === "connected"
              ? "Photon connected"
              : me.modes.messaging === "listening"
                ? "Photon awaiting message"
                : me.modes.messaging === "simulation"
                  ? "Local chat simulator"
                  : `Photon ${me.modes.messaging}`}
          </span>
        </header>
        {me.demo && (
          <div className="demo-bar">
            <span>
              <b>DEMO WORKSPACE</b> ·{" "}
              {me.modes.ai === "simulation"
                ? "Fixture parser"
                : "Gemini enabled"}{" "}
              ·{" "}
              {me.modes.solana === "unavailable"
                ? "Solana unavailable"
                : "Solana devnet configured"}
            </span>
            <label>
              Viewing as{" "}
              <select
                value={me.user.id}
                disabled={busy}
                onChange={(e) => void login(e.target.value)}
              >
                {me.demoPeople.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        {error && (
          <div className="error toast" role="alert">
            {error}
            <button
              className="icon-button"
              onClick={() => setError("")}
              aria-label="Dismiss error"
            >
              ×
            </button>
          </div>
        )}
        {notice && (
          <div className="success toast" role="status">
            {notice}
          </div>
        )}
        <div className="content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                {tab === "Overview"
                  ? "LESS MATH. MORE MEMORIES."
                  : "KEEP EVERYONE ON THE SAME PAGE."}
              </div>
              <h1>
                {tab === "Overview" ? (group?.name ?? "Your trips") : tab}
                <span className="heading-dot">.</span>
              </h1>
              <p className="muted">
                {tab === "Overview"
                  ? me.demo
                    ? "Nov 13–16 · A long weekend, a shared tab."
                    : "Shared expenses. Private messages. Your people."
                  : tab === "Settle up"
                    ? "One shared ledger. A payment method for everyone."
                    : tab === "Tab messages"
                      ? "An expense assistant, right where the plans happen."
                      : "Your details. Shared only when someone needs to pay you."}
              </p>
            </div>
            <button
              disabled={busy || !group}
              onClick={() => setModal("expense")}
            >
              <span className="plus">+</span> Add expense
            </button>
          </div>
          {inviteCode && (
            <InviteCard
              code={inviteCode}
              authenticated
              onJoin={() =>
                void act(async () => {
                  const joined = await api<{ id: string }>("/tabs/join", {
                    code: inviteCode,
                  });
                  groupRef.current = joined.id;
                  setInviteCode("");
                  history.replaceState(null, "", `/trip/${joined.id}`);
                }, "You joined the shared tab.")
              }
            />
          )}
          {tab === "Overview" && (
            <TabSetup
              key={groupId}
              group={group}
              userId={me.user.id}
              busy={busy}
              run={act}
              select={(id) => {
                groupRef.current = id;
                history.replaceState(null, "", `/trip/${id}`);
              }}
            />
          )}
          {group && (
            <div className="people-row">
              <div className="avatar-stack">
                {group.members.map((m) => (
                  <span title={m.name} key={m.id} className={`avatar ${m.id}`}>
                    {m.name[0]}
                  </span>
                ))}
              </div>
              <span>
                {group.members.map((m) => m.name).join(", ")}
                <span className="muted"> · {group.members.length} people</span>
              </span>
              <span className="pill">Wallet optional</span>
            </div>
          )}
          {tab === "Overview" && group && (
            <>
              <div className="stats">
                <section className="stat primary-stat">
                  <div className="stat-label">
                    Your balance <span>↗</span>
                  </div>
                  <div className="big-number">{money(Math.abs(balance))}</div>
                  <div>
                    {balance > 0
                      ? "You’re owed. We’ll keep track."
                      : balance < 0
                        ? "You owe. Settle whenever you’re ready."
                        : "You’re all square. Enjoy the trip."}
                  </div>
                  <button
                    className="text-button"
                    onClick={() => setTab("Settle up")}
                  >
                    View settlements <span>↗</span>
                  </button>
                </section>
                <section className="stat">
                  <div className="stat-label">
                    Trip spending <Icon type="card" />
                  </div>
                  <div className="big-number">
                    {money(confirmed.reduce((sum, e) => sum + e.totalCents, 0))}
                  </div>
                  <span className="muted">
                    Across {confirmed.length} confirmed expenses
                  </span>
                  <div className="mini-line" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                    <i />
                    <i />
                    <i />
                    <i />
                    <i />
                  </div>
                </section>
                <section className="stat">
                  <div className="stat-label">
                    The group at a glance <span>◎</span>
                  </div>
                  <div className="balance-list">
                    {group.balances.map((b) => (
                      <div key={b.userId}>
                        <span>
                          <span className={`mini-avatar ${b.userId}`}>
                            {name(b.userId)[0]}
                          </span>
                          {name(b.userId)}
                          {b.userId === me.user.id && <small> (you)</small>}
                        </span>
                        <strong className={b.cents > 0 ? "credit" : ""}>
                          {b.cents === 0
                            ? "All square"
                            : `${b.cents > 0 ? "+" : "−"}${money(Math.abs(b.cents))}`}
                        </strong>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
              <div className="overview-grid">
                <section className="panel expenses-panel">
                  <div className="section-heading">
                    <h2>
                      The shared tab <span>{group.expenses.length}</span>
                    </h2>
                    <button
                      className="text-button"
                      onClick={() => setModal("receipt")}
                    >
                      Add receipt ↗
                    </button>
                  </div>
                  {group.expenses.length === 0 ? (
                    <div className="empty">
                      <div className="receipt-mark">≡</div>
                      <h3>Start with a shared moment.</h3>
                      <p>
                        Groceries, gas, dinner. Add the first expense and
                        <br />
                        we’ll handle the split.
                      </p>
                      {me.demo && (
                        <button
                          className="secondary"
                          disabled={busy}
                          onClick={() =>
                            void act(
                              () =>
                                api("/dev/simulate-message", {
                                  groupId,
                                  messageId: key(),
                                  text: "@tab I paid $120 for groceries, split with everyone",
                                }),
                              "Grocery proposal ready for review.",
                            )
                          }
                        >
                          Try the $120 grocery example
                        </button>
                      )}
                    </div>
                  ) : (
                    group.expenses.map((e) => (
                      <div className="expense-row" key={e.id}>
                        <span className="expense-icon">
                          {e.description.toLowerCase().includes("dinner")
                            ? "♨"
                            : "▤"}
                        </span>
                        <div className="expense-description">
                          <strong>{e.description}</strong>
                          <small>
                            {name(e.payerId)}{" "}
                            {e.payerId ? "paid" : "· payer needed"} ·{" "}
                            {e.shares.length} people · {e.id.slice(0, 8)}
                          </small>
                          <Badge status={e.status} />
                        </div>
                        <div className="expense-amount">
                          <strong>{money(e.totalCents)}</strong>
                          <small>
                            {money(
                              e.shares.find((s) => s.userId === me.user.id)
                                ?.cents ?? 0,
                            )}{" "}
                            your share
                          </small>
                        </div>
                        {e.status === "pending" && (
                          <ExpenseReview
                            expense={e}
                            people={group.members}
                            busy={busy}
                            act={act}
                          />
                        )}
                      </div>
                    ))
                  )}
                </section>
                <section className="panel activity-panel">
                  <div className="section-heading">
                    <h2>Along the way</h2>
                    <span className="muted">↗</span>
                  </div>
                  {group.activity.length === 0 ? (
                    <p className="muted">
                      Your trip’s story will appear here as you add expenses and
                      settle up.
                    </p>
                  ) : (
                    <div className="timeline">
                      {group.activity.slice(0, 8).map((a) => (
                        <div key={a.id}>
                          <span className="timeline-dot" />
                          <strong>{a.type.replaceAll("_", " ")}</strong>
                          <small>
                            {a.actorId ? name(a.actorId) : "Solana verifier"} ·{" "}
                            {new Date(a.createdAt).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </small>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="trust-note">
                    <span>↳</span>
                    <p>
                      <strong>A claim isn’t a confirmation.</strong>
                      <br />
                      Only recipient confirmation or verified on-chain
                      settlement changes your balance.
                    </p>
                  </div>
                </section>
              </div>
              <section className="bottom-banner">
                <div>
                  <span className="eyebrow">
                    SAME TRIP. DIFFERENT WAYS TO PAY.
                  </span>
                  <h2>Settle your way.</h2>
                  <p>
                    Solana devnet, Venmo, Apple Cash, Zelle, or cash.
                    <br />
                    Everyone stays on the same tab.
                  </p>
                </div>
                <div className="rail-symbols">
                  <span className="solana-symbol">≋</span>
                  <span>V</span>
                  <span>●</span>
                  <span>Z</span>
                  <span>$</span>
                </div>
                <button
                  className="secondary"
                  onClick={() => setTab("Settle up")}
                >
                  Find your payment ↗
                </button>
              </section>
            </>
          )}
          {tab === "Settle up" && group && (
            <>
              <div className="panel settlement-intro">
                <div>
                  <h2>A clear path to all square</h2>
                  <p className="muted">
                    Plans use confirmed expenses and resolved payments. Pending
                    claims don’t reduce anyone’s balance.
                  </p>
                </div>
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(
                      () => api(`/groups/${groupId}/settlements/plan`, {}),
                      "Settlement plan is ready.",
                    )
                  }
                >
                  Calculate settlements ↗
                </button>
              </div>
              <div className="settlement-grid">
                {group.intents
                  .filter((i) => i.status !== "cancelled")
                  .map((i) => {
                    const a = group.attempts.find(
                      (a) =>
                        a.intentId === i.id &&
                        !["failed", "cancelled", "expired"].includes(a.status),
                    );
                    return (
                      <section className="panel settlement-card" key={i.id}>
                        <div className="settlement-person">
                          <span className={`avatar ${i.fromId}`}>
                            {name(i.fromId)[0]}
                          </span>
                          <span>→</span>
                          <span className={`avatar ${i.toId}`}>
                            {name(i.toId)[0]}
                          </span>
                          <span className="badge">
                            {i.status === "settled"
                              ? "Resolved"
                              : "USD obligation"}
                          </span>
                        </div>
                        <h3>
                          {name(i.fromId)} <span className="muted">to</span>{" "}
                          {name(i.toId)}
                        </h3>
                        <div className="big-number">{money(i.amountCents)}</div>
                        {a ? (
                          <>
                            <Badge status={a.status} />
                            <p className="muted">
                              {labels[a.method]} ·{" "}
                              {a.method === "solana"
                                ? "tUSD devnet test token"
                                : "Independent payment"}
                            </p>
                            <button
                              className="secondary"
                              onClick={() => {
                                setPaymentId(a.id);
                                setApproval(null);
                              }}
                            >
                              View{" "}
                              {i.toId === me.user.id &&
                              a.status === "sender_claimed"
                                ? "confirmation request"
                                : "payment"}{" "}
                              ↗
                            </button>
                          </>
                        ) : i.fromId === me.user.id ? (
                          <div className="method-picker">
                            <span className="tiny">CHOOSE HOW TO SETTLE</span>
                            {capabilities.map((r) => (
                              <button
                                key={r.method}
                                className={`method ${r.method === "solana" ? "solana-method" : ""}`}
                                disabled={busy || !r.available}
                                onClick={() =>
                                  void act(async () => {
                                    const a = await api<Attempt>(
                                      `/settlements/${i.id}/choose-method`,
                                      {
                                        method: r.method,
                                        idempotencyKey: key(),
                                      },
                                    );
                                    setPaymentId(a.id);
                                  })
                                }
                              >
                                <span>
                                  {labels[r.method]}
                                  {r.method === "solana" && (
                                    <small> tUSD · devnet</small>
                                  )}
                                </span>
                                <small>
                                  {r.available ? "→" : "Unavailable"}
                                </small>
                              </button>
                            ))}
                          </div>
                        ) : (
                          <p className="muted">
                            Waiting for {name(i.fromId)} to choose a method.
                          </p>
                        )}
                      </section>
                    );
                  })}
              </div>
              {!group.intents.length && (
                <div className="empty panel">
                  <h3>Ready when you are.</h3>
                  <p>
                    Confirm an expense, then calculate the group’s settlements.
                  </p>
                </div>
              )}
              <div className="panel subtle">
                <strong>
                  Solana devnet · real test transactions, no real value
                </strong>
                <p>
                  Both participants enable test wallets in Payment details.
                  Manual methods never require a crypto wallet.
                </p>
                {me.modes.solana === "unavailable" && (
                  <button
                    className="text-button"
                    onClick={() => setModal("simulation")}
                  >
                    Preview the labeled Solana simulation ↗
                  </button>
                )}
                {group.activePlan &&
                  group.members.find((m) => m.id === me.user.id)?.role ===
                    "owner" && (
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() =>
                        void act(
                          () =>
                            api(`/groups/${groupId}/settlements/cancel`, {}),
                          "Untouched settlement plan cancelled.",
                        )
                      }
                    >
                      Cancel untouched plan
                    </button>
                  )}
              </div>
            </>
          )}
          {tab === "Tab messages" && group && (
            <section className="panel chat-panel">
              <div className="section-heading">
                <h2>
                  {me.demo
                    ? "Your simulated conversation"
                    : "Your private Tab updates"}
                </h2>
                <Badge status={me.demo ? "SIMULATION" : me.modes.messaging} />
              </div>
              <div className="chat-bubbles">
                <div className="bot-message">
                  <span className="bot-avatar">t</span>
                  <p>
                    Hey, weekend people. Add an expense and I’ll propose a
                    split. You review it before anything reaches the ledger.
                  </p>
                </div>
                {[...group.messages].reverse().map((m) => (
                  <div className="bot-message" key={m.id}>
                    <span className="bot-avatar">t</span>
                    <div>
                      <p>{m.text}</p>
                      <small className="muted">
                        {m.state === "sent"
                          ? "Accepted by Photon"
                          : m.state === "simulated"
                            ? "Simulated delivery"
                            : m.state === "failed"
                              ? "Delivery failed — check Photon registration"
                              : m.state === "suppressed"
                                ? "Updates paused"
                                : "Queued for delivery"}
                      </small>
                    </div>
                  </div>
                ))}
              </div>
              {me.demo && (
                <>
                  <form
                    className="chat-compose"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const form = e.currentTarget;
                      const text = String(new FormData(form).get("message"));
                      void act(async () => {
                        if (group.direct) {
                          const response = await api<{
                            reply: string;
                            groupId?: string;
                          }>("/dev/direct-message", {
                            groupId,
                            messageId: key(),
                            text,
                          });
                          setNotice(response.reply);
                          if (response.groupId)
                            groupRef.current = response.groupId;
                        } else
                          await api("/dev/simulate-message", {
                            groupId,
                            messageId: key(),
                            text,
                          });
                        form.reset();
                      });
                    }}
                  >
                    <input
                      aria-label="Simulated message to Tab"
                      name="message"
                      placeholder="@tab I paid $120 for groceries, split with everyone"
                      required
                    />
                    <button disabled={busy}>Send ↗</button>
                  </form>
                  <div className="fixture-buttons">
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        void act(
                          () =>
                            api("/dev/simulate-receipt", {
                              groupId,
                              fixture: "receipt",
                            }),
                          "Dinner receipt fixture proposed. Select who paid in Overview.",
                        )
                      }
                    >
                      Simulate dinner receipt
                    </button>
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        void act(
                          () =>
                            api("/dev/simulate-receipt", {
                              groupId,
                              fixture: "payment_screenshot",
                            }),
                          "Screenshot classified as evidence only. No ledger change.",
                        )
                      }
                    >
                      Simulate payment screenshot
                    </button>
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          const g = await api<{ id: string }>(
                            "/dev/new-scenario",
                            {},
                          );
                          setGroupId(g.id);
                          await refresh(g.id);
                        }, "Fresh scenario created. Previous trip history is preserved.")
                      }
                    >
                      Start fresh scenario ↗
                    </button>
                  </div>
                </>
              )}
            </section>
          )}
          {tab === "Payment details" && (
            <div className="settings-grid">
              <section className="panel">
                <h2>Where friends can pay you</h2>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    void act(
                      () => api("/me/profile", { name: f.get("name") }, "PUT"),
                      "Display name saved.",
                    );
                  }}
                >
                  <label>
                    Your display name
                    <input
                      name="name"
                      defaultValue={me.user.name}
                      maxLength={60}
                      required
                    />
                  </label>
                  <button className="secondary" disabled={busy}>
                    Save name
                  </button>
                </form>
                <p className="muted">
                  Only save details you own and have checked. Tab cannot verify
                  your enrollment with these providers.
                </p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    void act(
                      () =>
                        api(
                          `/me/destinations/${String(f.get("method"))}`,
                          { address: f.get("address"), confirmOwnership: true },
                          "PUT",
                        ),
                      "Your payment details are saved.",
                    );
                  }}
                >
                  <label>
                    Payment method
                    <select name="method">
                      {["venmo", "apple_cash", "zelle"].map((m) => (
                        <option key={m} value={m}>
                          {labels[m]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Handle or enrolled contact
                    <input
                      name="address"
                      placeholder="Your handle, email, or phone"
                      required
                      maxLength={120}
                    />
                  </label>
                  <label className="check">
                    <input type="checkbox" required />I own these details and
                    have checked them in the provider’s app.
                  </label>
                  <button disabled={busy}>Save payment details</button>
                </form>
                {destinations.map((d) => (
                  <div className="destination" key={d.id}>
                    <strong>{labels[d.method]}</strong>
                    <span>{d.address}</span>
                    <small>Confirmed by you · not provider-verified</small>
                  </div>
                ))}
              </section>
              <section className="panel solana-panel">
                <span className="solana-symbol">≋</span>
                <h2>Your devnet test wallet</h2>
                <Badge
                  status={
                    me.modes.solana === "unavailable"
                      ? "Setup required"
                      : "DEVNET ONLY"
                  }
                />
                <p>
                  Explore a real on-chain settlement using TAB Test USD (tUSD).
                  This test token has no real value. The demo server holds
                  encrypted test keys and sponsors network fees.
                </p>
                {me.wallet && <div className="address">{me.wallet}</div>}
                <button
                  disabled={busy || me.modes.solana === "unavailable"}
                  onClick={() =>
                    void act(
                      () => api("/me/devnet-wallet", {}),
                      "Devnet test wallet enabled and funded.",
                    )
                  }
                >
                  {me.wallet
                    ? "Check test wallet funding"
                    : "Enable my test wallet"}
                </button>
                <p className="muted">
                  Manual payments and expense tracking work without this.
                </p>
              </section>
            </div>
          )}
          {!group && (
            <div className="empty panel">
              <h2>No trips yet</h2>
              <p>
                Message Tab privately with "create Tahoe", or create a shared
                tab above.
              </p>
            </div>
          )}
          <footer>
            <span className="logo small">
              tab<span>↗</span>
            </span>
            <span>Built for the people you make plans with.</span>
            <span>HackNC 2026</span>
          </footer>
        </div>
      </main>
      {(modal || attempt) && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget && !busy) overlayClose();
          }}
        >
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
          >
            <button
              className="close"
              aria-label="Close dialog"
              disabled={busy}
              onClick={overlayClose}
            >
              ×
            </button>
            {modal === "expense" && group && (
              <>
                <span className="eyebrow">MAKE IT A SHARED EXPENSE</span>
                <h2 id="modal-title">Add to the tab.</h2>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    const dollars = String(f.get("amount"));
                    if (!/^\d+(\.\d{1,2})?$/.test(dollars)) {
                      setError(
                        "Use an amount with at most two decimal places.",
                      );
                      return;
                    }
                    const [whole, fraction = ""] = dollars.split(".");
                    void act(async () => {
                      await api(`/groups/${groupId}/expenses/propose`, {
                        payerId: f.get("payer"),
                        description: f.get("description"),
                        totalCents:
                          Number(whole) * 100 + Number(fraction.padEnd(2, "0")),
                        currency: "USD",
                        participants: f.getAll("participants"),
                        idempotencyKey: key(),
                      });
                      setModal(null);
                    }, "Proposal added. Payer or owner must confirm.");
                  }}
                >
                  <label>
                    What was it for?
                    <input
                      name="description"
                      placeholder="Groceries for the cabin"
                      required
                      maxLength={500}
                    />
                  </label>
                  <div className="form-row">
                    <label>
                      Total (USD)
                      <input
                        name="amount"
                        inputMode="decimal"
                        placeholder="120.00"
                        required
                      />
                    </label>
                    <label>
                      Who paid?
                      <select name="payer" defaultValue={me.user.id}>
                        {group.members.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <fieldset>
                    <legend>Split between</legend>
                    {group.members.map((m) => (
                      <label className="check" key={m.id}>
                        <input
                          name="participants"
                          value={m.id}
                          type="checkbox"
                          defaultChecked
                        />
                        {m.name}
                      </label>
                    ))}
                  </fieldset>
                  <p className="muted">
                    Shares are calculated in exact cents. This creates a
                    proposal for review.
                  </p>
                  <button disabled={busy}>Propose expense ↗</button>
                </form>
              </>
            )}
            {modal === "receipt" && group && (
              <>
                <h2 id="modal-title">A receipt, without the math.</h2>
                <p>
                  Gemini extracts a proposal. You select participants and
                  confirm who paid. Images stay private and expire after seven
                  days.
                </p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    f.set("groupId", groupId);
                    f.set("purpose", "expense");
                    f.set(
                      "participants",
                      JSON.stringify(group.members.map((m) => m.id)),
                    );
                    void act(async () => {
                      await api("/receipts/upload", f);
                      setModal(null);
                    }, "Receipt parsed. Review the pending expense.");
                  }}
                >
                  <label>
                    Receipt image (PNG, JPEG, WebP · max 4 MB)
                    <input
                      type="file"
                      name="file"
                      accept="image/png,image/jpeg,image/webp"
                      required
                    />
                  </label>
                  <p className="muted">
                    Split with all {group.members.length} members. Payer is
                    never inferred from the upload.
                  </p>
                  <button disabled={busy}>Extract proposal</button>
                </form>
                {me.modes.ai === "simulation" && (
                  <p className="callout">
                    Gemini isn’t configured. Use “Simulate dinner receipt” in
                    Tab messages or enter the expense manually.
                  </p>
                )}
              </>
            )}
            {modal === "simulation" && (
              <>
                <span className="badge">SIMULATION ONLY · NO TRANSFER</span>
                <h2 id="modal-title">A look at the Solana flow.</h2>
                <p>
                  1. Enable test wallets for sender and recipient.
                  <br />
                  2. Choose a specific settlement and review its amount.
                  <br />
                  3. Authenticate and explicitly authorize test payment.
                  <br />
                  4. Sign, broadcast, and wait for finality.
                  <br />
                  5. Verify the mint, accounts, exact amount, and reference.
                </p>
                <div className="callout">
                  This preview changes no balances and produces no explorer
                  link. Run <code>bun run setup:devnet</code> and configure the
                  test wallet encryption key to enable real devnet transfers.
                  Offline RPC fixtures are exercised by{" "}
                  <code>bun run demo:smoke</code>.
                </div>
                <button onClick={overlayClose}>Got it</button>
              </>
            )}
            {attempt && intent && instructions && (
              <>
                <span className="eyebrow">
                  {labels[attempt.method]} · PRIVATE PAYMENT
                </span>
                <h2 id="modal-title">
                  {money(intent.amountCents)} to {name(intent.toId)}.
                </h2>
                <Badge status={attempt.status} />
                <div className="payment-details">
                  {instructions.instructionLines.map((line) => (
                    <p key={line}>{line}</p>
                  ))}
                  {instructions.copyableRecipient && (
                    <div className="copy-field">
                      <code>{instructions.copyableRecipient}</code>
                      <button
                        className="text-button"
                        onClick={() =>
                          void act(
                            () =>
                              navigator.clipboard.writeText(
                                instructions.copyableRecipient!,
                              ),
                            "Recipient copied.",
                          )
                        }
                      >
                        Copy
                      </button>
                    </div>
                  )}
                  <p className="callout">{instructions.safetyNotice}</p>
                  {attempt.failure && (
                    <p className="error">{attempt.failure}</p>
                  )}
                </div>
                {intent.fromId === me.user.id &&
                  attempt.status === "ready_for_external_payment" && (
                    <>
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          const f = new FormData(e.currentTarget);
                          void act(async () => {
                            let assetId: string | undefined;
                            const file = f.get("file");
                            if (file instanceof File && file.size) {
                              const upload = new FormData();
                              upload.set("groupId", groupId);
                              upload.set("purpose", "evidence");
                              upload.set("file", file);
                              assetId = (
                                await api<{ id: string }>(
                                  "/receipts/upload",
                                  upload,
                                )
                              ).id;
                            }
                            await api(
                              `/payment-attempts/${attempt.id}/claim-paid`,
                              { note: String(f.get("note") || ""), assetId },
                            );
                          }, "Claim recorded. The recipient must confirm; balances are unchanged.");
                        }}
                      >
                        <label>
                          Optional note
                          <input name="note" maxLength={500} />
                        </label>
                        <label>
                          Optional screenshot · evidence only (Gemini parses
                          when enabled)
                          <input
                            type="file"
                            name="file"
                            accept="image/png,image/jpeg,image/webp"
                          />
                        </label>
                        <label className="check">
                          <input type="checkbox" required />I independently paid
                          this exact amount to this recipient.
                        </label>
                        <button disabled={busy}>I’ve paid</button>
                      </form>
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            await api(
                              `/payment-attempts/${attempt.id}/cancel`,
                              {},
                            );
                            overlayClose();
                          })
                        }
                      >
                        Cancel untouched attempt
                      </button>
                    </>
                  )}
                {intent.toId === me.user.id &&
                  attempt.status === "sender_claimed" && (
                    <div className="recipient-confirm">
                      <h3>
                        {name(intent.fromId)} says they paid you{" "}
                        {money(intent.amountCents)}.
                      </h3>
                      <p>
                        Check your own {labels[attempt.method]} account or cash
                        received before confirming.
                      </p>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void act(
                            () =>
                              api(
                                `/payment-attempts/${attempt.id}/confirm-received`,
                                {},
                              ),
                            "Receipt confirmed. The ledger is updated once.",
                          )
                        }
                      >
                        I received this exact payment
                      </button>
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() =>
                          void act(
                            () =>
                              api(
                                `/payment-attempts/${attempt.id}/dispute`,
                                {},
                              ),
                            "Marked as disputed. No settlement credit applied.",
                          )
                        }
                      >
                        Not received
                      </button>
                    </div>
                  )}
                {intent.fromId === me.user.id &&
                  attempt.status === "awaiting_authorization" && (
                    <>
                      {!approval ? (
                        <button
                          disabled={busy}
                          onClick={() =>
                            void act(async () =>
                              setApproval(
                                await api(
                                  `/payment-attempts/${attempt.id}/approval`,
                                  {},
                                ),
                              ),
                            )
                          }
                        >
                          Review exact test payment
                        </button>
                      ) : (
                        <div className="approval">
                          <h3>
                            Authorize {money(approval.amountCents)} tUSD to{" "}
                            {name(approval.recipientId)}?
                          </h3>
                          <p>
                            Solana devnet only. This approval expires in five
                            minutes and can be used once.
                          </p>
                          <button
                            disabled={busy}
                            onClick={() =>
                              void act(async () => {
                                await api(
                                  `/payment-attempts/${attempt.id}/authorize-solana`,
                                  approval,
                                );
                                setApproval(null);
                              })
                            }
                          >
                            Authorize test payment
                          </button>
                        </div>
                      )}
                    </>
                  )}
                {attempt.status === "submitted" && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act(() =>
                        api(`/payment-attempts/${attempt.id}/reconcile`, {}),
                      )
                    }
                  >
                    Check existing transaction
                  </button>
                )}
                {attempt.explorerUrl && (
                  <a
                    className="explorer"
                    href={attempt.explorerUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View transaction on Solana Explorer · devnet ↗
                  </a>
                )}
              </>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            {busy && (
              <p role="status" className="muted">
                Working… Payment status is preserved if this takes a moment.
              </p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
function ExpenseReview({
  expense,
  people,
  busy,
  act,
}: {
  expense: Group["expenses"][number];
  people: Group["members"];
  busy: boolean;
  act: (fn: () => Promise<unknown>, message?: string) => Promise<void>;
}) {
  const [payer, setPayer] = useState(expense.payerId ?? ""),
    [editing, setEditing] = useState(false);
  return (
    <div className="expense-review">
      {!expense.payerId && (
        <label>
          Who paid?
          <select value={payer} onChange={(e) => setPayer(e.target.value)}>
            <option value="">Select payer</option>
            {people.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="share-preview">
        {expense.shares.map((s) => (
          <span key={s.userId}>
            {people.find((p) => p.id === s.userId)?.name} {money(s.cents)}
          </span>
        ))}
      </div>
      <button
        className="small-button"
        disabled={busy || !payer}
        onClick={() =>
          void act(
            () =>
              api(`/expenses/${expense.id}/confirm`, {
                payerId: payer,
                version: expense.version,
              }),
            "Expense confirmed. Balances updated.",
          )
        }
      >
        Confirm expense
      </button>
      <button
        className="text-button"
        disabled={busy}
        onClick={() => setEditing(!editing)}
      >
        Edit
      </button>
      <button
        className="text-button"
        disabled={busy}
        onClick={() =>
          void act(() => api(`/expenses/${expense.id}/reject`, {}))
        }
      >
        Reject
      </button>
      {editing && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void act(() =>
              api(`/expenses/${expense.id}/change`, {
                description: f.get("description"),
                totalCents: Number(f.get("cents")),
              }),
            );
            setEditing(false);
          }}
        >
          <label>
            Description
            <input
              name="description"
              defaultValue={expense.description}
              required
              maxLength={500}
            />
          </label>
          <label>
            Total in cents
            <input
              name="cents"
              type="number"
              min="1"
              step="1"
              defaultValue={expense.totalCents}
              required
            />
          </label>
          <button disabled={busy}>Save revised proposal</button>
        </form>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
