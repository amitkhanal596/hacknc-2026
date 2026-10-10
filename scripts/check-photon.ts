import { cloud, SpectrumCloudError } from "spectrum-ts";
import { readConfig } from "../server/src/config";

// Authenticate with the official SDK without sending messages or printing tokens.
const config = readConfig();
if (!config.PHOTON_PROJECT_ID || !config.PHOTON_PROJECT_SECRET) {
  console.error("Set PHOTON_PROJECT_ID and PHOTON_PROJECT_SECRET in .env.");
  process.exit(1);
}
const timeout = setTimeout(() => {
  console.error("Photon authentication check timed out after 20 seconds.");
  process.exit(1);
}, 20_000);
try {
  await cloud.getProject(
    config.PHOTON_PROJECT_ID,
    config.PHOTON_PROJECT_SECRET,
  );
  console.log("Photon project authentication: accepted.");
  const token = await cloud.issueImessageTokens(
    config.PHOTON_PROJECT_ID,
    config.PHOTON_PROJECT_SECRET,
  );
  console.log(`iMessage token: issued (${token.type} account).`);
  if (token.type === "dedicated" && Object.keys(token.auth).length === 0) {
    console.error(
      "No dedicated iMessage lines provisioned. Configure a line in Photon.",
    );
    process.exitCode = 1;
  }
  console.log(
    "No messages sent. Start bun run dev, then privately send ping to test delivery.",
  );
} catch (error) {
  // Provider error bodies may contain credentials or private account data.
  console.error(
    error instanceof SpectrumCloudError
      ? `Photon authentication failed (HTTP ${error.status}). Check credentials and iMessage provisioning.`
      : "Photon authentication failed. Check network access and Photon availability.",
  );
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
}
