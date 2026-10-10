import type { Config } from "../config";
import { normalizeHandle } from "./types";

/**
 * Photon's free/pro plans send through a shared pool of iMessage lines, and a
 * shared line only talks to phone numbers registered as users of the project.
 * Registering is idempotent: re-registering returns the same user and line.
 * Each person gets their own assigned line (the number they text), which can
 * differ between people. Docs: https://photon.codes/docs/api-reference/users/create-user
 */
const SPECTRUM_API = process.env.SPECTRUM_CLOUD_URL ?? "https://spectrum.photon.codes";

export class PhotonRegistrationError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function registerPhotonUser(
  photon: NonNullable<Config["photon"]>,
  phone: string,
  firstName?: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<{ assignedPhoneNumber: string }> {
  const phoneNumber = normalizeHandle(phone);
  if (!/^\+[1-9]\d{6,14}$/.test(phoneNumber)) throw new PhotonRegistrationError("That doesn't look like a phone number.", 422);
  const res = await fetchImpl(`${SPECTRUM_API}/projects/${photon.projectId}/users/`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${photon.projectId}:${photon.projectSecret}`).toString("base64")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ type: "shared", phoneNumber, ...(firstName ? { firstName } : {}) }),
  });
  const body = (await res.json().catch(() => ({}))) as { succeed?: boolean; data?: { assignedPhoneNumber?: string }; message?: string };
  if (!res.ok || !body.data?.assignedPhoneNumber) {
    const reason =
      res.status === 409 ? "The Photon project is full (free plans cap shared users)." : body.message ?? `Photon returned ${res.status}`;
    throw new PhotonRegistrationError(reason, res.status);
  }
  return { assignedPhoneNumber: body.data.assignedPhoneNumber };
}
