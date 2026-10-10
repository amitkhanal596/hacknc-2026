import { chromium } from "playwright-core";
import { existsSync, mkdirSync } from "node:fs";
const executablePath =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!existsSync(executablePath))
  throw new Error(
    "Set CHROME_PATH to your installed Chromium/Chrome executable. No browser download is automatic.",
  );
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
mkdirSync(".data/screenshots", { recursive: true });
try {
  await page.goto(process.env.BROWSER_BASE_URL || "http://localhost:5173");
  await page.getByRole("button", { name: "Explore as Alex" }).click();
  await page.getByLabel("Select trip").selectOption("tahoe");
  await page.getByRole("heading", { name: "Tahoe weekend." }).waitFor();
  await page.getByRole("button", { name: "Tab messages", exact: true }).click();
  await page.getByRole("button", { name: "Start fresh scenario" }).click();
  await page
    .getByText("Fresh scenario created. Previous trip history is preserved.")
    .waitFor();
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page
    .getByRole("button", { name: "Try the $120 grocery example" })
    .click();
  await page
    .getByRole("button", { name: "Confirm expense", exact: true })
    .click();
  await page
    .getByText("Expense confirmed. Balances updated.", { exact: true })
    .waitFor();
  await page.screenshot({
    path: ".data/screenshots/overview-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: /^Settle up/ }).click();
  await page.getByRole("button", { name: "Calculate settlements" }).click();
  await page.getByText("Settlement plan is ready.", { exact: true }).waitFor();
  await page.getByLabel("Viewing as").selectOption("ben");
  await page.getByRole("button", { name: "Cash →", exact: true }).click();
  await page.getByRole("heading", { name: "$30.00 to Alex." }).waitFor();
  await page
    .getByLabel("I independently paid this exact amount to this recipient.")
    .check();
  await page.getByRole("button", { name: "I’ve paid", exact: true }).click();
  await page
    .getByText(
      "Claim recorded. The recipient must confirm; balances are unchanged.",
      { exact: true },
    )
    .first()
    .waitFor();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByLabel("Viewing as").selectOption("alex");
  await page.getByRole("button", { name: "View confirmation request" }).click();
  await page
    .getByRole("button", { name: "I received this exact payment" })
    .click();
  await page
    .getByText("Receipt confirmed. The ledger is updated once.", {
      exact: true,
    })
    .first()
    .waitFor();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: ".data/screenshots/overview-mobile.png",
    fullPage: true,
  });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  if (overflow) throw new Error("Mobile page overflows horizontally.");
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    "PASS: desktop and 390px mobile UI; new scenario, expense confirmation, payer claim, separate recipient confirmation; no browser errors or horizontal overflow.",
  );
  console.log("Screenshots saved to .data/screenshots/.");
} finally {
  await browser.close();
}
