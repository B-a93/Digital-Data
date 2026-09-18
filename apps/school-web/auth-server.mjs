import { createRemoteJWKSet, jwtVerify } from "jose";

const authUrl =
  "https://ep-spring-poetry-b2x3am6k.neonauth.c-6.eu-central-1.aws.neon.tech/neondb/auth";
const jwks = createRemoteJWKSet(
  new URL(authUrl + "/.well-known/jwks.json"),
);

export async function verifyAuthenticatedUser(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer "))
    throw Object.assign(new Error("Authentication required"), { status: 401 });
  const token = header.slice(7);
  const { payload } = await jwtVerify(token, jwks);
  const email = String(payload.email || "").toLowerCase();
  return { id: String(payload.sub || ""), email };
}

export async function requirePlatformOwner(req) {
  const user = await verifyAuthenticatedUser(req);
  const owner = String(process.env.PLATFORM_OWNER_EMAIL || "")
    .trim()
    .toLowerCase();
  if (!owner || user.email !== owner)
    throw Object.assign(new Error("Platform Owner access required"), {
      status: 403,
    });
  return user;
}
