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

// Keep the original owner and allow explicitly configured additional owners.
// Exact addresses only: no domains, partial matches or client-supplied roles.
export function isPlatformOwnerEmail(email, env = process.env) {
  const candidate = String(email || "").trim().toLowerCase();
  if (!candidate) return false;
  const owners = [env.PLATFORM_OWNER_EMAIL, env.PLATFORM_OWNER_EMAILS]
    .filter(Boolean).flatMap(value => String(value).split(/[,;\n]/))
    .map(value => value.trim().toLowerCase()).filter(Boolean);
  return owners.includes(candidate);
}

export async function requirePlatformOwner(req) {
  const user = await verifyAuthenticatedUser(req);
  if (!isPlatformOwnerEmail(user.email))
    throw Object.assign(new Error("Platform Owner access required"), { status: 403 });
  return user;
}
