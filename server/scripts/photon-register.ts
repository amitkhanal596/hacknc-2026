/**
 * Registers a phone number with your Photon project (required on shared-line
 * plans before that phone can text the bot) and prints the line it should text.
 * Safe to re-run: Photon returns the same user and line.
 *
 *   npm run photon:register -- +19195551234 Amit
 */
import { loadConfig } from "../src/config";
import { registerPhotonUser } from "../src/messaging/photon-users";

const [phone, name] = process.argv.slice(2);
const config = loadConfig();
if (!config.photon) throw new Error("Set PHOTON_PROJECT_ID and PHOTON_PROJECT_SECRET in server/.env first.");
if (!phone) {
  console.error("Usage: npm run photon:register -- +19195551234 [FirstName]");
  process.exit(1);
}
const { assignedPhoneNumber } = await registerPhotonUser(config.photon, phone, name);
console.log(`✅ Registered ${phone}${name ? ` (${name})` : ""}.`);
console.log(`📱 From that iPhone, text Tab at: ${assignedPhoneNumber}`);
console.log(`   Save it as a contact named "Tab". Then try: new trip Test`);
