/**
 * Live Photon Spectrum check. Connects with your .env credentials, optionally
 * texts one test message to your phone, then prints every DM the bot receives
 * for 2 minutes. Doesn't touch the database or reply to anyone.
 *
 *   npm run check:photon -- +19195551234  register your number, text you a hello, print replies
 *   npm run check:photon                  listen only (number must already be registered)
 */
import { loadConfig } from "../src/config";
import { SpectrumMessenger } from "../src/messaging/spectrum";
import { registerPhotonUser } from "../src/messaging/photon-users";
import { normalizeHandle } from "../src/messaging/types";

const config = loadConfig();
if (!config.photon) {
  console.error("Set PHOTON_PROJECT_ID and PHOTON_PROJECT_SECRET in server/.env first.");
  process.exit(1);
}
const to = process.argv[2];
const messenger = new SpectrumMessenger(config.photon);

await messenger.listen(async (dm) => {
  const images = dm.images.map((i) => i.mimeType).join(", ");
  console.log(`📩 from ${dm.from}: ${dm.text ?? ""}${images ? ` [images: ${images}]` : ""}`);
  for (const img of dm.images) {
    const bytes = await img.read();
    console.log(`   downloaded ${img.mimeType} attachment: ${bytes.length} bytes ✅`);
  }
});
console.log("✅ Connected to Photon.");

if (to) {
  // Shared-line plans only text registered numbers, so register first (idempotent).
  const { assignedPhoneNumber } = await registerPhotonUser(config.photon, to);
  console.log(`✅ ${normalizeHandle(to)} is registered; its Tab line is ${assignedPhoneNumber}`);
  await messenger.send(normalizeHandle(to), "👋 Tab test: if you can read this, outbound iMessage works. Reply with anything (try a photo too).");
  console.log(`✅ Sent a test message to ${normalizeHandle(to)} (it comes from ${assignedPhoneNumber})`);
}
console.log(`Listening for 2 minutes. Reply from your iPhone (try a receipt photo too)…`);
setTimeout(() => process.exit(0), 120_000);
