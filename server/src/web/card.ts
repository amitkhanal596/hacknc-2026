import { Resvg } from "@resvg/resvg-js";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import satori from "satori";
import { formatCents as $ } from "../ledger/money";
import type { TabSummary } from "../bot/summary";

/**
 * The image iMessage shows inline when Tab sends someone their tab link (the
 * Partiful-style card). 1200x630 PNG, Frutiger Aero look. iMessage can't
 * render SVG previews, so satori lays it out and resvg rasterizes it.
 */

const require = createRequire(import.meta.url);
const fontDir = join(dirname(require.resolve("@fontsource/nunito/package.json")), "files");
const fonts = [400, 700, 800].map((weight) => ({
  name: "Nunito",
  data: readFileSync(join(fontDir, `nunito-latin-${weight}-normal.woff`)),
  weight: weight as 400 | 700 | 800,
  style: "normal" as const,
}));

type Style = Record<string, string | number>;
type Node = { type: string; props: { style?: Style; children?: Child | Child[] } };
type Child = Node | string;
const h = (type: string, style: Style, children?: Child | Child[]): Node => ({ type, props: { style, children } });

function chip(label: string, amount: string, positive: boolean): Node {
  return h(
    "div",
    {
      display: "flex",
      alignItems: "center",
      gap: 14,
      padding: "14px 22px",
      borderRadius: 999,
      background: "rgba(255,255,255,0.82)",
      border: "2px solid rgba(255,255,255,0.95)",
      boxShadow: "0 6px 16px rgba(0,70,130,0.18)",
    },
    [
      h("div", { fontSize: 28, fontWeight: 700, color: "#0b3550" }, label),
      h("div", { fontSize: 28, fontWeight: 800, color: positive ? "#2b8a1d" : "#0a6bb0" }, amount),
    ],
  );
}

export async function renderTabCard(s: TabSummary): Promise<Buffer> {
  const owed = s.net > 0;
  const even = s.net === 0;
  const big = even ? "All even" : $(Math.abs(s.net));
  const caption = even ? "Nobody owes anybody right now" : owed ? "You're owed" : "You owe";
  const counted = s.expenses.filter((e) => e.yourShare !== null).length;

  const chips = s.people
    .filter((p) => p.net !== 0)
    .slice(0, 3)
    .map((p) => chip(p.net > 0 ? `${p.name} owes you` : `You owe ${p.name}`, $(Math.abs(p.net)), p.net > 0));

  const tree = h(
    "div",
    {
      width: 1200,
      height: 630,
      display: "flex",
      position: "relative",
      fontFamily: "Nunito",
      background: "linear-gradient(180deg, #3fb4f0 0%, #8fd8fb 48%, #e4f7ff 82%, #f6fff0 100%)",
      overflow: "hidden",
    },
    [
      // sun glow
      h("div", { position: "absolute", top: -260, right: -200, width: 700, height: 700, borderRadius: 999, background: "radial-gradient(circle, rgba(255,255,255,0.95) 0%, rgba(255,255,255,0.4) 32%, rgba(255,255,255,0) 68%)" }),
      // bubbles
      h("div", { position: "absolute", top: 70, right: 120, width: 70, height: 70, borderRadius: 999, border: "2px solid rgba(255,255,255,0.8)", background: "radial-gradient(circle at 32% 28%, rgba(255,255,255,0.95) 0%, rgba(255,255,255,0.3) 25%, rgba(140,215,255,0.2) 60%, rgba(255,255,255,0.4) 100%)" }),
      h("div", { position: "absolute", top: 300, right: 60, width: 40, height: 40, borderRadius: 999, border: "2px solid rgba(255,255,255,0.8)", background: "radial-gradient(circle at 32% 28%, rgba(255,255,255,0.95) 0%, rgba(255,255,255,0.3) 25%, rgba(140,215,255,0.2) 60%, rgba(255,255,255,0.4) 100%)" }),
      // grassy hill
      h("div", { position: "absolute", left: -100, right: -100, bottom: -260, height: 360, borderRadius: "50%", background: "linear-gradient(180deg, #b6f06a 0%, #5cc53a 45%, #2f9a2a 100%)" }),
      // glass panel
      h(
        "div",
        {
          position: "absolute",
          left: 60,
          top: 44,
          width: 1080,
          height: 452,
          display: "flex",
          flexDirection: "column",
          padding: "40px 52px",
          borderRadius: 40,
          background: "linear-gradient(180deg, rgba(255,255,255,0.88) 0%, rgba(255,255,255,0.62) 100%)",
          border: "3px solid rgba(255,255,255,0.95)",
          boxShadow: "0 18px 44px rgba(0,70,130,0.25)",
        },
        [
          h("div", { display: "flex", alignItems: "center", gap: 18 }, [
            h(
              "div",
              {
                width: 76,
                height: 76,
                borderRadius: 999,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#fff",
                fontSize: 26,
                fontWeight: 800,
                background: "radial-gradient(circle at 50% 120%, #7ff0ff 0%, #6fd0ff 35%, #1590d6 75%, #0b5f99 100%)",
                boxShadow: "0 8px 20px rgba(0,80,150,0.35)",
              },
              "Tab",
            ),
            h("div", { display: "flex", flexDirection: "column" }, [
              h("div", { fontSize: 36, fontWeight: 800, color: "#0b3550" }, `${s.user.displayName ?? "Your"}'s tab`),
              h("div", { fontSize: 26, fontWeight: 700, color: "#2a8fd0" }, s.group.name),
            ]),
          ]),
          h("div", { display: "flex", flexDirection: "column", marginTop: 26 }, [
            h("div", { fontSize: 30, fontWeight: 700, color: "#3d6680" }, caption),
            h("div", { fontSize: 112, fontWeight: 800, lineHeight: 1.05, color: even ? "#0b3550" : owed ? "#2b8a1d" : "#0a6bb0" }, big),
          ]),
          h("div", { display: "flex", gap: 16, marginTop: 22, flexWrap: "wrap" }, chips.length ? chips : [chip("Expenses", String(counted), true)]),
          h(
            "div",
            { display: "flex", marginTop: "auto", fontSize: 24, fontWeight: 700, color: "#3d6680" },
            `${counted} expense${counted === 1 ? "" : "s"} · You paid ${$(s.paidCents)} · Tap to see everything`,
          ),
        ],
      ),
    ],
  );

  const svg = await satori(tree as never, { width: 1200, height: 630, fonts });
  return Buffer.from(new Resvg(svg, { fitTo: { mode: "width", value: 1200 } }).render().asPng());
}
