import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const origin = process.env.BROWSER_BASE_URL || "http://localhost:5173";
const failures: string[] = [];
try {
  const ownerContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const guestContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const owner = await ownerContext.newPage(),
    guest = await guestContext.newPage();
  for (const page of [owner, guest])
    page.on("pageerror", (e) => failures.push(e.message));
  await owner.goto(origin);
  await owner.getByRole("button", { name: "Explore as Alex" }).click();
  const name = `DM dinner ${Date.now()}`;
  await owner.getByLabel("New tab name").fill(name);
  await owner
    .getByRole("button", { name: "Create shared tab", exact: true })
    .click();
  await owner.getByRole("heading", { name: `${name}.`, exact: true }).waitFor();
  await owner.getByRole("button", { name: "Get invitation link" }).click();
  const invitation = await owner
    .locator('a[href*="/join#invite="]')
    .getAttribute("href");
  if (!invitation) throw Error("No invitation generated");
  await guest.goto(invitation);
  await guest
    .getByRole("heading", { name: "One shared tab. Your own conversation." })
    .waitFor();
  await guest.getByRole("button", { name: "Explore as Alex" }).click();
  await guest.getByLabel("Viewing as").selectOption("ben");
  await guest.getByRole("button", { name: "Accept invitation" }).click();
  await guest.getByRole("heading", { name: `${name}.`, exact: true }).waitFor();
  // STOP is deliberately persistent across tabs and earlier test runs.
  await guest
    .getByRole("button", { name: "Tab messages", exact: true })
    .click();
  await guest.getByLabel("Simulated message to Tab").fill("START");
  await guest.getByRole("button", { name: "Send ↗", exact: true }).click();
  await guest
    .getByRole("status")
    .filter({ hasText: "updates resumed" })
    .waitFor();
  await owner
    .getByText("· 2 people", { exact: true })
    .waitFor({ timeout: 15000 });
  await owner
    .getByRole("button", { name: "Tab messages", exact: true })
    .click();
  await owner
    .getByLabel("Simulated message to Tab")
    .fill("I paid $120 for groceries, split with everyone");
  await owner.getByRole("button", { name: "Send ↗", exact: true }).click();
  await owner.getByRole("status").filter({ hasText: "Proposed" }).waitFor();
  await owner.getByRole("button", { name: "Overview", exact: true }).click();
  await owner
    .getByRole("button", { name: "Confirm expense", exact: true })
    .click();
  await owner
    .getByText("Expense confirmed. Balances updated.", { exact: true })
    .waitFor();
  await guest
    .getByRole("button", { name: "Tab messages", exact: true })
    .click();
  await guest.getByText(/Your share: \$60.00/).waitFor({ timeout: 15000 });
  await guest.getByLabel("Simulated message to Tab").fill("STOP");
  await guest.getByRole("button", { name: "Send ↗", exact: true }).click();
  await guest
    .getByRole("status")
    .filter({ hasText: "updates paused" })
    .waitFor();
  mkdirSync(".data/screenshots", { recursive: true });
  await owner.screenshot({
    path: ".data/screenshots/direct-tab-desktop.png",
    fullPage: true,
  });
  await guest.screenshot({
    path: ".data/screenshots/direct-tab-mobile.png",
    fullPage: true,
  });
  if (
    await guest.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    )
  )
    throw Error("Mobile overflow");
  if (failures.length) throw Error(failures.join("\n"));
  // Restore this shared demo identity's preferences after demonstrating STOP.
  await guest.getByLabel("Simulated message to Tab").fill("START");
  await guest.getByRole("button", { name: "Send ↗", exact: true }).click();
  await guest
    .getByRole("status")
    .filter({ hasText: "updates resumed" })
    .waitFor();
  console.log(
    "PASS: organizer creates tab, shareable invite opens on mobile, separate guest accepts, two-person expense confirmed, private $60 share appears, STOP works. Local simulation; no iMessages sent.",
  );
} finally {
  await browser.close();
}
